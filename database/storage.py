"""
Parquet 檔案 IO 模組

職責範圍：
  1. 將 DataFrame 寫入 Parquet 格式（Hive 風格的目錄結構）
  2. 從 Parquet 讀取資料（單日或近期多日）

目錄結構：
    {DATA_DIR}/parquet/{table_name}/{date_str}.parquet

依賴：config.settings.DATA_DIR
禁止：任何資料清洗或業務邏輯
"""

import os
import glob
import logging
from typing import Optional

import pandas as pd

from quant_system_v2.config.settings import DATA_DIR

logger = logging.getLogger(__name__)


def _resolve_project_root() -> str:
    """
    解析專案根目錄路徑。
    以 storage.py 所在位置往上兩層（database/ → quant_system_v2/）為基準。
    """
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _get_table_dir(table_name: str) -> str:
    """回傳指定 table 的 Parquet 儲存目錄絕對路徑"""
    project_root = _resolve_project_root()
    return os.path.join(project_root, DATA_DIR, "parquet", table_name)


def save_dataframe(df: pd.DataFrame, table_name: str, date_str: str) -> str:
    """
    將 DataFrame 儲存為 Parquet 檔案。

    Args:
        df: 要儲存的 DataFrame
        table_name: 資料表名稱（如 'daily_price', 'daily_chip'）
        date_str: 日期字串（YYYYMMDD 或 YYYY-MM-DD）

    Returns:
        儲存檔案的絕對路徑

    Raises:
        ValueError: 若 df 為空
        OSError: 目錄建立或檔案寫入失敗
    """
    if df is None or df.empty:
        raise ValueError(f"[storage] 無法儲存空的 DataFrame: {table_name}/{date_str}")

    # 正規化日期（移除連字號）
    d = date_str.replace("-", "")
    table_dir = _get_table_dir(table_name)
    os.makedirs(table_dir, exist_ok=True)

    file_path = os.path.join(table_dir, f"{d}.parquet")
    df.to_parquet(file_path, engine="pyarrow", index=False)

    logger.info(f"[storage] ✅ 已儲存: {file_path} ({len(df)} 列)")
    return file_path


def load_dataframe(table_name: str, date_str: str) -> pd.DataFrame:
    """
    讀取指定日期的 Parquet 檔案。

    Args:
        table_name: 資料表名稱
        date_str: 日期字串（YYYYMMDD 或 YYYY-MM-DD）

    Returns:
        DataFrame（若檔案不存在則回傳空的 DataFrame）
    """
    d = date_str.replace("-", "")
    table_dir = _get_table_dir(table_name)
    file_path = os.path.join(table_dir, f"{d}.parquet")

    if not os.path.exists(file_path):
        logger.warning(f"[storage] 檔案不存在: {file_path}")
        return pd.DataFrame()

    try:
        df = pd.read_parquet(file_path, engine="pyarrow")
        logger.info(f"[storage] 已讀取: {file_path} ({len(df)} 列)")
        return df
    except Exception as e:
        logger.error(f"[storage] 讀取失敗: {file_path} - {e}")
        return pd.DataFrame()


def load_recent_dataframes(table_name: str, days: int) -> pd.DataFrame:
    """
    讀取指定 table 目錄下最新的 N 個 Parquet 檔案並合併。

    按檔名（日期字串）排序，取最新的 days 個檔案。
    這對計算連買天數、移動平均等歷史邏輯非常有用。

    Args:
        table_name: 資料表名稱
        days: 要讀取的最新交易日數

    Returns:
        合併後的 DataFrame（若無任何資料則回傳空的 DataFrame）
    """
    table_dir = _get_table_dir(table_name)

    if not os.path.isdir(table_dir):
        logger.warning(f"[storage] 目錄不存在: {table_dir}")
        return pd.DataFrame()

    # 列出所有 .parquet 檔案，按檔名排序（YYYYMMDD.parquet）
    parquet_files = sorted(glob.glob(os.path.join(table_dir, "*.parquet")))

    if not parquet_files:
        logger.warning(f"[storage] 目錄中無 Parquet 檔案: {table_dir}")
        return pd.DataFrame()

    # 取最新的 days 個
    selected_files = parquet_files[-days:]

    dfs = []
    for fpath in selected_files:
        try:
            df = pd.read_parquet(fpath, engine="pyarrow")
            if not df.empty:
                dfs.append(df)
        except Exception as e:
            logger.warning(f"[storage] 略過損壞檔案: {fpath} - {e}")
            continue

    if not dfs:
        logger.warning(f"[storage] 所有檔案皆讀取失敗: {table_name}")
        return pd.DataFrame()

    combined = pd.concat(dfs, ignore_index=True)
    logger.info(f"[storage] 已合併 {len(selected_files)} 個檔案: {table_name} ({len(combined)} 列)")
    return combined


def load_dataframes_up_to(table_name: str, date_str: str, max_files: int) -> pd.DataFrame:
    """
    讀取指定 table 目錄中日期 <= date_str 的最新 max_files 個 Parquet 檔案並合併。

    這對回溯（Backfill）情境非常重要：計算截至「目標日期」的歷史資料，
    避免看到「未來」的資料。

    Args:
        table_name: 資料表名稱
        date_str: 日期字串（YYYYMMDD），僅載入 <= 此日期的檔案
        max_files: 最多載入幾個檔案

    Returns:
        合併後的 DataFrame（若無任何資料則回傳空的 DataFrame）
    """
    d = date_str.replace("-", "")
    table_dir = _get_table_dir(table_name)

    if not os.path.isdir(table_dir):
        logger.warning(f"[storage] 目錄不存在: {table_dir}")
        return pd.DataFrame()

    # 列出所有 .parquet 檔案，按檔名排序（YYYYMMDD.parquet）
    all_files = sorted(glob.glob(os.path.join(table_dir, "*.parquet")))

    if not all_files:
        logger.warning(f"[storage] 目錄中無 Parquet 檔案: {table_dir}")
        return pd.DataFrame()

    # 篩選出檔名（不含副檔名）<= date_str 的檔案
    def _stem(path: str) -> str:
        return os.path.splitext(os.path.basename(path))[0]

    filtered = [f for f in all_files if _stem(f) <= d]

    if not filtered:
        logger.warning(f"[storage] 無 <= {d} 的檔案: {table_name}")
        return pd.DataFrame()

    # 取最近 max_files 個
    selected_files = filtered[-max_files:]

    dfs = []
    for fpath in selected_files:
        try:
            df = pd.read_parquet(fpath, engine="pyarrow")
            if not df.empty:
                dfs.append(df)
        except Exception as e:
            logger.warning(f"[storage] 略過損壞檔案: {fpath} - {e}")
            continue

    if not dfs:
        logger.warning(f"[storage] 所有檔案皆讀取失敗: {table_name}")
        return pd.DataFrame()

    combined = pd.concat(dfs, ignore_index=True)
    logger.info(f"[storage] 已合併 {len(selected_files)} 個檔案 (<= {d}): {table_name} ({len(combined)} 列)")
    return combined
