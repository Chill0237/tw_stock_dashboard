"""
集保驅動的區域 Dashboard 回溯管線

職責範圍：
  當新的 TDCC 集保 Parquet 寫入後，自動找出所有受影響的交易日，
  重新計算 Dashboard JSON，並刷新 latest.json / dates.json。

觸發時機：
  - run.py Phase 1：爬蟲儲存新的週集保資料後
  - convert_history_tdcc.py：歷史 CSV 轉 Parquet 完成後

防呆設計：
  - 若無任何受影響的 daily_price 日期，直接回傳 0
  - 每個交易日只重算一次（Idempotent，覆蓋原有 JSON）
  - 全域索引（latest.json / dates.json）更新由 _write_static_api_files 處理
"""

import glob
import logging
import os
from pathlib import Path
from typing import Optional

from quant_system_v2.api.export_json import (
    export_dashboard_json_safe,
    _write_static_api_files,
)
from quant_system_v2.utils.status_tracker import save_status

logger = logging.getLogger(__name__)


def trigger_tdcc_backfill(tdcc_date_str: str) -> int:
    """
    集保驅動的區域 Dashboard 回溯管線。

    當新的集保資料寫入時，找出所有 >= tdcc_date_str 的 daily_price 交易日，
    依序重新計算 Dashboard JSON，最後刷新 latest.json + dates.json。

    Args:
        tdcc_date_str: 新寫入的集保日期 (YYYYMMDD)

    Returns:
        成功重算的日期數量
    """
    pkg_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # ──────────────────────────────────────────
    # 1. 掃描 daily_price，找出所有 >= tdcc_date_str 的日期
    # ──────────────────────────────────────────
    pattern = os.path.join(pkg_root, "data", "parquet", "daily_price", "*.parquet")
    all_files = sorted(glob.glob(pattern))
    all_dates = sorted({Path(f).stem for f in all_files})

    affected = [d for d in all_dates if d >= tdcc_date_str]

    if not affected:
        logger.info(f"[tdcc_backfill] 集保 {tdcc_date_str} → 無受影響的交易日")
        return 0

    logger.info(
        f"[tdcc_backfill] 集保 {tdcc_date_str} → "
        f"影響 {len(affected)} 個交易日 "
        f"({affected[0]} ~ {affected[-1]})"
    )

    # ──────────────────────────────────────────
    # 2. 依序重算（舊→新）
    # ──────────────────────────────────────────
    count = 0
    for date_str in affected:
        try:
            result = export_dashboard_json_safe(
                date_str, history_max_date=date_str
            )
            if result:
                # 同步更新 status.json：此日期的 tdcc_date 已可用
                save_status(date_str, {"tdcc_date": tdcc_date_str})
                count += 1
        except Exception as e:
            logger.error(
                f"[tdcc_backfill] {date_str} 重算失敗: {e}", exc_info=True
            )
            continue

    # ──────────────────────────────────────────
    # 3. 全域索引刷新
    # ──────────────────────────────────────────
    output_dir = os.path.join(pkg_root, "web", "api")
    _write_static_api_files(output_dir, affected[-1])

    logger.info(
        f"[tdcc_backfill] ✅ 集保驅動回溯完成: "
        f"{count}/{len(affected)} 個日期已更新"
    )
    return count