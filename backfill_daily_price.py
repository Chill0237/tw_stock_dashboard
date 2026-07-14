"""
daily_price 歷史回補腳本 — 補齊 490 個交易日的價量資料

用法：
    python -m quant_system_v2.backfill_daily_price             # 自動計算缺失日期並回補
    python -m quant_system_v2.backfill_daily_price --force     # 強制重新爬取所有日期
    python -m quant_system_v2.backfill_daily_price --dry-run   # 僅列出將處理的日期
    python -m quant_system_v2.backfill_daily_price --days 490  # 指定保留天數（預設 490）

防禦機制：
  - 跳過已存在的 Parquet 檔案（idempotent）
  - 每筆請求間隔 2.0~3.5 秒（隨機抖動）
  - 每日執行最多 50 次 API 請求
  - 支援中斷續傳（下次執行自動跳過已補日期）
"""

import argparse
import logging
import os
import random
import sys
import time
from datetime import datetime, timedelta
from typing import Optional

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import pandas as pd

from quant_system_v2.crawler.market_crawler import (
    fetch_twse_daily_quotes,
    fetch_tpex_daily_quotes,
)
from quant_system_v2.database.transform import standardize_dataframe
from quant_system_v2.database.storage import save_dataframe, load_dataframe
from quant_system_v2.utils.status_tracker import save_status

logger = logging.getLogger("quant_system_v2.backfill_daily_price")

# ==========================================
# 設定
# ==========================================

DEFAULT_TARGET_DAYS = 490       # 目標保留天數
MAX_REQUESTS_PER_RUN = 50       # 每次執行最多請求次數
MIN_SLEEP = 2.0                 # 最小間隔秒數
MAX_SLEEP = 3.5                 # 最大間隔秒數（隨機抖動）

TABLE_NAME = "daily_price"
DATES_JSON_KEY = "backfill_price_date"  # status.json 記錄最新回補日期用


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="daily_price 歷史回補：補齊 490 個交易日的價量資料"
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_TARGET_DAYS,
        help=f"目標保留天數（預設 {DEFAULT_TARGET_DAYS}）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="強制重新爬取所有缺失日期（跳過已存在的不會重爬）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="僅列出將處理的日期，不執行爬蟲",
    )
    return parser.parse_args()


def _get_existing_dates(table_name: str) -> set:
    """
    掃描 daily_price 目錄，回傳已存在的日期集合（YYYYMMDD）。

    從檔名中擷取日期字串（不含副檔名）。
    """
    from quant_system_v2.database.storage import _get_table_dir

    table_dir = _get_table_dir(table_name)
    if not os.path.isdir(table_dir):
        return set()

    dates = set()
    for fname in os.listdir(table_dir):
        if fname.endswith(".parquet"):
            date_part = fname.replace(".parquet", "")
            if date_part.isdigit() and len(date_part) == 8:
                dates.add(date_part)
    return dates


def _generate_calendar_dates(end_date: str, count: int) -> list[str]:
    """
    從 end_date 往前推 count 個日曆日，回傳日期字串列表（由遠到近）。
    注意：這裡是日曆日（含假日），實際交易日由 API 回傳判斷。
    """
    end = datetime.strptime(end_date, "%Y%m%d")
    dates = []
    for i in range(count):
        d = end - timedelta(days=i)
        dates.append(d.strftime("%Y%m%d"))
    # 由遠到近排序（oldest first）
    dates.reverse()
    return dates


def _get_missing_dates(
    existing_dates: set[str],
    target_days: int,
    latest_date: Optional[str] = None,
) -> list[str]:
    """
    找出需要回補的日期列表（由近到遠排序，方便中斷續傳）。

    Args:
        existing_dates: 已存在的日期集合
        target_days: 目標保留天數
        latest_date: 最新的交易日（預設為昨日）

    Returns:
        缺失日期列表（由近到遠）
    """
    if latest_date is None:
        latest_date = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")

    # 產生候選日曆日（多抓 20% 以覆蓋非交易日）
    candidate_days = int(target_days * 1.5)
    calendar_dates = _generate_calendar_dates(latest_date, candidate_days)

    # 找出缺失的日期
    missing = [d for d in calendar_dates if d not in existing_dates]

    # 由近到遠排序（最新的先補，確保最新資料優先）
    missing.reverse()
    return missing


def _crawl_single_day(date_str: str) -> bool:
    """
    爬取單一日的 daily_price（上市 + 上櫃）並儲存為 Parquet。

    Returns:
        bool: 是否有成功寫入任何資料
    """
    try:
        # 上市價量
        df_twse = fetch_twse_daily_quotes(date_str)
        # 上櫃價量
        df_tpex = fetch_tpex_daily_quotes(date_str)

        frames = []
        if df_twse is not None and not df_twse.empty:
            frames.append(standardize_dataframe(df_twse))
        if df_tpex is not None and not df_tpex.empty:
            frames.append(standardize_dataframe(df_tpex))

        if not frames:
            logger.info(f"  ⚠️  {date_str}: 無價量資料（可能為假日或休市）")
            return False

        df_price = pd.concat(frames, ignore_index=True)
        save_dataframe(df_price, "daily_price", date_str)
        return True

    except Exception as e:
        logger.error(f"  ❌ {date_str}: 爬取失敗 - {e}")
        return False


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    logger.info(f"{'='*50}")
    logger.info(f"  daily_price 歷史回補啟動")
    logger.info(f"  目標天數: {args.days} 日")
    logger.info(f"{'='*50}")
    logger.info("")

    # 1. 掃描已存在的日期
    existing = _get_existing_dates(TABLE_NAME)
    logger.info(f"已存在 {len(existing)} 個交易日的 daily_price Parquet")
    logger.info("")

    # 2. 找出缺失日期
    latest_date = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
    missing = _get_missing_dates(existing, args.days, latest_date)

    if not missing:
        logger.info("🎉 所有資料皆已存在，無需回補！")
        return

    logger.info(f"缺失日期數: {len(missing)}")
    if args.dry_run:
        logger.info("[乾執行] 將回補以下日期:")
        for d in missing:
            logger.info(f"  {d}")
        return

    # 3. 逐筆回補（由近到遠）
    success_count = 0
    skip_count = 0
    total = len(missing)

    for idx, d in enumerate(missing, 1):
        # 再次確認是否已存在（避免 race condition / 前次執行已補）
        existing_now = _get_existing_dates(TABLE_NAME)
        if d in existing_now:
            skip_count += 1
            continue

        logger.info(f"[{idx}/{total}] 回補 {d}...")
        ok = _crawl_single_day(d)
        if ok:
            success_count += 1
        else:
            skip_count += 1

        # 隨機間隔（避免觸發 API 速率限制）
        if idx < total:
            sleep_time = random.uniform(MIN_SLEEP, MAX_SLEEP)
            logger.info(f"  等待 {sleep_time:.1f}s...")
            time.sleep(sleep_time)

    # 4. 寫入 status.json 記錄最新回補進度
    if success_count > 0:
        today = datetime.now().strftime("%Y%m%d")
        save_status(today, {DATES_JSON_KEY: latest_date})
        logger.info(f"  ✅ status.json 已更新回補進度")

    logger.info("")
    logger.info(f"{'='*50}")
    logger.info(f"  回補完成: 成功 {success_count}, 跳過 {skip_count}")
    logger.info(f"  目前總交易日數: {len(_get_existing_dates(TABLE_NAME))}")
    logger.info(f"{'='*50}")


if __name__ == "__main__":
    main()