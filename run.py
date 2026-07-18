"""
V2 系統主控台 — 每日排程執行入口（狀態追蹤版）

用法：
    python -m quant_system_v2.run                     # 預設：指針 API 自動取得最新交易日
    python -m quant_system_v2.run --date 20260709   # 手動指定日期（回補用）

流程：
    Step 0: 決定 target_date（--date 或指針 API）
    Step 1: 載入 status.json 中的資料完整度
    Step 2: 只爬取缺少的子資料源（上市/上櫃各自獨立）
    Step 3: 熔斷判斷 — 無新資料且 Dashboard 已存在則跳過 Phase 2
    Step 4: 強制匯出 Dashboard JSON（漸進式即時更新）
"""

import argparse
import logging
import os
import sys
from datetime import datetime

# 確保專案根目錄在 sys.path 中（支援從任意位置執行）
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import pandas as pd

from quant_system_v2.crawler.market_crawler import (
    fetch_twse_daily_quotes,
    fetch_twse_institutional,
    fetch_twse_margin_trading,
    fetch_tpex_daily_quotes,
    fetch_tpex_institutional,
    fetch_tpex_margin_trading,
    fetch_tdcc_distribution,
)
from quant_system_v2.database.transform import standardize_dataframe
from quant_system_v2.database.storage import save_dataframe, load_dataframe
from quant_system_v2.api.export_json import export_dashboard_json_safe
from quant_system_v2.utils.status_tracker import (
    fetch_market_date,
    load_status,
    save_status,
)

logger = logging.getLogger("quant_system_v2.run")

# ==========================================
# 參數解析
# ==========================================


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="V2 系統主控台 — 每日資料爬取、儲存與 Dashboard 匯出（狀態追蹤版）"
    )
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="目標日期 (YYYYMMDD)，預設由指針 API 自動取得最新交易日",
    )
    return parser.parse_args()


# ==========================================
# 輔助函數：上市/上櫃識別
# ==========================================


def _has_twse_stocks(df: pd.DataFrame) -> bool:
    """檢查 DataFrame 中是否包含上市股票（stock_id 以 1-6 開頭）"""
    if df is None or df.empty or "stock_id" not in df.columns:
        return False
    return df["stock_id"].astype(str).str.match(r"^[1-6]").any()


def _has_tpex_stocks(df: pd.DataFrame) -> bool:
    """檢查 DataFrame 中是否包含上櫃股票（stock_id 以 6-9 開頭且非上市）"""
    if df is None or df.empty or "stock_id" not in df.columns:
        return False
    return df["stock_id"].astype(str).str.match(r"^[6-9]").any()


def _merge_with_existing(new_df: pd.DataFrame, table_name: str, target_date: str) -> pd.DataFrame:
    """
    將新爬取的資料與本地已存在的 Parquet 合併去重。
    避免補抓時把前半天已存的資料沖掉。

    Args:
        new_df: 新爬取的 DataFrame（已 standardize）
        table_name: 資料表名稱
        target_date: YYYYMMDD

    Returns:
        合併去重後的 DataFrame
    """
    existing = load_dataframe(table_name, target_date)
    if existing.empty:
        return new_df

    frames = [existing, new_df]
    combined = pd.concat(frames, ignore_index=True)

    # 去重：依 stock_id + date 為準（保留後出現的記錄，即新資料優先）
    if "stock_id" in combined.columns and "date" in combined.columns:
        combined = combined.drop_duplicates(subset=["stock_id", "date"], keep="last")

    logger.info(
        f"  [merge] {table_name}/{target_date}: "
        f"既有={len(existing)}, 新增={len(new_df)}, 合併={len(combined)}"
    )
    return combined


# ==========================================
# Phase 1：漸進爬取（Status-Driven）
# ==========================================


def _phase1_crawl(target_date: str) -> bool:
    """
    執行 Phase 1：讀取 status → 只爬取缺少的子源 → 更新 status。

    Returns:
        bool: 是否有任何子源狀態發生變化（用於 Phase 2 熔斷判斷）
    """
    status = load_status(target_date)
    changed = False

    # ── 1. 價量（上市 + 上櫃各自獨立）──
    price_frames = []

    # 上市價量
    if not status["price_twse"]:
        logger.info(f"[Phase1] 抓取上市價量 ({target_date})...")
        df = fetch_twse_daily_quotes(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_twse_stocks(df_clean):
                price_frames.append(df_clean)
                save_status(target_date, {"price_twse": True})
                changed = True
                logger.info(f"  ✅ 上市價量 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上市價量回傳無上市股票，跳過")
        else:
            logger.warning("  ⚠️  上市價量 API 回傳空")
    else:
        logger.info("  [Skip] 上市價量已存在")

    # 上櫃價量
    if not status["price_tpex"]:
        logger.info(f"[Phase1] 抓取上櫃價量 ({target_date})...")
        df = fetch_tpex_daily_quotes(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_tpex_stocks(df_clean):
                price_frames.append(df_clean)
                save_status(target_date, {"price_tpex": True})
                changed = True
                logger.info(f"  ✅ 上櫃價量 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上櫃價量回傳無上櫃股票，跳過")
        else:
            logger.warning("  ⚠️  上櫃價量 API 回傳空")
    else:
        logger.info("  [Skip] 上櫃價量已存在")

    # 合併並儲存價量
    if price_frames:
        df_price = pd.concat(price_frames, ignore_index=True)
        df_price = _merge_with_existing(df_price, "daily_price", target_date)
        if not df_price.empty:
            save_dataframe(df_price, "daily_price", target_date)
    else:
        # 若均無新資料但有既有資料（status 顯示已有），不需要寫入
        if not status["price_twse"] and not status["price_tpex"]:
            logger.warning("  ⚠️  價量無資料（上市與上櫃皆失敗），跳過。")

    # ── 2. 法人買賣超（上市 + 上櫃各自獨立）──
    chip_frames = []

    # 上市法人
    if not status["chip_twse"]:
        logger.info(f"[Phase1] 抓取上市法人買賣超 ({target_date})...")
        df = fetch_twse_institutional(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_twse_stocks(df_clean):
                chip_frames.append(df_clean)
                save_status(target_date, {"chip_twse": True})
                changed = True
                logger.info(f"  ✅ 上市法人 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上市法人回傳無上市股票，跳過")
        else:
            logger.warning("  ⚠️  上市法人 API 回傳空")
    else:
        logger.info("  [Skip] 上市法人已存在")

    # 上櫃法人
    if not status["chip_tpex"]:
        logger.info(f"[Phase1] 抓取上櫃法人買賣超 ({target_date})...")
        df = fetch_tpex_institutional(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_tpex_stocks(df_clean):
                chip_frames.append(df_clean)
                save_status(target_date, {"chip_tpex": True})
                changed = True
                logger.info(f"  ✅ 上櫃法人 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上櫃法人回傳無上櫃股票，跳過")
        else:
            logger.warning("  ⚠️  上櫃法人 API 回傳空")
    else:
        logger.info("  [Skip] 上櫃法人已存在")

    # 合併並儲存法人
    if chip_frames:
        df_chip = pd.concat(chip_frames, ignore_index=True)
        df_chip = _merge_with_existing(df_chip, "daily_chip", target_date)
        if not df_chip.empty:
            save_dataframe(df_chip, "daily_chip", target_date)
    else:
        if not status["chip_twse"] and not status["chip_tpex"]:
            logger.warning("  ⚠️  法人無資料（上市與上櫃皆失敗），跳過。")

    # ── 3. 融資融券（上市 + 上櫃各自獨立）──
    margin_frames = []

    # 上市融資券
    if not status["margin_twse"]:
        logger.info(f"[Phase1] 抓取上市融資券 ({target_date})...")
        df = fetch_twse_margin_trading(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_twse_stocks(df_clean):
                margin_frames.append(df_clean)
                save_status(target_date, {"margin_twse": True})
                changed = True
                logger.info(f"  ✅ 上市融資券 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上市融資券回傳無上市股票，跳過")
        else:
            logger.warning("  ⚠️  上市融資券 API 回傳空")
    else:
        logger.info("  [Skip] 上市融資券已存在")

    # 上櫃融資券
    if not status["margin_tpex"]:
        logger.info(f"[Phase1] 抓取上櫃融資券 ({target_date})...")
        df = fetch_tpex_margin_trading(target_date)
        if df is not None and not df.empty:
            df_clean = standardize_dataframe(df)
            if _has_tpex_stocks(df_clean):
                margin_frames.append(df_clean)
                save_status(target_date, {"margin_tpex": True})
                changed = True
                logger.info(f"  ✅ 上櫃融資券 {len(df_clean)} 筆")
            else:
                logger.warning("  ⚠️  上櫃融資券回傳無上櫃股票，跳過")
        else:
            logger.warning("  ⚠️  上櫃融資券 API 回傳空")
    else:
        logger.info("  [Skip] 上櫃融資券已存在")

    # 合併並儲存融資券
    if margin_frames:
        df_margin = pd.concat(margin_frames, ignore_index=True)
        df_margin = _merge_with_existing(df_margin, "daily_margin", target_date)
        if not df_margin.empty:
            save_dataframe(df_margin, "daily_margin", target_date)
    else:
        if not status["margin_twse"] and not status["margin_tpex"]:
            logger.warning("  ⚠️  融資券無資料（上市與上櫃皆失敗），跳過。")

    # ── 4. TDCC 集保股權分散表（輕量探測去重）──
    from quant_system_v2.crawler.market_crawler import check_tdcc_latest_date
    logger.info("[Phase1] 探測 TDCC 集保最新日期...")
    try:
        tdcc_date = check_tdcc_latest_date()
        if tdcc_date is None:
            logger.warning("  ⚠️  TDCC 集保日期探測失敗，跳過。")
        else:
            existing = load_dataframe("weekly_tdcc", tdcc_date)
            if not existing.empty:
                logger.info(f"  [Skip] 集保資料 (日期: {tdcc_date}) 已存在，跳過寫入。")
            else:
                logger.info(f"  [Phase1] 下載 TDCC 集保完整資料 ({tdcc_date})...")
                df_tdcc = fetch_tdcc_distribution()
                if df_tdcc is not None and not df_tdcc.empty:
                    save_dataframe(df_tdcc, "weekly_tdcc", tdcc_date)
                    logger.info(f"  ✅ 集保資料已儲存 ({len(df_tdcc)} 列, 日期={tdcc_date})")

                    # 集保驅動區域回溯
                    from quant_system_v2.api.tdcc_backfill import trigger_tdcc_backfill
                    updated = trigger_tdcc_backfill(tdcc_date)
                    logger.info(f"  ✅ 集保驅動 Dashboard 回溯: {updated} 個日期已更新")
                else:
                    logger.warning("  ⚠️  TDCC 集保完整下載失敗，跳過。")

            # 更新 status 中的 tdcc_date（不管是否新寫入，只要有最新日期就記錄）
            save_status(target_date, {"tdcc_date": tdcc_date})
            if not status.get("tdcc_date"):
                changed = True
    except Exception as e:
        logger.error(f"  ❌ TDCC 集保處理異常: {e}", exc_info=True)

    return changed


# ==========================================
# Phase 2：Core → API Export
# ==========================================


def _phase2_export(target_date: str) -> None:
    """執行 Phase 2：核心運算 → JSON Dashboard 匯出"""
    logger.info(f"[Phase2] 核心運算與 JSON 匯出 ({target_date})...")

    # 不傳 output_dir，由 export_dashboard_json_safe 自行解析
    result_path = export_dashboard_json_safe(target_date)
    if result_path:
        logger.info(f"  ✅ Dashboard JSON: {result_path}")
        save_status(target_date, {"dashboard": True})
    else:
        logger.error("  ❌ Dashboard JSON 匯出失敗。")


def _phase3_stock_update(target_date: str) -> None:
    """執行 Phase 3：個股歷史 JSON 每日增量更新"""
    logger.info(f"[Phase3] 個股歷史 JSON 增量更新 ({target_date})...")
    try:
        from quant_system_v2.api.stock_api import update_daily
        updated = update_daily(target_date)
        logger.info(f"  ✅ 個股 JSON 更新完成: {updated} 檔")
    except Exception as e:
        logger.error(f"  ❌ 個股 JSON 更新失敗: {e}", exc_info=True)


# ==========================================
# Main
# ==========================================


def main() -> None:
    args = parse_args()

    # 設定 logging 格式（若尚未設定）
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info(f"{'='*50}")
    logger.info(f"  V2 系統主控台啟動")
    logger.info(f"{'='*50}")
    logger.info("")

    # ── Step 0: 決定 target_date ──
    if args.date:
        target_date = args.date.replace("-", "")
        logger.info(f"[Step 0] 手動指定日期: {target_date}")
    else:
        logger.info("[Step 0] 透過指針 API 取得最新交易日...")
        target_date = fetch_market_date()
        if target_date is None:
            logger.info("  今日官方尚未放榜或休市，優雅退出。")
            sys.exit(0)
        logger.info(f"[Step 0] 指針 API 回傳: {target_date}")

    logger.info(f"  目標日期: {target_date}")
    logger.info("")

    # ── Step 1: 載入當前狀態 ──
    status = load_status(target_date)
    logger.info(f"[Step 1] 載入狀態: price_twse={status['price_twse']}, "
                f"price_tpex={status['price_tpex']}, "
                f"chip_twse={status['chip_twse']}, chip_tpex={status['chip_tpex']}, "
                f"margin_twse={status['margin_twse']}, margin_tpex={status['margin_tpex']}, "
                f"tdcc_date={status.get('tdcc_date', '')}, "
                f"dashboard={status['dashboard']}")
    logger.info("")

    # ── Step 2: Phase 1 漸進爬取 ──
    logger.info("=== Phase 1: 漸進爬取（Status-Driven）===")
    logger.info("")
    changed = _phase1_crawl(target_date)
    logger.info("")

    # ── Step 3: 熔斷判斷 ──
    final_status = load_status(target_date)
    has_price = final_status["price_twse"] or final_status["price_tpex"]

    if not changed and final_status["dashboard"] and has_price:
        logger.info("=== 熔斷：無新資料來源，Dashboard 已存在，跳過 Phase 2 ===")
        logger.info("")
        logger.info(f"{'='*50}")
        logger.info("  ✅ 所有流程執行完畢（熔斷跳過）")
        logger.info(f"{'='*50}")
        return

    if not has_price:
        logger.warning("  ⚠️  無任何價量資料，無法產出 Dashboard JSON")
        logger.info("")
        logger.info(f"{'='*50}")
        logger.info("  ⚠️  執行完畢（無價量資料）")
        logger.info(f"{'='*50}")
        return

    # ── Step 4: Phase 2 強制匯出 ──
    logger.info("=== Phase 2: Core & API Export ===")
    logger.info("")
    _phase2_export(target_date)
    logger.info("")

    # ── Step 5: Phase 3 個股歷史 JSON 增量更新 ──
    logger.info("=== Phase 3: 個股歷史 JSON 增量更新 ===")
    logger.info("")
    _phase3_stock_update(target_date)
    logger.info("")

    logger.info(f"{'='*50}")
    logger.info(f"  ✅ 所有流程執行完畢")
    logger.info(f"{'='*50}")


if __name__ == "__main__":
    main()