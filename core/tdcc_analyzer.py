"""
TDCC 集保股權分散分析模組（大戶籌碼變動）

職責範圍：
  1. large_shareholder_rank — 大戶比例增幅與人數增幅排名

運算邏輯：
  - 大戶定義依門檻 level_codes 決定：
      LARGE_LEVEL_1000 = 15（超過 1,000 張）
      LARGE_LEVELS_400 = [12, 13, 14, 15]（400 張以上）
  - 找出資料中最新與次新兩期，計算比例與人數的絕對差值
  - 以「大戶比例增幅」降冪排序回傳（不截斷，由呼叫端 split 正負值）

依賴：
  - config.settings.DEFAULT_TOP_N_TDCC（排名預設值）
  - 僅 Pandas 矩陣運算，無磁碟 IO 或 API 請求

禁止：
  - 中文欄位名稱操作以外的業務邏輯
  - 直接讀取 Parquet / 資料庫
  - Discord Embed 輸出或 print
"""

import pandas as pd
import logging
from typing import Optional

from quant_system_v2.config.settings import DEFAULT_TOP_N_TDCC
from quant_system_v2.utils.filters import filter_active_equities, filter_etf

logger = logging.getLogger(__name__)

# ==========================================
# 欄位常數（與 schema.py 同步，使用原始中文）
# ==========================================

_DATE_COL = "日期"
_STOCK_ID_COL = "證券代號"
_LEVEL_COL = "持股分級"
_COUNT_COL = "人數"
_SHARES_COL = "股數"
_PCT_COL = "占集保庫存數比例%"

# ── 大戶持股分級門檻（官方代碼）──
#   12=400-600張, 13=600-800張, 14=800-1000張, 15=超過1000張
LARGE_LEVEL_1000 = 15               # 大戶(1000)：超過 1,000 張
LARGE_LEVELS_400 = [12, 13, 14, 15]  # 大戶(400)：400 張以上
# 預設門檻（向後相容）：大戶(1000)
_DEFAULT_LARGE_LEVELS = LARGE_LEVEL_1000


def large_shareholder_rank(
    df_tdcc_history: pd.DataFrame,
    level_codes=None,
    top_n: int = DEFAULT_TOP_N_TDCC,
) -> pd.DataFrame:
    """
    計算大戶比例增幅與人數增幅排名。

    對傳入的多期 TDCC 歷史資料，找出最新與次新兩期，
    計算指定門檻（一組持股分級代碼）下大戶群體的占集保比例與人數變化。

    Args:
        df_tdcc_history: 多期合併的 TDCC 集保 DataFrame
            必須包含欄位：日期, 證券代號, 持股分級, 人數, 股數, 占集保庫存數比例%
        level_codes: 大戶持股分級門檻，可傳單一整數（如 15=大戶1000）或一組
            代碼（如 LARGE_LEVELS_400=[12,13,14,15]=400張以上）。預設大戶(1000)。
        top_n: 回傳前 N 名（正整數）

    Returns:
        DataFrame 欄位：
          stock_id       — 證券代號（已清理空白）
          大戶比例增幅    — 最新大戶比例 - 次新大戶比例（百分點）
          大戶人數增幅    — 最新大戶人數 - 次新大戶人數
          最新大戶比例    — 最新一期的大戶占集保比例
          最新大戶人數    — 最新一期的大戶人數
        若資料不足兩期則回傳空的 DataFrame
    """
    if df_tdcc_history is None or df_tdcc_history.empty:
        logger.warning("[large_shareholder] 傳入空的 DataFrame")
        return pd.DataFrame()

    # 確認必要欄位存在
    required_cols = [_DATE_COL, _STOCK_ID_COL, _LEVEL_COL, _COUNT_COL, _PCT_COL]
    missing = [c for c in required_cols if c not in df_tdcc_history.columns]
    if missing:
        logger.warning(f"[large_shareholder] 缺少必要欄位: {missing}")
        return pd.DataFrame()

    df = df_tdcc_history.copy()

    # 過濾權證與 ETF
    df = filter_active_equities(df, id_col=_STOCK_ID_COL)
    df = filter_etf(df, id_col=_STOCK_ID_COL)

    # 確保日期可排序
    df[_DATE_COL] = df[_DATE_COL].astype(str).str.strip()

    # 找出唯一日期並排序，確認是否有兩期以上
    unique_dates = sorted(df[_DATE_COL].unique())
    if len(unique_dates) < 2:
        logger.warning(
            f"[large_shareholder] 僅有 {len(unique_dates)} 期資料，"
            f"無法計算變動量。日期: {unique_dates}"
        )
        return pd.DataFrame()

    latest_date = unique_dates[-1]
    prev_date = unique_dates[-2]
    logger.info(
        f"[large_shareholder] 比較期間: {prev_date} → {latest_date}"
    )

    # 正規化門檻為一組持股分級代碼（相容單一整數）
    if level_codes is None:
        level_codes = _DEFAULT_LARGE_LEVELS
    if isinstance(level_codes, int):
        codes = [level_codes]
    else:
        codes = list(level_codes)
    if not codes:
        logger.warning("[large_shareholder] 未指定任何持股分級門檻")
        return pd.DataFrame()

    # 確保持股分級為數值後，篩選落在門檻內的分級
    df[_LEVEL_COL] = pd.to_numeric(df[_LEVEL_COL], errors="coerce")
    df_large = df[df[_LEVEL_COL].isin(codes)].copy()
    if df_large.empty:
        logger.warning(f"[large_shareholder] 無大戶資料（持股分級∈{codes}）")
        return pd.DataFrame()

    # 當門檻涵蓋多個分級（如 400 張以上=12~15），同檔股票會跨多列，
    # 需按 (日期, 證券代號) 聚合：人數加總、占集保庫存數比例加總。
    df_large = df_large.groupby([_DATE_COL, _STOCK_ID_COL], as_index=False).agg(
        **{
            _COUNT_COL: pd.NamedAgg(column=_COUNT_COL, aggfunc="sum"),
            _PCT_COL: pd.NamedAgg(column=_PCT_COL, aggfunc="sum"),
        }
    )
    logger.info(f"[large_shareholder] 門檻=持股分級{ codes }，聚合後 {len(df_large)} 檔")

    # 拆分最新與次新兩期
    df_latest = df_large[df_large[_DATE_COL] == latest_date].copy()
    df_prev = df_large[df_large[_DATE_COL] == prev_date].copy()

    if df_latest.empty or df_prev.empty:
        logger.warning(
            "[large_shareholder] 最新或次新期無大戶資料，"
            f"latest={len(df_latest)}, prev={len(df_prev)}"
        )
        return pd.DataFrame()

    # 清理證券代號空白、確認為字串型別
    df_latest.loc[:, _STOCK_ID_COL] = df_latest[_STOCK_ID_COL].astype(str).str.strip()
    df_prev.loc[:, _STOCK_ID_COL] = df_prev[_STOCK_ID_COL].astype(str).str.strip()

    # 選取必要欄位並重新命名避免 merge 衝突
    latest_cols = {
        _STOCK_ID_COL: _STOCK_ID_COL,
        _PCT_COL: "latest_pct",
        _COUNT_COL: "latest_count",
    }
    prev_cols = {
        _STOCK_ID_COL: _STOCK_ID_COL,
        _PCT_COL: "prev_pct",
        _COUNT_COL: "prev_count",
    }

    df_latest_sel = df_latest[list(latest_cols.keys())].rename(columns=latest_cols)
    df_prev_sel = df_prev[list(prev_cols.keys())].rename(columns=prev_cols)

    # Merge（inner join 確保兩期都有資料）
    merged = pd.merge(
        df_latest_sel,
        df_prev_sel,
        on=_STOCK_ID_COL,
        how="inner",
    )

    if merged.empty:
        logger.warning("[large_shareholder] merge 後無共同股票")
        return pd.DataFrame()

    # 計算增幅
    merged["大戶比例增幅"] = merged["latest_pct"] - merged["prev_pct"]
    merged["大戶人數增幅"] = merged["latest_count"] - merged["prev_count"]
    merged["最新大戶比例"] = merged["latest_pct"]
    merged["最新大戶人數"] = merged["latest_count"]

    # 排序：大戶比例增幅由高到低（不回傳 top_n，由呼叫端自行 split 正負值）
    merged = merged.sort_values(by="大戶比例增幅", ascending=False)

    # 回傳嚴格定義的 5 個欄位（不截斷，讓 export_json 自行 split 成正負榜）
    result = merged[
        [
            _STOCK_ID_COL,
            "大戶比例增幅",
            "大戶人數增幅",
            "最新大戶比例",
            "最新大戶人數",
        ]
    ].reset_index(drop=True)

    # 證券代號重新命名為 stock_id（英文，與其他模組一致）
    result = result.rename(columns={_STOCK_ID_COL: "stock_id"})

    logger.info(
        f"[large_shareholder] 完成: {len(result)} 筆, "
        f"ratio_buy={len(result[result['大戶比例增幅'] > 0])}, "
        f"ratio_sell={len(result[result['大戶比例增幅'] < 0])}, "
        f"top1={result['stock_id'].iloc[0] if not result.empty else 'N/A'}"
    )
    return result
