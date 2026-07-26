"""
專用腳本：只重抓融資券 margin 資料 + 重生成所有 JSON 產物

此腳本分三階段，各自依賴本地實際存在的檔案：
  Step 1: 有 daily_margin/*.parquet → 重抓 TWSE/TPEx margin → 覆寫 parquet
  Step 2: 有 docs/api/dashboard_*.json → 重建 dashboard JSON
  Step 3: 全量重建個股 JSON（呼叫 generate_all）
"""

import logging
import os
import re
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
from quant_system_v2.api.stock_api import generate_all

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# Dashboard 檔案正則: dashboard_YYYYMMDD.json
_DASHBOARD_RE = re.compile(r"^dashboard_(\d{8})\.json$")


def _list_margin_dates(parquet_dir: str) -> List[str]:
    """列出 daily_margin 目錄中的日期（YYYYMMDD），由檔案名推斷"""
    if not os.path.isdir(parquet_dir):
        logger.warning(f"目錄不存在：{parquet_dir}")
        return []
    dates = []
    for fname in os.listdir(parquet_dir):
        if fname.endswith(".parquet"):
            d = fname.replace(".parquet", "")
            if len(d) == 8 and d.isdigit():
                dates.append(d)
    dates.sort()
    return dates


def _list_dashboard_dates(dashboard_dir: str) -> List[str]:
    """列出 docs/api/ 目錄中所有 dashboard_YYYYMMDD.json 的日期"""
    if not os.path.isdir(dashboard_dir):
        logger.warning(f"目錄不存在：{dashboard_dir}")
        return []
    dates = []
    for fname in os.listdir(dashboard_dir):
        m = _DASHBOARD_RE.match(fname)
        if m:
            dates.append(m.group(1))
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
    dashboard_dir = os.path.join(project_root, "docs", "api")

    # ── Step 1: 重抓 margin 並覆寫 Parquet（只針對有 .parquet 檔案的日期） ──
    margin_dates = _list_margin_dates(parquet_dir)
    if margin_dates:
        logger.info(f"Step 1: 重抓 margin ({len(margin_dates)} 日期): {margin_dates[0]} ~ {margin_dates[-1]}")
        success = 0
        for d in margin_dates:
            try:
                if backfill_margin(d):
                    success += 1
            except Exception as e:
                logger.error(f"  [{d}] 處理失敗: {e}", exc_info=True)
        logger.info(f"Step 1 完成: {success}/{len(margin_dates)} 日期成功\n")
    else:
        logger.info("Step 1: 無 daily_margin/*.parquet，跳過\n")

    # ── Step 2: 重生成 Dashboard JSON（只針對有 dashboard_*.json 檔案的日期） ──
    dashboard_dates = _list_dashboard_dates(dashboard_dir)
    if dashboard_dates:
        logger.info(f"Step 2: 重生成 Dashboard JSON ({len(dashboard_dates)} 日期): {dashboard_dates[0]} ~ {dashboard_dates[-1]}")
        for d in dashboard_dates:
            try:
                path = export_dashboard_json_safe(d)
                if path:
                    logger.info(f"  [{d}] dashboard JSON: {path}")
                else:
                    logger.error(f"  [{d}] dashboard JSON 失敗")
            except Exception as e:
                logger.error(f"  [{d}] dashboard JSON 異常: {e}")
        logger.info("Step 2 完成\n")
    else:
        logger.info("Step 2: 無 dashboard_*.json，跳過\n")

    # ── Step 3: 全量重建個股 JSON（不依賴任何日期清單，generate_all 自行掃描所有 parquet） ──
    logger.info("Step 3: 全量重建個股 JSON ...")
    try:
        count = generate_all()
        logger.info(f"Step 3 完成: {count} 檔個股 JSON 已重建\n")
    except Exception as e:
        logger.error(f"Step 3 個股重建異常: {e}", exc_info=True)

    logger.info("全部完成。")


if __name__ == "__main__":
    main()