"""
全量歷史回溯腳本 - 重新爬取所有歷史交易日的上市櫃資料並重新產出 Dashboard JSON

用法：
    python -m quant_system_v2.backfill_all                 # 從 2026-05-02 到昨日
    python -m quant_system_v2.backfill_all --start 20260501  # 指定起始日
    python -m quant_system_v2.backfill_all --end 20260711    # 指定結束日
    python -m quant_system_v2.backfill_all --dry-run         # 僅列出將處理的日期
"""

import argparse
import logging
import sys
import os
from datetime import datetime, timedelta

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import pandas as pd

from quant_system_v2.crawler.market_crawler import (
    fetch_twse_daily_quotes, fetch_tpex_daily_quotes,
    fetch_twse_institutional, fetch_tpex_institutional,
    fetch_twse_margin_trading, fetch_tpex_margin_trading,
    fetch_tdcc_distribution,
)
from quant_system_v2.database.transform import standardize_dataframe
from quant_system_v2.database.storage import save_dataframe, load_dataframe
from quant_system_v2.api.export_json import export_dashboard_json_safe

logger = logging.getLogger("quant_system_v2.backfill_all")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="全量歷史回溯：爬取上市櫃資料並產出 Dashboard JSON"
    )
    parser.add_argument("--start", type=str, default="20260502", help="起始日 YYYYMMDD")
    parser.add_argument("--end", type=str, default=None, help="結束日 YYYYMMDD (含)，預設為昨日")
    parser.add_argument("--dry-run", action="store_true", help="僅列出日期，不執行爬蟲")
    return parser.parse_args()


def _generate_date_range(start_str: str, end_str: str):
    """產生日期字串列表 YYYYMMDD"""
    start = datetime.strptime(start_str, "%Y%m%d")
    end = datetime.strptime(end_str, "%Y%m%d")
    dates = []
    current = start
    while current <= end:
        dates.append(current.strftime("%Y%m%d"))
        current += timedelta(days=1)
    return dates


def _crawl_and_save(target_date: str) -> dict:
    """爬取單日上市櫃資料並儲存為 Parquet，回傳各表筆數統計"""
    stats = {}

    # ── 1. 價量（上市 + 上櫃）──
    df_twse_price = fetch_twse_daily_quotes(target_date)
    df_tpex_price = fetch_tpex_daily_quotes(target_date)
    # 先各自 standardize 統一英文欄位，避免 concat 時出現重複欄位
    price_frames = []
    if df_twse_price is not None and not df_twse_price.empty:
        price_frames.append(standardize_dataframe(df_twse_price))
    if df_tpex_price is not None and not df_tpex_price.empty:
        price_frames.append(standardize_dataframe(df_tpex_price))
    if price_frames:
        df_price = pd.concat(price_frames, ignore_index=True)
        save_dataframe(df_price, "daily_price", target_date)
        stats["price"] = len(df_price)
    else:
        stats["price"] = 0

    # ── 2. 法人買賣超（上市 + 上櫃） ──
    chip_frames = []
    for raw_df in [fetch_twse_institutional(target_date), fetch_tpex_institutional(target_date)]:
        if raw_df is not None and not raw_df.empty:
            chip_frames.append(standardize_dataframe(raw_df))
    if chip_frames:
        df_chip = pd.concat(chip_frames, ignore_index=True)
        save_dataframe(df_chip, "daily_chip", target_date)
        stats["chip"] = len(df_chip)
    else:
        stats["chip"] = 0

    # ── 3. 融資融券（上市 + 上櫃） ──
    margin_frames = []
    for raw_df in [fetch_twse_margin_trading(target_date), fetch_tpex_margin_trading(target_date)]:
        if raw_df is not None and not raw_df.empty:
            margin_frames.append(standardize_dataframe(raw_df))
    if margin_frames:
        df_margin = pd.concat(margin_frames, ignore_index=True)
        save_dataframe(df_margin, "daily_margin", target_date)
        stats["margin"] = len(df_margin)
    else:
        stats["margin"] = 0

    return stats


def main() -> None:
    args = parse_args()
    end_str = args.end or (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
    dates = _generate_date_range(args.start, end_str)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info(f"日期範圍: {args.start} ~ {end_str}，共 {len(dates)} 個交易日")

    if args.dry_run:
        logger.info(f"[乾執行] 將處理以下日期:")
        for d in dates:
            logger.info(f"  {d}")
        return

    # TDCC 集保先爬一次（只存最新一期）
    logger.info("爬取 TDCC 集保資料...")
    try:
        df_tdcc = fetch_tdcc_distribution()
        if df_tdcc is not None and not df_tdcc.empty:
            tdcc_date = str(df_tdcc["日期"].iloc[0]).strip()
            existing = load_dataframe("weekly_tdcc", tdcc_date)
            if existing.empty:
                save_dataframe(df_tdcc, "weekly_tdcc", tdcc_date)
                logger.info(f"  集保資料已儲存 (日期={tdcc_date})")
            else:
                logger.info(f"  集保資料 (日期={tdcc_date}) 已存在，跳過")
    except Exception as e:
        logger.error(f"  TDCC 爬取失敗: {e}")

    # 逐日回溯
    success_count = 0
    fail_count = 0
    for i, d in enumerate(dates):
        logger.info(f"[{i+1}/{len(dates)}] 處理 {d}...")
        try:
            stats = _crawl_and_save(d)
            logger.info(f"  價量={stats['price']}, 法人={stats['chip']}, 資券={stats['margin']}")

            # 若有價量資料則產出 Dashboard JSON
            if stats["price"] > 0:
                path = export_dashboard_json_safe(d, history_max_date=d)
                if path:
                    logger.info(f"  Dashboard: {path}")
                else:
                    logger.warning(f"  Dashboard 產出失敗（可能無價量）")
            else:
                logger.warning(f"  無價量資料，跳過 Dashboard 產出")

            success_count += 1
        except Exception as e:
            logger.error(f"  [{d}] 處理異常: {e}", exc_info=True)
            fail_count += 1

    logger.info(f"=== 回溯完成: 成功 {success_count}, 失敗 {fail_count} ===")


if __name__ == "__main__":
    main()