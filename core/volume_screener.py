"""
成交量爆量篩選模組

職責範圍：
  1. daily_volume_surge — 當日爆量排名（今日成交量 / 過去 N 日均量）
  2. weekly_volume_ratio — 週量增溫排名（本週均量 / 上週均量）

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

_VOLUME_COL = "volume"
_CLOSE_COL = "close_price"


def daily_volume_surge(
    df: pd.DataFrame,
    top_n: int = DEFAULT_TOP_N,
    lookback_days: int = 5,
    min_avg_vol: int = 100,
) -> pd.DataFrame:
    """
    計算當日爆量倍數排名。

    對每檔股票計算「今日成交量 ÷ 過去 N 日均量」的爆量倍數，
    回傳倍數最高的前 top_n 名。

    運算假設：
      - df 已按 stock_id + date 排序（或至少同支股票連續）
      - 每支股票在 df 中至少有 lookback_days + 1 筆資料
      - 最後一筆為最新交易日（未過濾處置股等，由上層負責）

    Args:
        df: 多日合併的 daily_price DataFrame
            必要欄位：stock_id, stock_name, date, volume
        top_n: 回傳前 N 名
        lookback_days: 對比過去幾天均量（預設 5）
        min_avg_vol: 最低均量門檻（張，預設 100，低於此視為冷門股跳過）

    Returns:
        DataFrame 欄位：
          stock_id, stock_name, close_price,
          volume, avg_volume, surge_ratio
        若無符合條件的股票則回傳空的 DataFrame
    """
    if df is None or df.empty:
        logger.warning("[daily_surge] 傳入空的 DataFrame")
        return pd.DataFrame()

    required_cols = ["stock_id", "date", _VOLUME_COL]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        logger.warning(f"[daily_surge] 缺少必要欄位: {missing}")
        return pd.DataFrame()

    df = df.copy()

    # 確保數值型別
    df[_VOLUME_COL] = pd.to_numeric(df[_VOLUME_COL], errors="coerce").fillna(0)

    # 確保存內排序一致 (每支股票由舊到新，最後一筆為最新)
    df = df.sort_values(["stock_id", "date"], ascending=[True, True]).reset_index(
        drop=True
    )

    # 過濾權證（在 groupby 計算前移除）
    df = filter_active_equities(df, id_col="stock_id")

    # 找出最新日期
    latest_date = df["date"].max()

    results = []
    grouped = df.groupby("stock_id")

    for stock_id, group in grouped:
        group = group.reset_index(drop=True)

        # 確認最新日期
        if group["date"].iloc[-1] != latest_date:
            continue

        # 需要有足夠的歷史資料
        if len(group) < lookback_days + 1:
            continue

        today_vol = group[_VOLUME_COL].iloc[-1]
        # 取前 lookback_days 筆做為歷史均量
        prev_vols = group[_VOLUME_COL].iloc[-(lookback_days + 1) : -1]
        avg_prev_vol = prev_vols.mean()

        if pd.isna(avg_prev_vol) or avg_prev_vol <= 0 or avg_prev_vol < min_avg_vol:
            continue

        surge_ratio = today_vol / avg_prev_vol

        stock_name = (
            group["stock_name"].iloc[-1] if "stock_name" in group.columns else ""
        )
        close_price = (
            group[_CLOSE_COL].iloc[-1] if _CLOSE_COL in group.columns else None
        )

        results.append(
            {
                "stock_id": stock_id,
                "stock_name": stock_name,
                "close_price": close_price,
                "volume": int(today_vol),
                "avg_volume": int(avg_prev_vol),
                "surge_ratio": round(surge_ratio, 2),
            }
        )

    if not results:
        logger.info(
            f"[daily_surge] 無符合條件股票 (lookback={lookback_days}, "
            f"min_avg_vol={min_avg_vol})"
        )
        return pd.DataFrame()

    df_res = pd.DataFrame(results)
    df_res = df_res.sort_values(by="surge_ratio", ascending=False).head(top_n)

    logger.info(f"[daily_surge] 完成: {len(df_res)} 筆")
    return df_res.reset_index(drop=True)


def weekly_volume_ratio(
    df: pd.DataFrame,
    top_n: int = DEFAULT_TOP_N,
    min_avg_vol: int = 100,
) -> pd.DataFrame:
    """
    計算週量增溫排名（本週均量 ÷ 上週均量）。

    以每支股票最近 10 個交易日為窗口：
      本週均量 = 最近 5 日成交量平均
      上週均量 = 前 5~9 日成交量平均
      週量比   = 本週均量 / 上週均量

    Args:
        df: 多日合併的 daily_price DataFrame
            必要欄位：stock_id, stock_name, date, volume
        top_n: 回傳前 N 名
        min_avg_vol: 最低上週均量門檻（張，預設 100）

    Returns:
        DataFrame 欄位：
          stock_id, stock_name, close_price,
          this_week_avg_vol, last_week_avg_vol, weekly_ratio
        若無符合條件的股票則回傳空的 DataFrame
    """
    if df is None or df.empty:
        logger.warning("[weekly_ratio] 傳入空的 DataFrame")
        return pd.DataFrame()

    required_cols = ["stock_id", "date", _VOLUME_COL]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        logger.warning(f"[weekly_ratio] 缺少必要欄位: {missing}")
        return pd.DataFrame()

    df = df.copy()
    df[_VOLUME_COL] = pd.to_numeric(df[_VOLUME_COL], errors="coerce").fillna(0)
    df = df.sort_values(["stock_id", "date"], ascending=[True, True]).reset_index(
        drop=True
    )

    # 過濾權證（在 groupby 計算前移除）
    df = filter_active_equities(df, id_col="stock_id")

    results = []
    grouped = df.groupby("stock_id")

    for stock_id, group in grouped:
        group = group.reset_index(drop=True)

        # 需要至少 10 筆
        if len(group) < 10:
            continue

        data = group.tail(10)

        # 本週 = 最近 5 日，上週 = 前 5~9 日
        this_week_vol = data[_VOLUME_COL].iloc[-5:].mean()
        last_week_vol = data[_VOLUME_COL].iloc[-10:-5].mean()

        if (
            pd.isna(this_week_vol)
            or pd.isna(last_week_vol)
            or this_week_vol <= 0
            or last_week_vol <= 0
        ):
            continue

        if last_week_vol < min_avg_vol:
            continue

        ratio = this_week_vol / last_week_vol

        stock_name = (
            group["stock_name"].iloc[-1] if "stock_name" in group.columns else ""
        )
        close_price = (
            group[_CLOSE_COL].iloc[-1] if _CLOSE_COL in group.columns else None
        )

        results.append(
            {
                "stock_id": stock_id,
                "stock_name": stock_name,
                "close_price": close_price,
                "this_week_avg_vol": int(this_week_vol),
                "last_week_avg_vol": int(last_week_vol),
                "weekly_ratio": round(ratio, 2),
            }
        )

    if not results:
        logger.info(f"[weekly_ratio] 無符合條件股票 (min_avg_vol={min_avg_vol})")
        return pd.DataFrame()

    df_res = pd.DataFrame(results)
    df_res = df_res.sort_values(by="weekly_ratio", ascending=False).head(top_n)

    logger.info(f"[weekly_ratio] 完成: {len(df_res)} 筆")
    return df_res.reset_index(drop=True)