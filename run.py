"""
V2 系統主控台 — 每日排程執行入口

用法：
    python -m quant_system_v2.run                   # 預設：今日日期
    python -m quant_system_v2.run --date 20260709   # 手動指定日期

流程：
    Phase 1: Crawler → Transform → Storage
      - 上市價量 (daily_price)
      - 上市法人買賣超 (daily_chip)
      - 上市融資融券 (daily_margin)
      - TDCC 集保股權分散表 (weekly_tdcc, 去重寫入)

    Phase 2: Core → API Export
      - 執行核心運算 → 匯出 Dashboard JSON
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

logger = logging.getLogger("quant_system_v2.run")

# ==========================================
# 參數解析
# ==========================================


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="V2 系統主控台 — 每日資料爬取、儲存與 Dashboard 匯出"
    )
    parser.add_argument(
        "--date",
        type=str,
        default=datetime.today().strftime("%Y%m%d"),
        help="目標日期 (YYYYMMDD)，預設為今日",
    )
    return parser.parse_args()


# ==========================================
# Phase 1：Crawler → Transform → Storage
# ==========================================


def _phase1_crawl(target_date: str) -> None:
    """執行 Phase 1：爬取四大資料源並儲存為 Parquet"""

    # ── 1. 價量（上市 + 上櫃）──
    logger.info(f"[Phase1] 抓取上市價量 ({target_date})...")
    df_twse_price = fetch_twse_daily_quotes(target_date)
    logger.info(f"[Phase1] 抓取上櫃價量 ({target_date})...")
    df_tpex_price = fetch_tpex_daily_quotes(target_date)

    # 先各自 standardize 統一英文欄位，避免 concat 時出現重複欄位
    price_frames = []
    twse_price_count = 0
    tpex_price_count = 0
    if df_twse_price is not None and not df_twse_price.empty:
        df_twse_price_clean = standardize_dataframe(df_twse_price)
        twse_price_count = len(df_twse_price_clean)
        price_frames.append(df_twse_price_clean)
    if df_tpex_price is not None and not df_tpex_price.empty:
        df_tpex_price_clean = standardize_dataframe(df_tpex_price)
        tpex_price_count = len(df_tpex_price_clean)
        price_frames.append(df_tpex_price_clean)

    if price_frames:
        df_price = pd.concat(price_frames, ignore_index=True)
        save_dataframe(df_price, "daily_price", target_date)
        logger.info(f"  ✅ 價量已儲存 ({len(df_price)} 列, 上市={twse_price_count}, 上櫃={tpex_price_count})")
    else:
        logger.warning("  ⚠️  價量無資料（上市與上櫃皆失敗），跳過。")

    # ── 2. 法人買賣超（上市 + 上櫃）──
    logger.info(f"[Phase1] 抓取上市法人買賣超 ({target_date})...")
    df_twse_chip_raw = fetch_twse_institutional(target_date)
    logger.info(f"[Phase1] 抓取上櫃法人買賣超 ({target_date})...")
    df_tpex_chip_raw = fetch_tpex_institutional(target_date)

    # 先各自 standardize 統一英文欄位，避免 TWSE/TPEx 中文欄位名稱不一致造成 concat 衝突
    chip_frames = []
    twse_chip_count = 0
    tpex_chip_count = 0
    if df_twse_chip_raw is not None and not df_twse_chip_raw.empty:
        df_twse_chip_clean = standardize_dataframe(df_twse_chip_raw)
        twse_chip_count = len(df_twse_chip_clean)
        chip_frames.append(df_twse_chip_clean)
    if df_tpex_chip_raw is not None and not df_tpex_chip_raw.empty:
        df_tpex_chip_clean = standardize_dataframe(df_tpex_chip_raw)
        tpex_chip_count = len(df_tpex_chip_clean)
        chip_frames.append(df_tpex_chip_clean)

    if chip_frames:
        df_chip = pd.concat(chip_frames, ignore_index=True)
        save_dataframe(df_chip, "daily_chip", target_date)
        logger.info(f"  ✅ 法人已儲存 ({len(df_chip)} 列, 上市={twse_chip_count}, 上櫃={tpex_chip_count})")
    else:
        logger.warning("  ⚠️  法人無資料（上市與上櫃皆失敗），跳過。")

    # ── 3. 融資融券（上市 + 上櫃）──
    logger.info(f"[Phase1] 抓取上市融資券 ({target_date})...")
    df_twse_margin_raw = fetch_twse_margin_trading(target_date)
    logger.info(f"[Phase1] 抓取上櫃融資券 ({target_date})...")
    df_tpex_margin_raw = fetch_tpex_margin_trading(target_date)

    margin_frames = []
    twse_margin_count = 0
    tpex_margin_count = 0
    if df_twse_margin_raw is not None and not df_twse_margin_raw.empty:
        df_twse_margin_clean = standardize_dataframe(df_twse_margin_raw)
        twse_margin_count = len(df_twse_margin_clean)
        margin_frames.append(df_twse_margin_clean)
    if df_tpex_margin_raw is not None and not df_tpex_margin_raw.empty:
        df_tpex_margin_clean = standardize_dataframe(df_tpex_margin_raw)
        tpex_margin_count = len(df_tpex_margin_clean)
        margin_frames.append(df_tpex_margin_clean)

    if margin_frames:
        df_margin = pd.concat(margin_frames, ignore_index=True)
        save_dataframe(df_margin, "daily_margin", target_date)
        logger.info(f"  ✅ 融資券已儲存 ({len(df_margin)} 列, 上市={twse_margin_count}, 上櫃={tpex_margin_count})")
    else:
        logger.warning("  ⚠️  融資券無資料（上市與上櫃皆失敗），跳過。")

    # ── 4. TDCC 集保股權分散表（去重寫入） ──
    logger.info("[Phase1] 抓取 TDCC 集保資料（最新快照）...")
    try:
        df_tdcc = fetch_tdcc_distribution()
        if df_tdcc is not None and not df_tdcc.empty:
            tdcc_date = str(df_tdcc["日期"].iloc[0]).strip()

            # 檢查是否已存在（避免重複寫入）
            existing = load_dataframe("weekly_tdcc", tdcc_date)
            if not existing.empty:
                logger.info(
                    f"  [Skip] 集保資料 (日期: {tdcc_date}) 已存在，跳過寫入。"
                )
            else:
                # TDCC 中文欄位直接儲存，無需 standardize
                save_dataframe(df_tdcc, "weekly_tdcc", tdcc_date)
                logger.info(f"  ✅ 集保資料已儲存 ({len(df_tdcc)} 列, 日期={tdcc_date})")

                # 集保驅動區域回溯：重算所有 >= tdcc_date 的 Dashboard JSON
                from quant_system_v2.api.tdcc_backfill import trigger_tdcc_backfill
                updated = trigger_tdcc_backfill(tdcc_date)
                logger.info(f"  ✅ 集保驅動 Dashboard 回溯: {updated} 個日期已更新")
        else:
            logger.warning("  ⚠️  TDCC 集保資料抓取失敗（回傳空），跳過。")
    except Exception as e:
        logger.error(f"  ❌ TDCC 集保處理異常: {e}", exc_info=True)


# ==========================================
# Phase 2：Core → API Export
# ==========================================


def _phase2_export(target_date: str) -> None:
    """執行 Phase 2：核心運算 → JSON Dashboard 匯出"""
    logger.info(f"[Phase2] 核心運算與 JSON 匯出 ({target_date})...")

    # 不傳 output_dir，由 export_dashboard_json_safe 自行解析
    # 預設為 quant_system_v2/data/dashboard/
    result_path = export_dashboard_json_safe(target_date)
    if result_path:
        logger.info(f"  ✅ Dashboard JSON: {result_path}")
    else:
        logger.error("  ❌ Dashboard JSON 匯出失敗。")


# ==========================================
# Main
# ==========================================


def main() -> None:
    args = parse_args()
    target_date = args.date.replace("-", "")

    # 設定 logging 格式（若尚未設定）
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info(f"{'='*50}")
    logger.info(f"  V2 系統主控台啟動 — 目標日期: {target_date}")
    logger.info(f"{'='*50}")
    logger.info("")

    # ── Phase 1 ──
    logger.info("=== Phase 1: Crawler & Transform & Storage ===")
    logger.info("")
    _phase1_crawl(target_date)
    logger.info("")

    # ── Phase 2 ──
    logger.info("=== Phase 2: Core & API Export ===")
    logger.info("")
    _phase2_export(target_date)
    logger.info("")

    logger.info(f"{'='*50}")
    logger.info("  ✅ 所有流程執行完畢")
    logger.info(f"{'='*50}")


if __name__ == "__main__":
    main()