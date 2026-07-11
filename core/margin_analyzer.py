"""
融資融券分析模組

職責範圍：
  1. margin_amount_rank — 融資/融券金額變動排名（以金額排序）

依賴：
  - config.settings.DEFAULT_TOP_N（排名預設值）
  - 僅 Pandas 矩陣運算，無磁碟 IO 或 API 請求

禁止：
  - 中文欄位名稱操作
  - 直接讀取 Parquet / 資料庫
  - Discord Embed 輸出或 print
"""

import pandas as pd
import logging
from typing import Optional

from quant_system_v2.config.settings import DEFAULT_TOP_N
from quant_system_v2.utils.filters import filter_active_equities

logger = logging.getLogger(__name__)

# ==========================================
# 欄位常數（與 schema.py 同步）
# ==========================================

_FIN_BALANCE = "fin_balance"
_FIN_PREV_BALANCE = "fin_prev_balance"
_MAR_BALANCE = "mar_balance"
_MAR_PREV_BALANCE = "mar_prev_balance"
_CLOSE_COL = "close_price"

# mode 參數對應
_MODE_CONFIG = {
    "fin_buy": {
        "balance_col": _FIN_BALANCE,
        "prev_col": _FIN_PREV_BALANCE,
        "label": "資增金額",
    },
    "fin_sell": {
        "balance_col": _FIN_BALANCE,
        "prev_col": _FIN_PREV_BALANCE,
        "label": "資減金額",
    },
    "mar_buy": {
        "balance_col": _MAR_BALANCE,
        "prev_col": _MAR_PREV_BALANCE,
        "label": "券增金額",
    },
    "mar_sell": {
        "balance_col": _MAR_BALANCE,
        "prev_col": _MAR_PREV_BALANCE,
        "label": "券減金額",
    },
}


def margin_amount_rank(
    df_margin: pd.DataFrame,
    df_price: pd.DataFrame,
    mode: str = "fin_buy",
    top_n: int = DEFAULT_TOP_N,
) -> pd.DataFrame:
    """
    信用交易金額化排名（融資/融券增減金額排行榜）。

    運算邏輯：
      - fin_buy  (資增)  = (fin_balance - fin_prev_balance) * close_price * 1,000 / 1,000
      - fin_sell (資減)  = (fin_prev_balance - fin_balance) * close_price * 1,000 / 1,000
      - mar_buy  (券增)  = (mar_balance - mar_prev_balance) * close_price * 1,000 / 1,000
      - mar_sell (券減)  = (mar_prev_balance - mar_balance) * close_price * 1,000 / 1,000
      簡化公式：value = (balance - prev_balance) * close_price  (千元)

    Args:
        df_margin: 標準化後的融資融券 DataFrame
            必須包含：stock_id, stock_name, fin_balance, fin_prev_balance,
                     mar_balance, mar_prev_balance
        df_price: 當日價量 DataFrame
            必須包含：stock_id, close_price
        mode: 排名模式
            'fin_buy'  — 融資增加（金額）
            'fin_sell' — 融資減少（金額）
            'mar_buy'  — 融券增加（金額）
            'mar_sell' — 融券減少（金額）
        top_n: 回傳前 N 名（正整數）

    Returns:
        DataFrame 欄位：
          stock_id, stock_name, close_price, value
          其中 value 為增減金額（千元，保留兩位小數）
        若缺少必要欄位則回傳空的 DataFrame

    Raises:
        ValueError: 若 mode 不支援
    """
    if df_margin is None or df_margin.empty:
        logger.warning("[margin_rank] 傳入空的 df_margin")
        return pd.DataFrame()
    if df_price is None or df_price.empty:
        logger.warning("[margin_rank] 傳入空的 df_price")
        return pd.DataFrame()

    if mode not in _MODE_CONFIG:
        raise ValueError(
            f"[margin_rank] 不支援的 mode: {mode}，"
            f"可用: {list(_MODE_CONFIG.keys())}"
        )

    cfg = _MODE_CONFIG[mode]
    balance_col = cfg["balance_col"]
    prev_col = cfg["prev_col"]

    # 檢查必要欄位
    required_margin = ["stock_id", balance_col, prev_col]
    missing_margin = [c for c in required_margin if c not in df_margin.columns]
    if missing_margin:
        logger.warning(f"[margin_rank] df_margin 缺少欄位: {missing_margin}")
        return pd.DataFrame()

    if "stock_id" not in df_price.columns or _CLOSE_COL not in df_price.columns:
        logger.warning(f"[margin_rank] df_price 缺少 stock_id 或 {_CLOSE_COL}")
        return pd.DataFrame()

    # Merge
    margin_cols = ["stock_id", balance_col, prev_col]
    if "stock_name" in df_margin.columns:
        margin_cols.append("stock_name")

    merged = pd.merge(
        df_margin[margin_cols],
        df_price[["stock_id", _CLOSE_COL]],
        on="stock_id",
        how="inner",
    )

    if merged.empty:
        logger.warning("[margin_rank] merge 後無共同股票")
        return pd.DataFrame()

    # 過濾權證（在排序前移除）
    merged = filter_active_equities(merged, id_col="stock_id")

    # 確保數值型別
    for col in [balance_col, prev_col, _CLOSE_COL]:
        merged[col] = pd.to_numeric(merged[col], errors="coerce").fillna(0)

    # 計算增減金額（千元）
    # 公式範例 fin_buy:  (fin_balance - fin_prev_balance) * close_price
    # 公式範例 fin_sell: (fin_prev_balance - fin_balance) * close_price
    is_sell_mode = mode in ("fin_sell", "mar_sell")
    if is_sell_mode:
        merged["change"] = merged[prev_col] - merged[balance_col]
    else:
        merged["change"] = merged[balance_col] - merged[prev_col]

    merged["value"] = (merged["change"] * merged[_CLOSE_COL]).round(2)

    # 過濾並排序
    result = merged[merged["value"] > 0].copy()
    result = result.sort_values(by="value", ascending=False).head(top_n)

    # 預備回傳
    stock_name_col = "stock_name" if "stock_name" in result.columns else None
    output = pd.DataFrame({
        "stock_id": result["stock_id"],
        "stock_name": result[stock_name_col] if stock_name_col else "",
        "close_price": result[_CLOSE_COL],
        "value": result["value"],
    })

    logger.info(
        f"[margin_rank] {cfg['label']}: {len(output)} 筆, "
        f"top1_value={output['value'].iloc[0] if not output.empty else 'N/A'}"
    )
    return output.reset_index(drop=True)