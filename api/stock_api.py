"""
個股歷史 JSON 導出模組 — 批次建立與每日增量更新

資料保留策略：
  - price:  490 筆（由舊到新，ascending）
  - margin:  30 筆
  - chip:    30 筆
  - tdcc:     6 筆

前端 K 線圖慣例：資料由舊到新（ascending by date）。

JSON 儲存位置：
  docs/api/stock/
    index.json        → 所有活躍股票清單
    2330.json         → 個股資料（一檔一包）
    2317.json
    ...

每個 stock JSON 的 schema：
{
  "stock_id": "2330",
  "stock_name": "台積電",
  "updated_at": "2026-07-14T15:30:00",

  "price": [
    { "date": "2025-08-01", "open": 950, "high": 960, "low": 948,
      "close": 955, "volume": 35000000,
      "ma5": 940, "ma10": 935, "ma20": 920,
      "ma60": 900, "ma120": 880, "ma240": 850 }
  ],

  "margin": [
    { "date": "2026-06-15", "fin_balance": 8500, "mar_balance": 320 }
  ],

  "institutional": [
    { "date": "2026-06-15",
      "foreign_buy_sell": 150000, "trust_buy_sell": -2000,
      "prop_buy_sell": 5000, "total_inst_buy_sell": 153000 }
  ],

  "tdcc": [
    { "date": "20260710",
      "levels": [
        { "level": "1-10張", "ratio": 12.5 },
        { "level": "1000張以上", "ratio": 53.0 }
      ]
    }
  ]
}
"""

import json
import logging
import math
import os
from datetime import datetime
from typing import Optional

import pandas as pd

from quant_system_v2.config.settings import DATA_DIR
from quant_system_v2.database.storage import load_dataframe, _get_table_dir
from quant_system_v2.utils.filters import (
    SecurityCategory,
    filter_by_type,
)

logger = logging.getLogger(__name__)

# ==========================================
# 設定
# ==========================================

PRICE_MAX_RECORDS = 490      # 價量保留筆數
MARGIN_MAX_RECORDS = 30      # 融資券保留筆數
CHIP_MAX_RECORDS = 30        # 法人籌碼保留筆數
TDCC_MAX_RECORDS = 6         # 集保保留期數

MA_WINDOWS = [5, 10, 20, 60, 120, 240]
MA_COLUMNS = {w: f"ma{w}" for w in MA_WINDOWS}

# 非現貨商品（與 export_json.py 一致）
_EXCLUDED_NON_EQUITY = [
    SecurityCategory.ETF,
    SecurityCategory.WARRANT,
    SecurityCategory.REIT,
    SecurityCategory.ETN,
]

# TDCC 大戶門檻（>= 1000 張為大戶）
TDCC_LARGE_THRESHOLD = "1000張以上"

# 持股分級層級（用於前端金字塔圖，由低持股到高持股）
TDCC_LEVEL_ORDER = [
    "1-10張", "11-50張", "51-100張", "101-200張",
    "201-400張", "401-600張", "601-800張", "801-1000張",
    "1001-2000張", "2001張以上",
]

# ==========================================
# 路徑解析
# ==========================================


def _resolve_project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _get_stock_dir() -> str:
    """docs/api/stock/"""
    return os.path.join(_resolve_project_root(), "docs", "api", "stock")


def _get_stock_path(stock_id: str) -> str:
    return os.path.join(_get_stock_dir(), f"{stock_id}.json")


def _get_index_path() -> str:
    return os.path.join(_get_stock_dir(), "index.json")


# ==========================================
# MA 計算
# ==========================================


def _calc_mas(series: pd.Series, window: int) -> pd.Series:
    """計算移動平均，前 window-1 筆為 NaN"""
    return series.rolling(window=window, min_periods=window).mean()


def _compute_price_with_mas(price_df: pd.DataFrame) -> pd.DataFrame:
    """
    對 price DataFrame（已排序 ascending by date）計算各期 MA。
    輸入須包含欄位：date, open, high, low, close, volume
    回傳附加 ma5~ma240 的 DataFrame（由舊到新）。
    """
    df = price_df.copy().sort_values("date")
    close = df["close"].astype(float)

    for w in MA_WINDOWS:
        col = MA_COLUMNS[w]
        df[col] = _calc_mas(close, w)

    # MA 前段 NaN 保留給前端自行判斷是否顯示
    return df


# ==========================================
# 價格資料序列化
# ==========================================


def _price_to_records(df: pd.DataFrame) -> list[dict]:
    """將價格 DataFrame 轉為 JSON records（由舊到新）"""
    records = []
    for _, row in df.iterrows():
        r = {
            "date": str(row["date"].strftime("%Y-%m-%d")),
            "open": _safe_float(row.get("open_price")),
            "high": _safe_float(row.get("high_price")),
            "low": _safe_float(row.get("low_price")),
            "close": _safe_float(row.get("close_price")),
            "volume": _safe_float(row.get("volume")),
        }
        for w in MA_WINDOWS:
            col = MA_COLUMNS[w]
            r[col] = _safe_float(row.get(col))
        records.append(r)
    return records


def _margin_to_records(df: pd.DataFrame) -> list[dict]:
    """將融資券 DataFrame 轉為 JSON records（由舊到新）"""
    records = []
    for _, row in df.iterrows():
        records.append({
            "date": str(row["date"].strftime("%Y-%m-%d")),
            "fin_balance": _safe_float(row.get("fin_balance")),
            "mar_balance": _safe_float(row.get("mar_balance")),
        })
    return records


def _chip_to_records(df: pd.DataFrame) -> list[dict]:
    """將法人籌碼 DataFrame 轉為 JSON records（由舊到新）"""
    records = []
    for _, row in df.iterrows():
        records.append({
            "date": str(row["date"].strftime("%Y-%m-%d")),
            "foreign_buy_sell": _safe_float(row.get("foreign_buy_sell")),
            "trust_buy_sell": _safe_float(row.get("trust_buy_sell")),
            "prop_buy_sell": _safe_float(row.get("prop_buy_sell")),
            "total_inst_buy_sell": _safe_float(row.get("total_inst_buy_sell")),
        })
    return records


def _tdcc_to_records(df: pd.DataFrame) -> list[dict]:
    """
    將集保 DataFrame 轉為 JSON records（由舊到新）。

    每個 record 包含 date 與 levels（持股分級金字塔陣列）。
    """
    if df.empty or "日期" not in df.columns:
        return []

    # 以日期分組
    grouped = df.groupby("日期")
    records = []

    for date_str, group in grouped:
        levels = []
        # 建立 level → ratio 對照
        level_map = {}
        for _, row in group.iterrows():
            level = str(row.get("持股分級", "")).strip()
            ratio = _safe_float(row.get("占集保庫存數比例%"))
            if level and ratio is not None:
                level_map[level] = ratio

        # 按 TDCC_LEVEL_ORDER 順序輸出
        for level in TDCC_LEVEL_ORDER:
            if level in level_map:
                levels.append({
                    "level": level,
                    "ratio": level_map[level],
                })
            else:
                levels.append({
                    "level": level,
                    "ratio": 0.0,
                })

        records.append({
            "date": str(date_str).replace("-", ""),
            "levels": levels,
        })

    return records


# ==========================================
# 工具函數
# ==========================================


def _safe_float(val) -> Optional[float]:
    """將值轉為 float，若無效則回傳 None"""
    if val is None:
        return None
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return round(val, 2)
    try:
        v = float(val)
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 2)
    except (ValueError, TypeError):
        return None


def _load_stock_json(stock_id: str) -> Optional[dict]:
    """讀取既有的個股 JSON"""
    path = _get_stock_path(stock_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"  讀取 {stock_id}.json 失敗: {e}")
        return None


def _save_stock_json(stock_id: str, data: dict) -> bool:
    """寫入個股 JSON"""
    path = _get_stock_path(stock_id)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f"  寫入 {stock_id}.json 失敗: {e}")
        return False


def _save_index(index_data: list[dict]) -> None:
    """寫入 index.json（所有活躍股票清單）"""
    path = _get_index_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(index_data, f, ensure_ascii=False, indent=2)
        logger.info(f"  ✅ index.json 已更新 ({len(index_data)} 檔股票)")
    except Exception as e:
        logger.error(f"  ❌ index.json 寫入失敗: {e}")


# ==========================================
# 核心：批次產生所有個股 JSON
# ==========================================


def _build_index_from_parquet(stock_ids: set[str]) -> list[dict]:
    """
    從最新的 daily_price Parquet 建立股票清單。
    回傳 list[{"stock_id": ..., "stock_name": ...}]
    """
    # 取得最新的 daily_price 檔案
    table_dir = _get_table_dir("daily_price")
    if not os.path.isdir(table_dir):
        return []

    parquet_files = sorted(
        [f for f in os.listdir(table_dir) if f.endswith(".parquet")]
    )
    if not parquet_files:
        return []

    # 從最新檔案讀取名稱對照
    latest_file = os.path.join(table_dir, parquet_files[-1])
    try:
        df = pd.read_parquet(latest_file, engine="pyarrow")
        df = df[df["stock_id"].isin(stock_ids)]
        if "stock_name" in df.columns:
            names = dict(zip(df["stock_id"], df["stock_name"]))
            result = [
                {"stock_id": sid, "stock_name": names.get(sid, "")}
                for sid in sorted(stock_ids)
            ]
            return result
    except Exception as e:
        logger.warning(f"  從 {latest_file} 建立 index 失敗: {e}")

    return [{"stock_id": sid, "stock_name": ""} for sid in sorted(stock_ids)]


def _load_price_history_all(table_dir: str, max_files: int) -> pd.DataFrame:
    """
    讀取 daily_price 目錄下最新的 max_files 個 Parquet 並合併。

    用於批次產生時一次載入所有股票的歷史價量。
    """
    if not os.path.isdir(table_dir):
        return pd.DataFrame()

    parquet_files = sorted(
        [f for f in os.listdir(table_dir) if f.endswith(".parquet")]
    )
    selected = parquet_files[-max_files:]

    dfs = []
    for fname in selected:
        fpath = os.path.join(table_dir, fname)
        try:
            df = pd.read_parquet(fpath, engine="pyarrow")
            if not df.empty:
                dfs.append(df)
        except Exception as e:
            logger.warning(f"  略過 {fname}: {e}")
            continue

    if not dfs:
        return pd.DataFrame()

    combined = pd.concat(dfs, ignore_index=True)
    logger.info(f"  已載入 {len(selected)} 個價量檔案 ({len(combined)} 列)")
    return combined


def _load_margin_history_all(table_dir, max_files):
    """讀取 daily_margin 目錄下最新的 max_files 個 Parquet 並合併"""
    return _load_recent_all(table_dir, max_files, "融資券")


def _load_chip_history_all(table_dir, max_files):
    """讀取 daily_chip 目錄下最新的 max_files 個 Parquet 並合併"""
    return _load_recent_all(table_dir, max_files, "法人籌碼")


def _load_recent_all(table_dir: str, max_files: int, label: str) -> pd.DataFrame:
    """通用：讀取目錄下最新的 max_files 個 Parquet 並合併"""
    if not os.path.isdir(table_dir):
        return pd.DataFrame()

    parquet_files = sorted(
        [f for f in os.listdir(table_dir) if f.endswith(".parquet")]
    )
    selected = parquet_files[-max_files:]

    dfs = []
    for fname in selected:
        fpath = os.path.join(table_dir, fname)
        try:
            df = pd.read_parquet(fpath, engine="pyarrow")
            if not df.empty:
                dfs.append(df)
        except Exception as e:
            logger.warning(f"  略過 {fname}: {e}")
            continue

    if not dfs:
        return pd.DataFrame()

    combined = pd.concat(dfs, ignore_index=True)
    logger.info(f"  已載入 {len(selected)} 個{label}檔案 ({len(combined)} 列)")
    return combined


def _load_tdcc_history_all(table_dir: str, max_files: int) -> pd.DataFrame:
    """讀取 weekly_tdcc 目錄下最新的 max_files 個 Parquet 並合併"""
    return _load_recent_all(table_dir, max_files, "集保")


def generate_all() -> int:
    """
    批次產生所有個股的歷史 JSON（首次執行用）。

    Returns:
        int: 成功產出的股票數
    """
    from quant_system_v2.database.storage import _get_table_dir

    project_root = _resolve_project_root()
    data_dir = os.path.join(project_root, DATA_DIR, "parquet")

    logger.info("=" * 50)
    logger.info("  批次產生個股歷史 JSON")
    logger.info("=" * 50)
    logger.info("")

    # 1. 載入所有價量歷史（490 日）
    price_dir = os.path.join(data_dir, "daily_price")
    logger.info("[載入] 價量歷史 (490 日)...")
    df_price_all = _load_price_history_all(price_dir, PRICE_MAX_RECORDS)
    if df_price_all.empty:
        logger.error("❌ 無價量資料，無法產生個股 JSON")
        return 0

    # 2. 載入融資券歷史（30 日）
    margin_dir = os.path.join(data_dir, "daily_margin")
    logger.info("[載入] 融資券歷史 (30 日)...")
    df_margin_all = _load_margin_history_all(margin_dir, MARGIN_MAX_RECORDS)

    # 3. 載入法人籌碼歷史（30 日）
    chip_dir = os.path.join(data_dir, "daily_chip")
    logger.info("[載入] 法人籌碼歷史 (30 日)...")
    df_chip_all = _load_chip_history_all(chip_dir, CHIP_MAX_RECORDS)

    # 4. 載入集保歷史（6 期）
    tdcc_dir = os.path.join(data_dir, "weekly_tdcc")
    logger.info("[載入] 集保歷史 (6 期)...")
    df_tdcc_all = _load_tdcc_history_all(tdcc_dir, TDCC_MAX_RECORDS)

    # 5. 取得所有股票 ID
    stock_ids = set(df_price_all["stock_id"].unique())
    logger.info(f"  股票總數: {len(stock_ids)}")

    # 6. 建立 index
    index_data = _build_index_from_parquet(stock_ids)
    stock_name_map = {item["stock_id"]: item["stock_name"] for item in index_data}

    # 7. 逐檔股票產生 JSON
    success_count = 0
    total = len(stock_ids)

    for i, stock_id in enumerate(sorted(stock_ids)):
        stock_name = stock_name_map.get(stock_id, "")

        if (i + 1) % 100 == 0:
            logger.info(f"  進度: {i + 1}/{total} ({success_count} 成功)")

        # 7a. 價格 + MA
        df_stock_price = df_price_all[df_price_all["stock_id"] == stock_id].copy()
        if df_stock_price.empty:
            continue

        df_price_with_ma = _compute_price_with_mas(df_stock_price)
        price_records = _price_to_records(df_price_with_ma)

        # 7b. 融資券
        margin_records = []
        if not df_margin_all.empty:
            df_stock_margin = df_margin_all[df_margin_all["stock_id"] == stock_id].copy()
            if not df_stock_margin.empty:
                df_stock_margin = df_stock_margin.sort_values("date")
                margin_records = _margin_to_records(df_stock_margin)

        # 7c. 法人籌碼
        chip_records = []
        if not df_chip_all.empty:
            df_stock_chip = df_chip_all[df_chip_all["stock_id"] == stock_id].copy()
            if not df_stock_chip.empty:
                df_stock_chip = df_stock_chip.sort_values("date")
                chip_records = _chip_to_records(df_stock_chip)

        # 7d. 集保
        tdcc_records = []
        if not df_tdcc_all.empty and "證券代號" in df_tdcc_all.columns:
            df_stock_tdcc = df_tdcc_all[df_tdcc_all["證券代號"] == stock_id].copy()
            if not df_stock_tdcc.empty:
                df_stock_tdcc = df_stock_tdcc.sort_values("日期")
                tdcc_records = _tdcc_to_records(df_stock_tdcc)

        # 7e. 組裝 JSON
        now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        stock_data = {
            "stock_id": stock_id,
            "stock_name": stock_name,
            "updated_at": now_str,
            "price": price_records,
            "margin": margin_records,
            "institutional": chip_records,
            "tdcc": tdcc_records,
        }

        ok = _save_stock_json(stock_id, stock_data)
        if ok:
            success_count += 1

    # 8. 寫入 index.json
    _save_index(index_data)

    logger.info("")
    logger.info(f"✅ 批次產生完成: {success_count}/{total} 檔股票")
    return success_count


# ==========================================
# 核心：每日增量更新
# ==========================================


def _append_array(existing: list, new_records: list, max_len: int) -> list:
    """
    將新記錄追加到現有陣列末端（兩者皆為 ascending by date），
    並截斷至 max_len 筆（從前端刪除最舊的）。

    為避免重複，new_records 中若已有相同 date 則跳過。
    """
    if not new_records:
        return existing

    # 建立既有日期的 set
    existing_dates = {r.get("date") for r in existing if "date" in r}

    # 過濾 new_records 中尚未出現的
    to_append = [r for r in new_records if r.get("date") not in existing_dates]

    if not to_append:
        return existing

    combined = existing + to_append

    # 依 date 排序
    combined.sort(key=lambda r: r.get("date", ""))

    # 截斷：保留最末 max_len 筆
    if len(combined) > max_len:
        combined = combined[-max_len:]

    return combined


_MAX_WINDOW_BEFORE = max(MA_WINDOWS) - 1  # 239
"""最大 MA window (240) 需要的前置筆數，用於增量更新時只取最後這些 close 計算新資料的 MA。"""


def _compute_ma_last_point(closes: list) -> dict:
    """
    對 closes 陣列的最後一筆計算 ma5~ma240。

    例如 closes 長度為 240：
      ma5  = mean(closes[-5:])
      ma10 = mean(closes[-10:])
      ...
      ma240 = mean(closes)  (全部 240 筆)

    Args:
        closes: 包含前置資料 + 新資料的 close 值陣列（由舊到新）

    Returns:
        dict: { "ma5": ..., "ma10": ..., ..., "ma240": ... }
              若長度不足 window，該 ma 設為 None
    """
    mas = {}
    total = len(closes)
    for w in MA_WINDOWS:
        key = MA_COLUMNS[w]
        if total >= w:
            # 取最後 w 筆的平均
            values = [v for v in closes[-w:] if v is not None]
            if len(values) >= w:
                mas[key] = round(sum(values) / w, 2)
            else:
                mas[key] = None
        else:
            mas[key] = None
    return mas


def _update_price_incremental(
    existing_records: list[dict],
    new_df: pd.DataFrame,
    stock_id: str,
    max_len: int,
) -> list[dict]:
    """
    增量更新價格資料（低成本版本）。

    策略：
      1. 將新資料（當日）轉為 record
      2. 若已存在相同 date，跳過
      3. 從既有 records 最後取出 239 筆 close +
         新資料的 close → 對最後一筆計算 ma5~ma240
      4. 將新 record append 到陣列末端，截斷至 max_len 筆

    關鍵：不重建既有 records 的 MA，MA 是歷史事實，不會因新資料而改變。
    """
    if new_df.empty:
        return existing_records

    # 取得當日資料（取最後一筆，當日可能只有一筆）
    latest_row = new_df.iloc[-1]
    new_date = str(latest_row["date"].strftime("%Y-%m-%d"))

    # 檢查是否已存在
    existing_dates = {r.get("date") for r in existing_records if "date" in r}
    if new_date in existing_dates:
        return existing_records

    # 從既有 records 取出最後 239 筆的 close（ascending，最末即最新）
    trailing_closes = [
        r["close"] for r in existing_records[-_MAX_WINDOW_BEFORE:]
        if r.get("close") is not None
    ]

    # 加入新 close
    new_close = _safe_float(latest_row.get("close_price"))
    if new_close is not None:
        trailing_closes.append(new_close)

    # 計算新資料的 MA
    mas = _compute_ma_last_point(trailing_closes)

    # 建立新 record
    new_record = {
        "date": new_date,
        "open": _safe_float(latest_row.get("open_price")),
        "high": _safe_float(latest_row.get("high_price")),
        "low": _safe_float(latest_row.get("low_price")),
        "close": new_close,
        "volume": _safe_float(latest_row.get("volume")),
    }
    for w in MA_WINDOWS:
        new_record[MA_COLUMNS[w]] = mas.get(MA_COLUMNS[w])

    # append + truncate
    existing_records.append(new_record)
    if len(existing_records) > max_len:
        existing_records = existing_records[-max_len:]

    return existing_records


def _update_margin_incremental(
    existing_records: list[dict],
    new_df: pd.DataFrame,
    stock_id: str,
    max_len: int,
) -> list[dict]:
    """增量更新融資券資料"""
    if new_df.empty:
        return existing_records

    # 過濾該股票的當日資料
    df_stock = new_df[new_df["stock_id"] == stock_id]
    if df_stock.empty:
        return existing_records

    new_records = _margin_to_records(df_stock.sort_values("date"))
    return _append_array(existing_records, new_records, max_len)


def _update_chip_incremental(
    existing_records: list[dict],
    new_df: pd.DataFrame,
    stock_id: str,
    max_len: int,
) -> list[dict]:
    """增量更新法人籌碼資料"""
    if new_df.empty:
        return existing_records

    df_stock = new_df[new_df["stock_id"] == stock_id]
    if df_stock.empty:
        return existing_records

    new_records = _chip_to_records(df_stock.sort_values("date"))
    return _append_array(existing_records, new_records, max_len)


def _update_tdcc_incremental(
    existing_records: list[dict],
    tdcc_dir: str,
    stock_id: str,
    max_len: int,
) -> list[dict]:
    """
    增量更新集保資料。

    掃描 weekly_tdcc 目錄下最新的 max_len + 1 個 Parquet，
    取出該股票的集保資料，若與既有的最後一筆日期不同則更新。
    """
    if not os.path.isdir(tdcc_dir):
        return existing_records

    parquet_files = sorted(
        [f for f in os.listdir(tdcc_dir) if f.endswith(".parquet")]
    )
    if not parquet_files:
        return existing_records

    # 取最新 max_len + 1 個檔案
    selected = parquet_files[-(max_len + 1):]

    dfs = []
    for fname in selected:
        fpath = os.path.join(tdcc_dir, fname)
        try:
            df = pd.read_parquet(fpath, engine="pyarrow")
            if not df.empty and "證券代號" in df.columns:
                df_stock = df[df["證券代號"] == stock_id]
                if not df_stock.empty:
                    dfs.append(df_stock)
        except Exception:
            continue

    if not dfs:
        return existing_records

    combined = pd.concat(dfs, ignore_index=True)
    combined = combined.sort_values("日期")

    new_records = _tdcc_to_records(combined)

    # 只保留最新 max_len 筆
    if len(new_records) > max_len:
        new_records = new_records[-max_len:]

    return new_records


def update_daily(target_date: str) -> int:
    """
    每日增量更新個股 JSON。

    流程：
      1. 讀取當日的 daily_price / daily_margin / daily_chip Parquet
      2. 對每檔有價量資料的股票，更新其 JSON
      3. 檢查 tdcc 是否有新資料

    Args:
        target_date: YYYYMMDD

    Returns:
        int: 更新的股票數
    """
    from quant_system_v2.database.storage import _get_table_dir

    d = target_date.replace("-", "")
    logger.info(f"[stock_api] 增量更新: {d}")

    # 1. 讀取當日資料
    df_price_today = load_dataframe("daily_price", d)
    if df_price_today.empty:
        logger.warning(f"  {d} 無價量資料，跳過增量更新")
        return 0

    df_margin_today = load_dataframe("daily_margin", d)
    df_chip_today = load_dataframe("daily_chip", d)

    # 2. 取得當日有價量的股票 ID
    stock_ids_today = set(df_price_today["stock_id"].unique())

    # 3. 過濾非現貨商品
    # (已由 run.py 的 crawler 階段過濾，但為安全再過濾一次)
    for _df in [df_price_today, df_margin_today, df_chip_today]:
        if _df is not None and not _df.empty and "stock_id" in _df.columns:
            filter_by_type(
                _df,
                exclude=_EXCLUDED_NON_EQUITY,
                id_col="stock_id",
                inplace=True,
            )

    # 4. 逐檔更新
    tdcc_dir = os.path.join(
        _resolve_project_root(), DATA_DIR, "parquet", "weekly_tdcc"
    )
    now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    update_count = 0

    for stock_id in sorted(stock_ids_today):
        # 讀取既有 JSON
        existing = _load_stock_json(stock_id)
        if existing is None:
            # 若股票尚未被批次產生，從歷史資料建立
            logger.info(f"  ⚠️  {stock_id} 尚無 JSON，建立基礎資料...")
            existing = {
                "stock_id": stock_id,
                "stock_name": "",
                "updated_at": now_str,
                "price": [],
                "margin": [],
                "institutional": [],
                "tdcc": [],
            }
            # 嘗試從當日資料補名稱
            name_rows = df_price_today[df_price_today["stock_id"] == stock_id]
            if not name_rows.empty and "stock_name" in name_rows.columns:
                existing["stock_name"] = str(name_rows.iloc[0].get("stock_name", ""))

        # 更新價格
        existing["price"] = _update_price_incremental(
            existing.get("price", []),
            df_price_today,
            stock_id,
            PRICE_MAX_RECORDS,
        )

        # 更新融資券
        existing["margin"] = _update_margin_incremental(
            existing.get("margin", []),
            df_margin_today,
            stock_id,
            MARGIN_MAX_RECORDS,
        )

        # 更新法人籌碼
        existing["institutional"] = _update_chip_incremental(
            existing.get("institutional", []),
            df_chip_today,
            stock_id,
            CHIP_MAX_RECORDS,
        )

        # 更新集保（若有新資料）
        # 集保為週資料，僅在 tdcc 有新檔案時才變動
        existing["tdcc"] = _update_tdcc_incremental(
            existing.get("tdcc", []),
            tdcc_dir,
            stock_id,
            TDCC_MAX_RECORDS,
        )

        existing["updated_at"] = now_str

        # 寫入
        ok = _save_stock_json(stock_id, existing)
        if ok:
            update_count += 1

    # 5. 更新 index.json
    stock_names = {}
    if not df_price_today.empty and "stock_name" in df_price_today.columns:
        stock_names = dict(
            zip(df_price_today["stock_id"], df_price_today["stock_name"])
        )

    # 從既有 JSON 確認股票清單
    stock_dir = _get_stock_dir()
    existing_ids = set()
    if os.path.isdir(stock_dir):
        for fname in os.listdir(stock_dir):
            if fname.endswith(".json") and fname != "index.json":
                sid = fname.replace(".json", "")
                existing_ids.add(sid)

    index_data = [
        {"stock_id": sid, "stock_name": stock_names.get(sid, "")}
        for sid in sorted(existing_ids)
    ]
    _save_index(index_data)

    logger.info(f"  ✅ 增量更新完成: {update_count} 檔股票")
    return update_count