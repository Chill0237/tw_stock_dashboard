"""
JSON Dashboard 匯出模組 — 28 項量化指標完整匯出

職責範圍：
  1. 讀取 Parquet 資料（依賴 database.storage）
  2. 呼叫 Core 模組進行 28 項運算
  3. 將結果轉換為 JSON-safe 格式並寫入檔案
  4. 同步維護 latest.json / dates.json（Static Web API 架構）

28 項指標結構：
  A. 法人金額排行榜 (8)  — 4 identities × 買/賣超
  B. 法人張數排行榜 (8)  — 4 identities × 買/賣超
  C. 信用交易金額排行 (4) — 融資融券 × 增/減
  D. 連買天數與爆量   (4) — streak_trust, streak_foreign, surge_daily, surge_weekly
  E. 集保大戶變動排行 (4) — 比例增幅 × 買/賣, 人數增幅 × 買/賣

JSON 安全性：
  - 所有 DataFrame 輸出前皆執行 .fillna() + .replace([inf, -inf], None)
  - 確保前端不會因 NaN / Infinity 崩潰

防呆原則：
  - 每個指標獨立 try-except，單一指標失敗不影響其他 27 項
"""

import json
import math
import os
import shutil
import glob
import logging
from datetime import datetime
from typing import Optional

import pandas as pd

from quant_system_v2.config.settings import DEFAULT_TOP_N
from quant_system_v2.database.storage import load_dataframe, load_recent_dataframes, load_dataframes_up_to
from quant_system_v2.core.chip_analyzer import (
    institutional_buysell_summary,
    institutional_streak,
)
from quant_system_v2.core.margin_analyzer import margin_amount_rank
from quant_system_v2.core.volume_screener import (
    daily_volume_surge,
    weekly_volume_ratio,
)
from quant_system_v2.core.tdcc_analyzer import large_shareholder_rank
from quant_system_v2.utils.filters import (
    SecurityCategory,
    filter_by_type,
    filter_etf,
    filter_active_equities,
)
from quant_system_v2.utils.status_tracker import load_status

logger = logging.getLogger(__name__)

# ==========================================
# 輔助函數
# ==========================================


def _df_to_safe_list(df: pd.DataFrame) -> list[dict]:
    """
    將 DataFrame 轉換為 JSON-safe 的 Dictionary List。

    處理方式：
      1. 數值 NaN → 0
      2. 字串 NaN → 空字串
      3. Infinity / -Infinity → None
      4. 時間物件 → ISO 字串
    """
    if df is None or df.empty:
        return []

    df = df.copy()

    for col in df.columns:
        if pd.api.types.is_numeric_dtype(df[col]):
            df[col] = df[col].fillna(0)
        elif pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].where(df[col].notna(), None)
            df[col] = df[col].apply(
                lambda x: x.strftime("%Y-%m-%d") if pd.notna(x) else ""
            )
        else:
            df[col] = df[col].fillna("")

    records = df.to_dict(orient="records")

    for record in records:
        for key, value in record.items():
            if isinstance(value, float):
                if value == float("inf") or value == float("-inf"):
                    record[key] = None
                elif pd.isna(value):
                    record[key] = None
            elif isinstance(value, pd.Timestamp):
                record[key] = value.strftime("%Y-%m-%d")

    return records


def _call_metric(
    name: str,
    func,
    *args,
    **kwargs,
) -> list[dict]:
    """
    通用單一指標計算包裹函數。

    自動執行 try-except，失敗時回傳空 list 並記錄錯誤。
    成功時以 _df_to_safe_list 轉換回傳。

    Args:
        name: 指標名稱（僅用於 log）
        func: Core 層函數
        *args, **kwargs: 傳遞給 func 的參數

    Returns:
        list[dict]: JSON-safe 的結果列表
    """
    try:
        df = func(*args, **kwargs)
        result = _df_to_safe_list(df)
        logger.info(f"  [{name}] {len(result)} 筆")
        return result
    except Exception as e:
        logger.error(f"  [{name}] 計算失敗: {e}")
        return []


def _sanitize_json(data):
    """
    遞迴清洗整個資料結構，將所有 NaN / Infinity 轉為 Python None。

    確保 json.dumps() 不會產出非法 token（NaN, Infinity）。
    """
    if isinstance(data, dict):
        return {k: _sanitize_json(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [_sanitize_json(item) for item in data]
    elif isinstance(data, float):
        if math.isnan(data) or math.isinf(data):
            return None
        return data
    return data


def _enrich_records(
    records: list[dict],
    data_date: str,
    stock_name_map: dict[str, str],
) -> list[dict]:
    """
    為 Top 30 輸出補上 stock_name（若缺失）與 data_date。

    Args:
        records: _call_metric 或 _df_to_safe_list 產出的 list[dict]
        data_date: 該指標的資料基準日（YYYYMMDD）
        stock_name_map: stock_id → stock_name 對照表

    Returns:
        同一個 list（in-place 修改後回傳，便於串接）
    """
    for r in records:
        sid = r.get("stock_id", "")
        if "stock_name" not in r or not r.get("stock_name"):
            r["stock_name"] = stock_name_map.get(sid, "")
        r["data_date"] = data_date
    return records


DASHBOARD_RETENTION_DAYS = 22
"""Dashboard JSON 保留天數（交易日）。超過此數量的較舊檔案將被刪除。
與使用者約定的資料保留策略：
  - daily_price: 490 日
  - daily_chip/margin: 30 日
  - weekly_tdcc: 6 週
  - dashboard json: 22 日
"""


def _write_static_api_files(output_dir: str, current_date: str) -> None:
    """
    完善 Static API 輸出邏輯：
      1. 複製 dashboard_{current_date}.json → latest.json
      2. 掃描目錄下所有 dashboard_*.json → 只保留最新 22 個
      3. 寫入 dates.json
    """
    # --- 1. latest.json ---
    src = os.path.join(output_dir, f"dashboard_{current_date}.json")
    if os.path.exists(src):
        dst = os.path.join(output_dir, "latest.json")
        try:
            shutil.copy2(src, dst)
            logger.info(
                f"  ✅ latest.json 已更新 ({os.path.getsize(dst):,} bytes)"
            )
        except Exception as e:
            logger.error(f"  ❌ latest.json 寫入失敗: {e}")

    # --- 2. 掃描所有 dashboard_*.json，保留最新 22 個，其餘刪除 ---
    try:
        pattern = os.path.join(output_dir, "dashboard_*.json")
        dashboard_files = []
        for fpath in glob.glob(pattern):
            basename = os.path.basename(fpath)
            date_part = basename.replace("dashboard_", "").replace(".json", "")
            if date_part.isdigit() and len(date_part) == 8:
                dashboard_files.append((date_part, fpath))

        # 依日期降序排序（最新在前）
        dashboard_files.sort(key=lambda x: x[0], reverse=True)

        # 保留最新 DASHBOARD_RETENTION_DAYS 個
        to_keep = dashboard_files[:DASHBOARD_RETENTION_DAYS]
        to_delete = dashboard_files[DASHBOARD_RETENTION_DAYS:]

        for date_part, fpath in to_delete:
            try:
                os.remove(fpath)
                logger.info(f"  🗑️  刪除過期 Dashboard: {os.path.basename(fpath)}")
            except Exception as e:
                logger.warning(f"  ⚠️  刪除失敗 {fpath}: {e}")

        # 只保留的日期寫入 dates.json
        dates = [date_part for date_part, _ in to_keep]
        dates_path = os.path.join(output_dir, "dates.json")
        with open(dates_path, "w", encoding="utf-8") as f:
            json.dump(dates, f, ensure_ascii=False)
        logger.info(
            f"  ✅ dates.json 已更新 ({len(dates)} 個日期, "
            f"已清理 {len(to_delete)} 個過期檔案)"
        )
    except Exception as e:
        logger.error(f"  ❌ dates.json 處理失敗: {e}")


# ==========================================
# 主控函數
# ==========================================


def export_dashboard_json(
    date_str: str,
    output_path: str,
    history_max_date: Optional[str] = None,
) -> bool:
    """
    主控函數：讀取資料 → 28 項指標運算 → 匯出 JSON。

    Args:
        date_str: 日期字串，YYYYMMDD 或 YYYY-MM-DD
        output_path: JSON 輸出檔案的完整路徑
        history_max_date: 歷史資料的上限日期（YYYYMMDD），
            用於 Backfill 時確保 streak/vol surge 等指標只看目標日期以前的資料。
            預設 None（不對歷史資料做日期過濾，適用每日執行）。 

    Returns:
        bool: True 代表成功寫入，False 代表所有指標皆失敗
    """
    d = date_str.replace("-", "")
    now_str = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    logger.info(f"[export] 開始匯出 Dashboard JSON for {d}")

    # ──────────────────────────────────────────
    # 1. 讀取資料
    # ──────────────────────────────────────────

    # 單日資料
    df_chip_single = load_dataframe("daily_chip", d)
    df_margin_single = load_dataframe("daily_margin", d)
    df_price_single = load_dataframe("daily_price", d)

    # 若當日無價量資料（休市、國定假日或爬取失敗），直接跳過不產出 JSON
    if df_price_single.empty:
        logger.warning(f"[export] {d} 無價量資料（休市或爬取失敗），跳過 JSON 產出")
        return False

    # 多日資料（用於連買掃描 / 爆量 / 週量計算）
    df_chip_history = load_recent_dataframes("daily_chip", 30)
    df_price_history = load_recent_dataframes("daily_price", 30)

    # 若指定 history_max_date（Backfill 時），對歷史資料做日期上限過濾，
    # 確保 streak / surge 等指標只看目標日期以前的資料，避免看到未來
    if history_max_date is not None:
        max_dt = pd.to_datetime(history_max_date)
        df_chip_history = df_chip_history[df_chip_history["date"] <= max_dt]
        df_price_history = df_price_history[df_price_history["date"] <= max_dt]

    # 集保歷史資料（週資料，只看最近期資料）
    # Backfill 時：使用 load_dataframes_up_to，載入截至目標日期的最近 N 期
    # 每日執行時：使用 load_recent_dataframes，載入系統中最新 N 期
    if history_max_date is not None:
        max_dt_str = history_max_date.replace("-", "")
        df_tdcc_history = load_dataframes_up_to("weekly_tdcc", max_dt_str, 10)
    else:
        df_tdcc_history = load_recent_dataframes("weekly_tdcc", 10)

    # ── 全量過濾非現貨商品（影響所有指標：法人買賣超、融資券、連買、爆量、大戶）──
    # 在所有 DataFrame 交給 Core 運算前排除 ETF / 權證 / REITs / ETN，
    # 確保前端榜單僅顯示一般上市櫃股票
    _EXCLUDED_NON_EQUITY = [
        SecurityCategory.ETF,
        SecurityCategory.WARRANT,
        SecurityCategory.REIT,
        SecurityCategory.ETN,
    ]
    for _df in [df_chip_single, df_margin_single, df_price_single]:
        if _df is not None and not _df.empty and "stock_id" in _df.columns:
            filter_by_type(
                _df,
                exclude=_EXCLUDED_NON_EQUITY,
                id_col="stock_id",
                inplace=True,
            )
    for _df in [df_chip_history, df_price_history]:
        if _df is not None and not _df.empty and "stock_id" in _df.columns:
            filter_by_type(
                _df,
                exclude=_EXCLUDED_NON_EQUITY,
                id_col="stock_id",
                inplace=True,
            )
    if df_tdcc_history is not None and not df_tdcc_history.empty and "證券代號" in df_tdcc_history.columns:
        filter_by_type(
            df_tdcc_history,
            exclude=_EXCLUDED_NON_EQUITY,
            id_col="證券代號",
            inplace=True,
        )

    # 預備合併歷史資料（for streak）
    merged_history = _build_merged_history(df_chip_history, df_price_history)

    # ── 建立 stock_id → stock_name 對照表（用於後續補欄位）──
    # 從多來源逐步補全：daily_price > daily_chip > daily_margin > weekly_tdcc
    stock_name_map: dict[str, str] = {}
    for src_df in [
        df_price_single, df_chip_single, df_margin_single, df_tdcc_history
    ]:
        if src_df is not None and not src_df.empty and "stock_name" in src_df.columns:
            stock_name_map.update(
                dict(zip(src_df["stock_id"], src_df["stock_name"]))
            )

    # ── 建立 stock_id → close_price 對照表（用於大戶籌碼指標補收盤價）──
    close_price_map: dict[str, float] = {}
    if df_price_single is not None and not df_price_single.empty and "close_price" in df_price_single.columns:
        close_price_map = dict(
            zip(df_price_single["stock_id"], df_price_single["close_price"])
        )

    # ── 取得集保資料最新日期（用於大戶指標的 data_date）──
    latest_tdcc_date = d
    if df_tdcc_history is not None and not df_tdcc_history.empty:
        try:
            unique_dates = sorted(df_tdcc_history["日期"].astype(str).unique())
            if unique_dates:
                latest_tdcc_date = unique_dates[-1]
        except Exception:
            pass

    # ──────────────────────────────────────────
    # 2. 執行各項運算（28 項指標）
    # ──────────────────────────────────────────

    rankings = {}

    # ── A. 法人金額排行榜 (8) ──
    logger.info("[指標群 A] 法人金額排行榜...")

    for _id, _id_label in [
        ("total", "三大法人"),
        ("foreign", "外資"),
        ("trust", "投信"),
        ("prop", "自營商"),
    ]:
        for _asc, _dir_suffix, _dir_label in [
            (False, "buy", "買超"),
            (True, "sell", "賣超"),
        ]:
            key = f"buysell_{_id}_{_dir_suffix}_amount"
            rankings[key] = _call_metric(
                f"法人{_id_label}{_dir_label}金額",
                institutional_buysell_summary,
                df_chip_single,
                df_price_single,
                identity=_id,
                sort_by="amount",
                top_n=DEFAULT_TOP_N,
                ascending=_asc,
            )

    # ── B. 法人張數排行榜 (8) ──
    logger.info("[指標群 B] 法人張數排行榜...")

    for _id, _id_label in [
        ("total", "三大法人"),
        ("foreign", "外資"),
        ("trust", "投信"),
        ("prop", "自營商"),
    ]:
        for _asc, _dir_suffix, _dir_label in [
            (False, "buy", "買超"),
            (True, "sell", "賣超"),
        ]:
            key = f"buysell_{_id}_{_dir_suffix}_shares"
            rankings[key] = _call_metric(
                f"法人{_id_label}{_dir_label}張數",
                institutional_buysell_summary,
                df_chip_single,
                df_price_single,
                identity=_id,
                sort_by="shares",
                top_n=DEFAULT_TOP_N,
                ascending=_asc,
            )

    # ── C. 信用交易金額排行榜 (4) ──
    logger.info("[指標群 C] 信用交易金額排行榜...")

    for _mode, _mode_label in [
        ("fin_buy", "融資增加"),
        ("fin_sell", "融資減少"),
        ("mar_buy", "融券增加"),
        ("mar_sell", "融券減少"),
    ]:
        key = f"margin_{_mode}"
        rankings[key] = _call_metric(
            _mode_label,
            margin_amount_rank,
            df_margin_single,
            df_price_single,
            mode=_mode,
            top_n=DEFAULT_TOP_N,
        )

    # ── D. 連買天數與價量爆發 (4) ──
    logger.info("[指標群 D] 連買天數與價量爆發...")

    rankings["streak_trust"] = _call_metric(
        "投信連買",
        institutional_streak,
        merged_history,
        force_type="trust",
        top_n=DEFAULT_TOP_N,
        min_days=3,
    )

    rankings["streak_foreign"] = _call_metric(
        "外資連買",
        institutional_streak,
        merged_history,
        force_type="foreign",
        top_n=DEFAULT_TOP_N,
        min_days=3,
    )

    rankings["surge_daily"] = _call_metric(
        "單日爆量",
        daily_volume_surge,
        df_price_history,
        top_n=DEFAULT_TOP_N,
        lookback_days=5,
    )

    rankings["surge_weekly"] = _call_metric(
        "週量增溫",
        weekly_volume_ratio,
        df_price_history,
        top_n=DEFAULT_TOP_N,
    )

    # ── E. 集保大戶變動排行榜 (4) ──
    logger.info("[指標群 E] 集保大戶變動排行榜...")

    if df_tdcc_history is not None and not df_tdcc_history.empty:
        try:
            df_large = large_shareholder_rank(
                df_tdcc_history  # 不回傳 top_n，由下方 split 邏輯自行處理正負
            )
            if df_large is not None and not df_large.empty:
                logger.info(
                    f"  [大戶原始資料] {len(df_large)} 筆"
                )

                # E1. 大戶比例增幅買 / 賣
                df_ratio_buy = df_large[df_large["大戶比例增幅"] > 0].copy()
                df_ratio_buy = df_ratio_buy.sort_values(
                    "大戶比例增幅", ascending=False
                ).head(DEFAULT_TOP_N)
                rankings["chip_large_ratio_buy"] = _df_to_safe_list(df_ratio_buy)

                df_ratio_sell = df_large[df_large["大戶比例增幅"] < 0].copy()
                df_ratio_sell["大戶比例增幅"] = df_ratio_sell[
                    "大戶比例增幅"
                ].abs()
                df_ratio_sell = df_ratio_sell.sort_values(
                    "大戶比例增幅", ascending=False
                ).head(DEFAULT_TOP_N)
                rankings["chip_large_ratio_sell"] = _df_to_safe_list(df_ratio_sell)

                # E2. 大戶人數增幅增加 / 減少
                df_count_buy = df_large[df_large["大戶人數增幅"] > 0].copy()
                df_count_buy = df_count_buy.sort_values(
                    "大戶人數增幅", ascending=False
                ).head(DEFAULT_TOP_N)
                rankings["chip_large_count_buy"] = _df_to_safe_list(df_count_buy)

                df_count_sell = df_large[df_large["大戶人數增幅"] < 0].copy()
                df_count_sell["大戶人數增幅"] = df_count_sell[
                    "大戶人數增幅"
                ].abs()
                df_count_sell = df_count_sell.sort_values(
                    "大戶人數增幅", ascending=False
                ).head(DEFAULT_TOP_N)
                rankings["chip_large_count_sell"] = _df_to_safe_list(df_count_sell)

                logger.info(
                    f"  [大戶拆分完成] ratio_buy={len(rankings['chip_large_ratio_buy'])}, "
                    f"ratio_sell={len(rankings['chip_large_ratio_sell'])}, "
                    f"count_buy={len(rankings['chip_large_count_buy'])}, "
                    f"count_sell={len(rankings['chip_large_count_sell'])}"
                )
            else:
                logger.warning("  [大戶] large_shareholder_rank 回傳空，設為 []")
                _set_empty_large_rankings(rankings)
        except Exception as e:
            logger.error(f"  [大戶] 計算失敗: {e}")
            _set_empty_large_rankings(rankings)
    else:
        logger.warning("  [大戶] 無 TDCC 歷史資料，設為 []")
        _set_empty_large_rankings(rankings)

    # ──────────────────────────────────────────
    # 3. 補全 stock_name、data_date 與 close_price
    # ──────────────────────────────────────────

    for key, records in rankings.items():
        is_tdcc = key.startswith("chip_large_")
        dd = latest_tdcc_date if is_tdcc else d
        rankings[key] = _enrich_records(records, dd, stock_name_map)
        # 為大戶籌碼指標補 close_price
        if is_tdcc:
            for r in records:
                sid = r.get("stock_id", "")
                cp = r.get("close_price")
                if "close_price" not in r or cp is None or (isinstance(cp, float) and (math.isnan(cp) or math.isinf(cp))):
                    cp_val = close_price_map.get(sid)
                    if cp_val is not None and not (isinstance(cp_val, float) and math.isnan(cp_val)):
                        r["close_price"] = cp_val
                    else:
                        r["close_price"] = None

    # ──────────────────────────────────────────
    # 4. 組裝最終 JSON
    # ──────────────────────────────────────────

    dashboard_data = {
        "update_time": now_str,
        "data_date": d,
        "rankings": rankings,
        "data_status": load_status(d),
    }

    # ──────────────────────────────────────────
    # 4. 寫入檔案
    # ──────────────────────────────────────────

    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        dashboard_data = _sanitize_json(dashboard_data)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(dashboard_data, f, ensure_ascii=False, indent=2)
        logger.info(
            f"[export] ✅ JSON 已寫入: {output_path} "
            f"({os.path.getsize(output_path):,} bytes, "
            f"{sum(len(v) for v in rankings.values())} 總筆數)"
        )
        return True
    except Exception as e:
        logger.error(f"[export] 寫入 JSON 失敗: {e}")
        return False


def _set_empty_large_rankings(rankings: dict) -> None:
    """將四個大戶指標設為空 list（輔助函數，減少重複程式碼）"""
    for key in [
        "chip_large_ratio_buy",
        "chip_large_ratio_sell",
        "chip_large_count_buy",
        "chip_large_count_sell",
    ]:
        rankings[key] = []


def _build_merged_history(
    df_chip_history: pd.DataFrame,
    df_price_history: pd.DataFrame,
) -> pd.DataFrame:
    """合併籌碼 + 價量歷史資料，供 institutional_streak 使用。"""
    if df_chip_history.empty or df_price_history.empty:
        return pd.DataFrame()

    price_cols = [
        c
        for c in ["stock_id", "date", "close_price", "volume"]
        if c in df_price_history.columns
    ]
    merged = pd.merge(
        df_chip_history,
        df_price_history[price_cols],
        on=["stock_id", "date"],
        how="inner",
    )
    return merged


# ==========================================
# 安全封裝版本（含 Static API 同步）
# ==========================================


def export_dashboard_json_safe(
    date_str: str,
    output_dir: Optional[str] = None,
    history_max_date: Optional[str] = None,
) -> str:
    """
    export_dashboard_json 的封裝版本。

    若 output_dir 未指定，預設為 PROJECT_ROOT/docs/api/。

    成功寫入 dashboard JSON 後，自動：
      1. 複製為 latest.json
      2. 掃描所有 dashboard_*.json 寫入 dates.json

    Args:
        date_str: 日期字串，YYYYMMDD 或 YYYY-MM-DD
        output_dir: 輸出目錄（選填）
        history_max_date: 歷史資料的上限日期（YYYYMMDD），
            用於 Backfill 時確保 streak/vol surge 等指標只看目標日期以前的資料。
            預設 None（不對歷史資料做日期過濾，適用每日執行）。

    Returns:
        str: 輸出檔案的完整路徑（若失敗則回傳空字串）
    """
    d = date_str.replace("-", "")
    if output_dir is None:
        _project_root = os.path.dirname(
            os.path.dirname(os.path.abspath(__file__))
        )
        output_dir = os.path.join(_project_root, "docs", "api")

    output_path = os.path.join(output_dir, f"dashboard_{d}.json")

    success = export_dashboard_json(date_str, output_path, history_max_date=history_max_date)
    if success:
        _write_static_api_files(output_dir, d)
        return output_path
    return ""
