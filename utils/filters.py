"""
市場標的過濾工具（Market Filter）

職責範圍：
  1. 提供 SecurityCategory Enum 統一管理所有證券類別
  2. classify() — 將單一代號分類
  3. filter_by_type() — 單一入口，支援 include（正向保留）或 exclude（反向剔除）
  4. filter_active_equities / filter_etf — 向後相容 wrapper

證券代號編碼規則：
  - ETF：   00 開頭（如 0050, 0050K, 00632R）
  - 權證：  03~08 或 7 開頭，6 碼（如 03001B, 70999P）
  - REITs： 01 開頭，第 6 碼為 T（如 01001T）
  - ETN：   02 開頭，6 碼（如 02001A）
  - TDR：   91 開頭（如 9101, 910001）
  - 現貨：  以上皆非（一般股票）

使用範例：
  # 反向剔除（移除 ETF + 權證）
  filter_by_type(df, exclude=[SecurityCategory.ETF, SecurityCategory.WARRANT], inplace=True)

  # 正向保留（只取權證）
  df_w = filter_by_type(df, include=[SecurityCategory.WARRANT])

  # 同時傳入 include 與 exclude 會拋出 ValueError
"""

import re
import pandas as pd
from enum import Enum
from typing import Optional

_logger = __import__("logging").getLogger(__name__)

# ==========================================
# 證券代號正則（僅比對 stock_id 字串格式）
# ==========================================

# ETF: 00 開頭
#   4 碼純數字       如 0050
#   5 碼含字母尾綴    如 0050K, 0050B
#   6 碼含字母尾綴    如 00632R, 00687B
_ETF_RE = re.compile(r"^00\d{2}$|^00\d{2}[A-Z0-9]$|^00\d{3}[A-Z0-9]$")

# 權證: 總長度固定 6 碼
#   前兩碼 03~08 或第一碼 7 + 中間純數字 + 最後一碼字母/數字
_WARRANT_RE = re.compile(r"^(?:0[3-8]\d{3}|7\d{4})[A-Z0-9]$")

# REITs: 01 開頭，固定 6 碼，最後一碼為大寫 T
_REIT_RE = re.compile(r"^01\d{3}T$")

# ETN: 02 開頭，固定 6 碼，最後一碼可為字母或數字
_ETN_RE = re.compile(r"^02\d{3}[A-Z0-9]$")

# TDR（存托憑證）: 91 開頭
#   4 碼純數字       如 9101, 9102
#   6 碼純數字       如 910001, 910005
_TDR_RE = re.compile(r"^91\d{2}$|^91\d{4}$")

# ==========================================
# SecurityCategory Enum
# ==========================================


class SecurityCategory(Enum):
    """證券類別列舉"""
    EQUITY = "equity"      # 一般現股（上市櫃股票）
    ETF = "etf"            # 指數股票型基金
    WARRANT = "warrant"    # 權證（認購/認售/牛熊證）
    REIT = "reit"          # 不動產投資信託
    ETN = "etn"            # 指數投資證券
    TDR = "tdr"            # 存托憑證（臺灣存託憑證）

    def __str__(self) -> str:
        return self.value


# ==========================================
# classify() — 單一代號分類
# ==========================================


def classify(stock_id: str) -> SecurityCategory:
    """
    辨識單一證券代號的類別。

    Args:
        stock_id: 證券代號字串（如 "0050", "03001B"）

    Returns:
        對應的 SecurityCategory，無法識別時回傳 SecurityCategory.EQUITY
    """
    sid = str(stock_id).strip().upper()

    if _WARRANT_RE.match(sid):
        return SecurityCategory.WARRANT
    if _ETF_RE.match(sid):
        return SecurityCategory.ETF
    if _REIT_RE.match(sid):
        return SecurityCategory.REIT
    if _ETN_RE.match(sid):
        return SecurityCategory.ETN
    if _TDR_RE.match(sid):
        return SecurityCategory.TDR

    # 預設為現貨
    return SecurityCategory.EQUITY


# ==========================================
# filter_by_type() — 單一入口
# ==========================================


def filter_by_type(
    df: pd.DataFrame,
    *,
    include: Optional[list[SecurityCategory]] = None,
    exclude: Optional[list[SecurityCategory]] = None,
    id_col: str = "stock_id",
    inplace: bool = False,
) -> Optional[pd.DataFrame]:
    """
    依證券類別過濾 DataFrame。

    Args:
        df: 輸入 DataFrame，必須包含 id_col 欄位
        include: 僅保留指定類別的標的（正向篩選）
        exclude: 移除指定類別的標的（反向篩選）
        id_col: 標的代號欄位名稱（預設 'stock_id'）
        inplace: 是否直接修改原 df（預設 False）

    Returns:
        過濾後的 DataFrame（inplace=True 時回傳 None 或原 df 參考）

    Raises:
        ValueError: 同時傳入 include 與 exclude
    """
    if include is not None and exclude is not None:
        raise ValueError("Cannot set both include and exclude")

    if df is None or df.empty:
        return df

    if id_col not in df.columns:
        _logger.warning(
            f"[filter_by_type] DataFrame 缺少欄位 '{id_col}'，跳過過濾"
        )
        return df

    # 無過濾條件，直接回傳
    if include is None and exclude is None:
        return df

    # 建立布林遮罩
    if include is not None:
        wanted = set(include)
        mask = df[id_col].astype(str).apply(lambda x: classify(x) in wanted)
    else:
        unwanted = set(exclude)
        mask = ~df[id_col].astype(str).apply(lambda x: classify(x) in unwanted)

    removed_count = (~mask).sum()

    if inplace:
        df.drop(df[~mask].index, inplace=True)
        result = df
    else:
        result = df[mask].copy()

    if removed_count > 0:
        categories = include or exclude
        cat_labels = [str(c) for c in categories]
        _logger.info(
            f"[filter_by_type] 已{'保留' if include else '移除'} "
            f"{removed_count} 筆 {', '.join(cat_labels)} 標的"
        )

    return result


# ==========================================
# 向後相容 wrapper（不破壞現有呼叫端）
# ==========================================


def filter_active_equities(
    df: pd.DataFrame,
    id_col: str = "stock_id",
    inplace: bool = False,
) -> Optional[pd.DataFrame]:
    """
    過濾權證，僅保留上市櫃現貨標的。

    向後相容 wrapper，內部委託 filter_by_type()。

    Args:
        df: 輸入 DataFrame，必須包含 id_col 欄位
        id_col: 標的代號欄位名稱（預設 'stock_id'）
        inplace: 是否直接修改原 df（預設 False）

    Returns:
        過濾後的 DataFrame
    """
    return filter_by_type(
        df,
        exclude=[SecurityCategory.WARRANT],
        id_col=id_col,
        inplace=inplace,
    )


def filter_etf(
    df: pd.DataFrame,
    id_col: str = "stock_id",
    inplace: bool = False,
) -> Optional[pd.DataFrame]:
    """
    過濾 ETF，僅保留非 ETF 標的。

    向後相容 wrapper，內部委託 filter_by_type()。

    Args:
        df: 輸入 DataFrame，必須包含 id_col 欄位
        id_col: 標的代號欄位名稱（預設 'stock_id'）
        inplace: 是否直接修改原 df（預設 False）

    Returns:
        過濾後的 DataFrame
    """
    return filter_by_type(
        df,
        exclude=[SecurityCategory.ETF],
        id_col=id_col,
        inplace=inplace,
    )