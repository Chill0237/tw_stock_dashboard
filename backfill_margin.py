"""
專用腳本：只重抓融資券 margin 資料 + 重生成所有 JSON 產物

此腳本：
- 讀取現有 daily_margin Parquet 取得日期清單
- 重新呼叫 TWSE / TPEx 融資券 API
- 經 schema standardize 後覆寫 Parquet 儲存
- 重新跑 Phase2 (export dashboard JSON) 及 Phase3 (個股 JSON)
"""

import logging
import os
import sys
from typing import List

import pandas as pd

# 確保專案根目錄在 sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from quant_system_v2.crawler.market_crawler import (
    fetch_twse_margin_trading,
    fetch_tpex_margin_trading,
)
from quant_system_v2.config.schema import standardize_dataframe
from quant_system_v2.database.storage import save_dataframe
from quant_system_v2.api.export_json import export_dashboard_json_safe
from quant_system_v2.api.stock_api import update_daily

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def _list_margin_dates(parquet_dir: str) -> List[str]:
    """列出 daily_margin 目錄中的日期（YYMMDD），由檔案名推斷"""
    if not os.path.isdir(parquet_dir):
        logger.warning(f"目錄不存在：{parquet_dir}")
        return []
    dates = []
    for fname in os.listdir(parquet_dir):
        if fname.endswith(".parquet"):
            # 檔名格式如 20260724.parquet
            d = fname.replace(".parquet", "")
            if len(d) == 8 and d.isdigit():
                dates.append(d)
    dates.sort()
    return dates


def backfill_margin(date: str) -> bool:
    """
    對指定日期重抓 margin 並寫入 Parquet。
    Returns: True 表示至少有一組合併寫入。
    """
    margin_frames = []

    # 上市
    df_twse = fetch_twse_margin_trading(date)
    if df_twse is not None and not df_twse.empty:
        df_twse = standardize_dataframe(df_twse)
        # 簡單過濾：有 stock_id 即可
        if "stock_id" in df_twse.columns:
            margin_frames.append(df_twse)
            logger.info(f"  [{date}] TWSE margin: {len(df_twse)} 筆")
        else:
            logger.warning(f"  [{date}] TWSE margin 無有效資料")

    # 上櫃
    df_tpex = fetch_tpex_margin_trading(date)
    if df_tpex is not None and not df_tpex.empty:
        df_tpex = standardize_dataframe(df_tpex)
        if "stock_id" in df_tpex.columns:
            margin_frames.append(df_tpex)
            logger.info(f"  [{date}] TPEx margin: {len(df_tpex)} 筆")
        else:
            logger.warning(f"  [{date}] TPEx margin 無有效資料")

    if not margin_frames:
        logger.warning(f"  [{date}] 無 margin 資料，跳過")
        return False

    df_margin = pd.concat(margin_frames, ignore_index=True)
    save_dataframe(df_margin, "daily_margin", date)
    logger.info(f"  [{date}] 合併寫入 {len(df_margin)} 筆")
    return True


def main():
    project_root = os.path.dirname(os.path.abspath(__file__))
    parquet_dir = os.path.join(project_root, "data", "parquet", "daily_margin")
    dates = _list_margin_dates(parquet_dir)

    if not dates:
        logger.error("未找到任何 daily_margin Parquet 檔案。請先執行 run.py 至少一次。")
        return

    logger.info(f"將重抓 {len(dates)} 個日期的 margin 資料...")
    logger.info(f"日期範圍: {dates[0]} ~ {dates[-1]}")

    # ── Step 1: 重抓 margin 並覆寫 Parquet ──
    success_count = 0
    for d in dates:
        try:
            if backfill_margin(d):
                success_count += 1
        except Exception as e:
            logger.error(f"  [{d}] 處理失敗: {e}", exc_info=True)

    logger.info(f"Margin 重抓完成: {success_count}/{len(dates)} 日期成功")

    # ── Step 2: 重生成所有 JSON ──
    logger.info("開始重生成 Dashboard JSON + 個股 JSON ...")
    for d in dates:
        try:
            path = export_dashboard_json_safe(d)
            if path:
                logger.info(f"  [{d}] dashboard JSON: {path}")
            else:
                logger.error("  [{d}] dashboard JSON 失敗")
        except Exception as e:
            logger.error(f"  [{d}] dashboard JSON 異常: {e}")

        try:
            count = update_daily(d)
            logger.info(f"  [{d}] 個股 JSON 更新: {count} 檔")
        except Exception as e:
            logger.error(f"  [{d}] 個股 JSON 異常: {e}")

    logger.info("全部完成。")


if __name__ == "__main__":
    main()