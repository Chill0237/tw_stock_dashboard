"""
Snapshot API 模組 — 產出當日個股總表 JSON

職責：
  1. 讀取當日 daily_price Parquet
  2. 以 stock_id 為 key 產出輕量化 dict
  3. 寫入 docs/api/snapshot.json（永遠覆蓋最新交易日）

欄位映射（Parquet → snapshot key）：
  n = stock_name（名稱）
  c = close_price（收盤價）
  d = price_change（漲跌價差）
  p = 漲跌幅百分比（price_change / prev_close * 100）
  v = volume / 1000（成交量，張）
  h = high_price（最高）
  l = low_price（最低）

安全性：
  - 所有數值 NaN → None
  - Infinity → None
  - volume 為 0 時 prev_close 可能為 0 → p 設 None
"""

import json
import math
import os
import logging
from typing import Optional

import pandas as pd

from quant_system_v2.database.storage import load_dataframe

logger = logging.getLogger(__name__)


def _resolve_project_root() -> str:
    """解析專案根目錄（api/ → quant_system_v2/ → project root）"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _sanitize_value(value) -> Optional:
    """單一值 NaN/Inf 清洗"""
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
    return value


def export_daily_snapshot(date_str: str) -> str:
    """
    產出當日個股總表 snapshot.json。

    Args:
        date_str: 日期字串，YYYYMMDD 或 YYYY-MM-DD

    Returns:
        str: 輸出檔案絕對路徑，失敗則回傳空字串
    """
    d = date_str.replace("-", "")

    # ── 1. 讀取當日 daily_price ──
    df = load_dataframe("daily_price", d)
    if df is None or df.empty:
        logger.warning(f"[snapshot] {d} 無 daily_price 資料，跳過產出")
        return ""

    logger.info(f"[snapshot] 讀取 {d} daily_price: {len(df)} 列")

    # ── 2. 建立 snapshot dict ──
    stocks: dict[str, dict] = {}

    for _, row in df.iterrows():
        sid = row.get("stock_id")
        if not sid or pd.isna(sid):
            continue
        sid_str = str(sid)

        # 基本欄位
        name = row.get("stock_name")
        if pd.isna(name):
            name = ""
        else:
            name = str(name)

        close_price = row.get("close_price")
        price_change = row.get("price_change")
        volume_raw = row.get("volume")
        high_price = row.get("high_price")
        low_price = row.get("low_price")

        # 價格欄位清洗
        c = _sanitize_value(close_price)
        d_val = _sanitize_value(price_change)
        h = _sanitize_value(high_price)
        l = _sanitize_value(low_price)

        # 漲跌幅 p: price_change / prev_close * 100
        # prev_close = close_price - price_change（跌停為負值）
        p_val: Optional[float] = None
        if (
            c is not None
            and d_val is not None
            and not math.isnan(c)
            and not math.isnan(d_val)
        ):
            prev_close = c - d_val
            if prev_close != 0 and not math.isnan(prev_close):
                p_change = round(d_val / prev_close * 100, 2)
                p_val = _sanitize_value(p_change)
            else:
                p_val = None

        # 成交量轉張數
        v_val: Optional[float] = None
        if volume_raw is not None and not (isinstance(volume_raw, float) and math.isnan(volume_raw)):
            try:
                v_val = round(float(volume_raw) / 1000)
            except (ValueError, TypeError):
                v_val = None

        stocks[sid_str] = {
            "n": name if name else None,
            "c": c,
            "d": d_val,
            "p": p_val,
            "v": v_val,
            "h": h,
            "l": l,
        }

    # ── 3. 組裝最終 JSON ──
    snapshot = {
        "date": f"{d[:4]}-{d[4:6]}-{d[6:8]}",
        "stocks": stocks,
    }

    # 清理頂層 NaN（安全起見）
    snapshot = _sanitize_json_dict(snapshot)

    # ── 4. 寫入 docs/api/snapshot.json ──
    output_dir = os.path.join(_resolve_project_root(), "docs", "api")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "snapshot.json")

    try:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
        file_size = os.path.getsize(output_path)
        logger.info(
            f"[snapshot] ✅ 已寫入: {output_path} "
            f"({file_size:,} bytes, {len(stocks)} 檔個股)"
        )
        return output_path
    except Exception as e:
        logger.error(f"[snapshot] ❌ 寫入失敗: {e}")
        return ""


def _sanitize_json_dict(data):
    """遞迴清洗 dict/list 中的 NaN/Inf → None"""
    if isinstance(data, dict):
        return {k: _sanitize_json_dict(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [_sanitize_json_dict(item) for item in data]
    elif isinstance(data, float):
        if math.isnan(data) or math.isinf(data):
            return None
        return data
    return data