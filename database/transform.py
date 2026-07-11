"""
資料清洗與標準化模組

職責範圍：
  1. 將 Crawler 輸出的中文欄位 DataFrame 轉換為全小寫英文欄位
  2. 對數值欄位進行型別轉換（去逗號、強制 numeric、coerce 錯誤）
  3. 不做任何業務邏輯判斷（如計算指標、篩選股票）

依賴：config.schema (COLUMN_MAP, apply_column_mapping)
禁止：硬編碼中文欄位名稱（"日期" 除外，因為這是 crawler 層共用的欄位）
"""

import pandas as pd
import logging

from quant_system_v2.config.schema import apply_column_mapping

logger = logging.getLogger(__name__)

# 字串/時間類欄位，不應進行數值轉換
_NON_NUMERIC_COLUMNS = {"stock_id", "stock_name", "date", "證券代號", "證券名稱", "日期"}


def clean_numeric_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    將 DataFrame 中的數值欄位進行標準化清洗。

    處理方式：
      1. 排除字串/時間欄位（stock_id, stock_name, date）
      2. 對其餘欄位：.astype(str) → 移除逗號 → pd.to_numeric(errors='coerce')
      3. '--'、'X' 等無效字元會被 coerce 為 NaN

    Args:
        df: 輸入 DataFrame（可能含中文或英文欄位名稱）

    Returns:
        數值欄位已轉為 float64 的 DataFrame（其餘欄位保持不變）
    """
    df = df.copy()

    for col in df.columns:
        # 跳過非數值欄位
        if col in _NON_NUMERIC_COLUMNS:
            continue

        # 嘗試轉換為數值
        try:
            df[col] = (
                df[col]
                .astype(str)
                .str.replace(",", "", regex=False)
                .pipe(pd.to_numeric, errors="coerce")
            )
        except Exception as e:
            logger.warning(f"[clean_numeric] 欄位 '{col}' 轉換失敗: {e}")
            continue

    return df


def standardize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    將原始爬蟲回傳的 DataFrame 標準化為系統內部格式。

    執行流程：
      1. apply_column_mapping() — 中文字段 → 英文字段（"日期" → "date"）
      2. clean_numeric_columns() — 數值欄位清洗
      3. 缺失值處理（策略說明見下方）

    缺失值處理策略：
      - stock_name: 填補空字串（避免後續 concat 產生 NaN）
      - 數值欄位: 保留 NaN（讓上層運算邏輯自行決定填補策略）
      - 若 date 為 NaT: 保留，讓上層 filter 處理

    Args:
        df: 來自 crawler 的原始 DataFrame（中文欄位）

    Returns:
        標準化後的 DataFrame（英文欄位、數值已清洗）
    """
    if df is None or df.empty:
        logger.warning("[standardize] 收到空的 DataFrame，直接回傳")
        return df

    # Step 1: 中欄位 → 英欄位
    df = apply_column_mapping(df)
    logger.debug(f"[standardize] 欄位對映後: {list(df.columns)}")

    # Step 2: 數值欄位清洗（去逗號、型別轉換）
    df = clean_numeric_columns(df)

    # Step 3: 缺失值處理
    if "stock_name" in df.columns:
        df["stock_name"] = df["stock_name"].fillna("")

    # date 欄位確保為 datetime 類型
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")

    logger.info(f"[standardize] 完成: {len(df)} 列, {len(df.columns)} 欄")
    return df