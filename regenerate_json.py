"""
歷史 JSON API Backfill 腳本

用途：
  當 filters.py 或其他 Core 層邏輯修正後，直接讀取現有 Parquet 歷史資料，
  重新計算所有歷史 Dashboard JSON 檔案。

運作方式：
  1. 掃描 daily_chip / daily_price / daily_margin 目錄，取三表交集日期
  2. 按時間順序（舊→新）遍歷，對每個日期呼叫 export_dashboard_json_safe()
  3. 自動刷新 latest.json + dates.json

執行方式：
  python3 -m quant_system_v2.regenerate_json
"""

import glob
import logging
import os
import sys
from pathlib import Path

# 確保專案根目錄在 sys.path 中（讓 `python3 -m` 可正常載入）
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

_pkg_root = os.path.dirname(os.path.abspath(__file__))  # quant_system_v2/

from quant_system_v2.api.export_json import (
    export_dashboard_json_safe,
    _write_static_api_files,
)
from quant_system_v2.config.settings import DATA_DIR

logger = logging.getLogger(__name__)


def _setup_logging() -> None:
    """設定控制台輸出格式"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def _get_parquet_dates(table_name: str) -> set[str]:
    """掃描指定 table 的 Parquet 目錄，回傳所有日期字串集合"""
    table_dir = os.path.join(_pkg_root, DATA_DIR, "parquet", table_name)
    if not os.path.isdir(table_dir):
        logger.warning(f"目錄不存在: {table_dir}")
        return set()
    return {Path(f).stem for f in glob.glob(os.path.join(table_dir, "*.parquet"))}


def main() -> None:
    _setup_logging()

    logger.info("=" * 55)
    logger.info("  歷史 JSON Backfill 啟動")
    logger.info("=" * 55)
    logger.info("")

    # ──────────────────────────────────────────
    # 1. 掃描三表，取交集日期
    # ──────────────────────────────────────────
    chip_dates = _get_parquet_dates("daily_chip")
    price_dates = _get_parquet_dates("daily_price")
    margin_dates = _get_parquet_dates("daily_margin")

    common_dates = sorted(chip_dates & price_dates & margin_dates)

    logger.info(f"daily_chip:   {len(chip_dates)} 個日期")
    logger.info(f"daily_price:  {len(price_dates)} 個日期")
    logger.info(f"daily_margin: {len(margin_dates)} 個日期")
    logger.info(f"三表交集:     {len(common_dates)} 個日期")
    logger.info(f"日期範圍: {common_dates[0]} ~ {common_dates[-1]}")
    logger.info("")

    if not common_dates:
        logger.error("無任何可處理的日期，結束")
        sys.exit(1)

    # ──────────────────────────────────────────
    # 2. 依序重算（舊 → 新）
    # ──────────────────────────────────────────
    success_count = 0
    fail_count = 0

    for idx, date_str in enumerate(common_dates, 1):
        logger.info(f"[{idx:2d}/{len(common_dates)}] 重算 {date_str} ...")
        try:
            # 傳遞 history_max_date=date_str，確保 streak/surge 指標只看目標日期以前的資料
            result_path = export_dashboard_json_safe(date_str, history_max_date=date_str)
            if result_path:
                success_count += 1
                logger.info(f"  ✅ {result_path}")
            else:
                fail_count += 1
                logger.warning(f"  ⚠️  回傳空路徑，可能全部指標失敗")
        except Exception as e:
            fail_count += 1
            logger.error(f"  ❌ 異常: {e}")

    # ──────────────────────────────────────────
    # 3. 最終刷新 Static API 檔案
    # ──────────────────────────────────────────
    logger.info("")
    logger.info("─" * 40)
    logger.info("刷新 Static API 索引檔案 ...")

    latest_date = common_dates[-1]
    # 使用 export_dashboard_json_safe 內建的預設路徑解析邏輯
    # _pkg_root = quant_system_v2/ → output = _pkg_root/../web/api ❌
    # 正確路徑: _pkg_root/web/api/
    output_dir = os.path.join(_pkg_root, "web", "api")
    _write_static_api_files(output_dir, latest_date)

    # ──────────────────────────────────────────
    # 4. 總結
    # ──────────────────────────────────────────
    logger.info("")
    logger.info("=" * 55)
    logger.info(f"  ✅ Backfill 完成")
    logger.info(f"     成功: {success_count}  /  失敗: {fail_count}")
    logger.info(f"     latest.json → {latest_date}")
    logger.info("=" * 55)


if __name__ == "__main__":
    main()