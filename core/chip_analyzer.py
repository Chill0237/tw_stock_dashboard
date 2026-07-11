"""
籌碼面分析模組（三大法人買賣超、連買天數）

職責範圍：
  1. institutional_buysell_summary — 法人買賣超排名（支援多法人 × 金額/張數）
  2. institutional_streak — 法人連續買超掃描（含強度計算）

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

_FOREIGN_COL = "foreign_buy_sell"
_TRUST_COL = "trust_buy_sell"
_PROP_COL = "prop_buy_sell"
_TOTAL_INST_COL = "total_inst_buy_sell"
_VOLUME_COL = "volume"
_CLOSE_COL = "close_price"

# identity 對應的買賣超欄位（單位：股）
_IDENTITY_COLUMN_MAP = {
    "foreign": _FOREIGN_COL,
    "trust": _TRUST_COL,
    "prop": _PROP_COL,
    "total": _TOTAL_INST_COL,
}

# 舊用 force_type 向（保留相容）
_FORCE_COLUMN_MAP = _IDENTITY_COLUMN_MAP.copy()


def institutional_buysell_summary(
    df_chip: pd.DataFrame,
    df_price: pd.DataFrame,
    identity: str = "total",
    sort_by: str = "amount",
    top_n: int = DEFAULT_TOP_N,
    ascending: bool = False,
) -> pd.DataFrame:
    """
    計算法人買賣超排名（多法人 × 金額/張數雙維度）。

    將法人買賣超（原始單位：股）轉換為張數與金額（千元），
    支援四種法人身份與買超/賣超排行榜。

    Args:
        df_chip: 標準化後的每日籌碼 DataFrame
            必須包含：stock_id, stock_name, {identity 對應的買賣超欄位}
        df_price: 當日價量 DataFrame
            必須包含：stock_id, close_price
            可選：stock_name（若 chip 已含 stock_name 則以此為優先）
        identity: 法人身份
            'foreign' — 外資（不含自營商）
            'trust'   — 投信
            'prop'    — 自營商（自行買賣+避險）
            'total'   — 三大法人合計
        sort_by: 排序維度
            'amount'  — 金額（千元）
            'shares'  — 張數
        top_n: 回傳前 N 名（正整數）
        ascending: 排序方向
            False — 買超榜（高到低）
            True  — 賣超榜（低到高，即負值在前）

    Returns:
        DataFrame 欄位：
          stock_id, stock_name, close_price, value
          其中 value 即為排序標的（金額千元或張數，保留兩位小數）
        若缺少必要欄位則回傳空的 DataFrame
    """
    if df_chip is None or df_chip.empty:
        logger.warning("[buysell_summary] 傳入空的 df_chip")
        return pd.DataFrame()
    if df_price is None or df_price.empty:
        logger.warning("[buysell_summary] 傳入空的 df_price")
        return pd.DataFrame()

    if identity not in _IDENTITY_COLUMN_MAP:
        raise ValueError(
            f"[buysell_summary] 不支援的 identity: {identity}，"
            f"可用: {list(_IDENTITY_COLUMN_MAP.keys())}"
        )

    if sort_by not in ("amount", "shares"):
        raise ValueError(
            f"[buysell_summary] 不支援的 sort_by: {sort_by}，"
            f"可用: 'amount', 'shares'"
        )

    target_col = _IDENTITY_COLUMN_MAP[identity]

    # 檢查必要欄位
    if target_col not in df_chip.columns:
        logger.warning(f"[buysell_summary] df_chip 缺少欄位: {target_col}")
        return pd.DataFrame()
    if "stock_id" not in df_chip.columns or "stock_id" not in df_price.columns:
        logger.warning("[buysell_summary] 缺少 stock_id 欄位")
        return pd.DataFrame()
    if _CLOSE_COL not in df_price.columns:
        logger.warning(f"[buysell_summary] df_price 缺少欄位: {_CLOSE_COL}")
        return pd.DataFrame()

    # Merge 取得 close_price 與 stock_name
    chip_cols = ["stock_id", target_col]
    if "stock_name" in df_chip.columns:
        chip_cols.append("stock_name")

    price_cols = ["stock_id", _CLOSE_COL]
    # 若 df_price 有 stock_name 但 df_chip 沒有，才從 price 取
    if "stock_name" not in df_chip.columns and "stock_name" in df_price.columns:
        price_cols.append("stock_name")

    merged = pd.merge(
        df_chip[chip_cols],
        df_price[price_cols],
        on="stock_id",
        how="inner",
        suffixes=("_chip", "_price"),
    )

    if merged.empty:
        logger.warning("[buysell_summary] merge 後無共同股票")
        return pd.DataFrame()

    # 過濾權證（在排序前移除）
    merged = filter_active_equities(merged, id_col="stock_id")

    # 統一 stock_name（chip 優先）
    name_col = (
        "stock_name"
        if "stock_name" in merged.columns
        else (
            "stock_name_price"
            if "stock_name_price" in merged.columns
            else None
        )
    )

    # 確保數值型別
    merged[target_col] = pd.to_numeric(merged[target_col], errors="coerce").fillna(0)
    merged[_CLOSE_COL] = pd.to_numeric(merged[_CLOSE_COL], errors="coerce").fillna(0)

    # 計算衍生維度
    # 張數 = 原始股數 / 1,000
    # 金額 (千元) = 原始股數 × close_price / 1,000
    merged["shares"] = (merged[target_col] / 1000).round(2)
    merged["amount"] = (merged[target_col] * merged[_CLOSE_COL] / 1000).round(2)

    # 排序
    value_col = "amount" if sort_by == "amount" else "shares"
    merged = merged.sort_values(by=value_col, ascending=ascending).head(top_n)

    # 預備回傳
    result = pd.DataFrame({
        "stock_id": merged["stock_id"],
        "stock_name": merged[name_col] if name_col else "",
        "close_price": merged[_CLOSE_COL],
        "value": merged[value_col],
    })

    logger.info(
        f"[buysell_summary] 完成: {len(result)} 筆, "
        f"identity={identity}, sort_by={sort_by}, "
        f"top1_value={result['value'].iloc[0] if not result.empty else 'N/A'}"
    )
    return result.reset_index(drop=True)


def institutional_streak(
    df_history: pd.DataFrame,
    force_type: str = "trust",
    top_n: int = DEFAULT_TOP_N,
    min_days: int = 3,
    min_avg_vol: int = 500,
) -> pd.DataFrame:
    """
    掃描全市場法人的連續買超天數與買超強度。

    對每檔股票由新到舊逐日掃描，累計連續買超天數與買超量，
    並計算買超強度 = 累計買超量 / 累計成交量 × 100。

    Args:
        df_history: 多日合併的籌碼 + 價量 DataFrame（已 merge 或 join）
            必須包含欄位：stock_id, stock_name, date,
            {force_type 對應的買賣超欄位}, volume, close_price
        force_type: 法人類型，支援 'foreign' / 'trust' / 'total'
        top_n: 回傳前 N 名（正整數）
        min_days: 最低連買天數門檻（預設 3）
        min_avg_vol: 最低 5 日均量門檻（張，預設 500）

    Returns:
        DataFrame 欄位：
          stock_id, stock_name, streak_days, total_buy_volume,
          intensity, close_price
        若無符合條件的股票則回傳空的 DataFrame

    Raises:
        ValueError: 若 force_type 不支援
    """
    if df_history is None or df_history.empty:
        logger.warning("[streak] 傳入空的 DataFrame")
        return pd.DataFrame()

    # 檢查 force_type
    if force_type not in _FORCE_COLUMN_MAP:
        raise ValueError(
            f"[streak] 不支援的 force_type: {force_type}，"
            f"可用: {list(_FORCE_COLUMN_MAP.keys())}"
        )

    target_col = _FORCE_COLUMN_MAP[force_type]
    required_cols = ["stock_id", "date", target_col, _VOLUME_COL, _CLOSE_COL]

    missing = [c for c in required_cols if c not in df_history.columns]
    if missing:
        logger.warning(f"[streak] 缺少必要欄位: {missing}")
        return pd.DataFrame()

    # 確保數值型別
    for col in [target_col, _VOLUME_COL, _CLOSE_COL]:
        df_history[col] = pd.to_numeric(df_history[col], errors="coerce").fillna(0)

    # 確保由新到舊排序 (對每檔股票)
    df_history = df_history.sort_values(
        ["stock_id", "date"], ascending=[True, False]
    ).reset_index(drop=True)

    # 過濾權證（在 groupby 計算前移除）
    df_history = filter_active_equities(df_history, id_col="stock_id")

    results = []
    grouped = df_history.groupby("stock_id")

    for stock_id, group in grouped:
        streak = 0
        total_buy = 0.0
        total_vol = 0.0

        for _, row in group.iterrows():
            buy_lots = float(row[target_col])

            if pd.isna(buy_lots):
                break

            if buy_lots > 0:
                streak += 1
                total_buy += buy_lots
                total_vol += float(row[_VOLUME_COL])
            else:
                break  # 遇到賣超或無動作就中斷

        if streak >= min_days:
            # 檢查 5 日均量
            avg_vol = group[_VOLUME_COL].head(5).mean()
            if avg_vol >= min_avg_vol:
                intensity = (total_buy / total_vol * 100) if total_vol > 0 else 0.0
                latest_price = group[_CLOSE_COL].iloc[0]
                stock_name = (
                    group["stock_name"].iloc[0]
                    if "stock_name" in group.columns
                    else ""
                )

                results.append(
                    {
                        "stock_id": stock_id,
                        "stock_name": stock_name,
                        "streak_days": streak,
                        "total_buy_volume": int(total_buy),
                        "intensity": round(intensity, 1),
                        "close_price": round(float(latest_price), 2),
                    }
                )

    if not results:
        logger.info(f"[streak] 無符合條件 ({min_days}天連買, 均量>{min_avg_vol}) 的股票")
        return pd.DataFrame()

    df_res = pd.DataFrame(results)
    # 排序：強度第一、天數第二
    df_res = df_res.sort_values(
        by=["intensity", "streak_days"], ascending=[False, False]
    ).head(top_n)

    logger.info(f"[streak] {force_type} 連買: {len(df_res)} 筆")
    return df_res.reset_index(drop=True)