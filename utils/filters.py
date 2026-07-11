"""
市場標的過濾工具（Market Filter）

職責範圍：
  1. filter_active_equities — 排除權證（Warrant），保留上市櫃現貨
  2. filter_etf — 排除 ETF（代碼前 2 碼為 00）

規則說明（權證代號辨識）：
  - 6 碼字串
  - 前兩碼 03~08（認購/認售權證）
  - 第一碼為 7（部分權證/牛熊證）
  - 若有特殊後綴（如 T、U）仍為權證

ETF 代號辨識：
  - 前兩碼為 "00"（如 0050, 006208, 00940）

未來可擴充：
  - filter_tdr()
  - filter_punished_stocks()
"""

import re
import pandas as pd
from typing import Optional

_logger = __import__("logging").getLogger(__name__)

# 權證代號正則：6 碼，前兩碼 03~08 或第一碼為 7
_WARRANT_RE = re.compile(r"^(0[3-8][0-9A-Z]{4}|7[0-9A-Z]{5})$")


def filter_active_equities(
    df: pd.DataFrame,
    id_col: str = "stock_id",
    inplace: bool = False,
) -> Optional[pd.DataFrame]:
    """
    過濾權證，僅保留上市櫃現貨標的。

    對傳入的 DataFrame 篩選 id_col 欄位，移除權證代號列，
    回傳僅含現貨的 DataFrame。

    Args:
        df: 輸入 DataFrame，必須包含 id_col 欄位
        id_col: 標的代號欄位名稱（預設 'stock_id'）
        inplace: 是否直接修改原 df（預設 False，回傳新物件）

    Returns:
        過濾後的 DataFrame（若 inplace=False 則為新物件）
        若 df 無 id_col 欄位則回傳原 df 並記錄警告
    """
    if df is None or df.empty:
        return df

    if id_col not in df.columns:
        _logger.warning(
            f"[filter_active_equities] DataFrame 缺少欄位 '{id_col}'，跳過過濾"
        )
        return df

    # 轉型為字串後比對
    mask = ~df[id_col].astype(str).str.match(_WARRANT_RE)
    removed_count = (~mask).sum()

    if inplace:
        df.drop(df[~mask].index, inplace=True)
        result = df
    else:
        result = df[mask].copy()

    if removed_count > 0:
        _logger.info(
            f"[filter_active_equities] 已移除 {removed_count} 筆權證標的"
        )

    return result


def filter_etf(
    df: pd.DataFrame,
    id_col: str = "stock_id",
    inplace: bool = False,
) -> Optional[pd.DataFrame]:
    """
    過濾 ETF（股票代碼前 2 碼為 00），僅保留非 ETF 標的。

    Args:
        df: 輸入 DataFrame，必須包含 id_col 欄位
        id_col: 標的代號欄位名稱（預設 'stock_id'）
        inplace: 是否直接修改原 df（預設 False，回傳新物件）

    Returns:
        過濾後的 DataFrame（若 inplace=False 則為新物件）
        若 df 無 id_col 欄位則回傳原 df 並記錄警告
    """
    if df is None or df.empty:
        return df

    if id_col not in df.columns:
        _logger.warning(
            f"[filter_etf] DataFrame 缺少欄位 '{id_col}'，跳過過濾"
        )
        return df

    # 轉型為字串後比對，保留前兩碼不為 "00" 的標的（使用前綴比對，支援 4~6 碼 ETF）
    mask = ~df[id_col].astype(str).str.startswith("00")
    removed_count = (~mask).sum()

    if inplace:
        df.drop(df[~mask].index, inplace=True)
        result = df
    else:
        result = df[mask].copy()

    if removed_count > 0:
        _logger.info(
            f"[filter_etf] 已移除 {removed_count} 筆 ETF 標的"
        )

    return result