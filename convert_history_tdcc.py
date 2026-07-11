"""
一次性歷史轉檔腳本 — 將 data/raw/getOD1-5/ 下舊專案的集保 CSV
轉換為新系統 Parquet 格式（data/parquet/weekly_tdcc/）

運作方式：
  1. 掃描 data/raw/getOD1-5/*.csv（含 .CSV）
  2. 過濾出 2026-05-01 之後的檔案
  3. 對每個 CSV 進行：
     a. 讀取 CSV（嘗試 utf-8 / big5 / latin-1）
     b. 標準化欄位（資料日期 → 日期，保留 6 標準欄）
     c. 呼叫 storage.save_dataframe() 寫入 Parquet
  4. 跳過已存在的 Parquet 檔案（避免重複寫入）

執行方式：
  python3 -m quant_system_v2.convert_history_tdcc
"""

import glob
import logging
import os
import sys
import re

import pandas as pd

# 確保專案根目錄在 sys.path 中
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from quant_system_v2.database.storage import save_dataframe

logger = logging.getLogger(__name__)

# 目標 table（與 run.py 每日爬取相同）
_TARGET_TABLE = "weekly_tdcc"

# CSV 原始目錄（相對於專案根目錄）
_RAW_CSV_DIR = os.path.join(_project_root, "data", "raw", "getOD1-5")

# 用來匹配檔名中的日期（YYYYMMDD）
_DATE_PATTERN = re.compile(r"(\d{8})", re.IGNORECASE)

# 只處理此日期之後的檔案
_CUTOFF_DATE = "20260501"

# 集保 CSV 標準 6 欄位（與 crawler.market_crawler.fetch_tdcc_distribution 一致）
_EXPECTED_COLUMNS = ["日期", "證券代號", "持股分級", "人數", "股數", "占集保庫存數比例%"]


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def _read_csv_safe(filepath: str) -> pd.DataFrame:
    """
    嘗試以多種編碼讀取 CSV 檔案。
    依序嘗試：utf-8 → big5 → latin-1
    """
    for encoding in ["utf-8", "big5", "latin-1"]:
        try:
            df = pd.read_csv(filepath, encoding=encoding)
            logger.info(f"  編碼 {encoding} 讀取成功 ({len(df)} 列)")
            return df
        except (UnicodeDecodeError, UnicodeError):
            continue
        except Exception as e:
            logger.warning(f"  編碼 {encoding} 讀取異常: {e}")
            continue
    raise ValueError(f"無法以任何編碼讀取: {filepath}")


def _standardize_tdcc_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    將原始 CSV 欄位標準化為系統內部格式。
    與 market_crawler.fetch_tdcc_distribution 的後處理邏輯一致。
    """
    df = df.copy()

    # 欄位名稱去空白
    df.columns = [c.strip() for c in df.columns]

    # 「資料日期」→「日期」
    rename_map = {}
    for col in df.columns:
        if col == "資料日期":
            rename_map[col] = "日期"
    if rename_map:
        df = df.rename(columns=rename_map)

    # 只保留 6 標準欄位
    available_cols = [c for c in _EXPECTED_COLUMNS if c in df.columns]
    df = df[available_cols]

    # 日期欄位統一為 YYYYMMDD 字串格式（去除隱藏空白）
    df["日期"] = df["日期"].astype(str).str.strip()

    return df


def main() -> None:
    _setup_logging()

    logger.info("=" * 55)
    logger.info("  集保 CSV 歷史轉 Parquet")
    logger.info("=" * 55)

    # ──────────────────────────────────────────
    # 1. 掃描 CSV 檔案
    # ──────────────────────────────────────────
    csv_dir = _RAW_CSV_DIR
    if not os.path.isdir(csv_dir):
        logger.error(f"目錄不存在: {csv_dir}")
        sys.exit(1)

    csv_files = sorted(glob.glob(os.path.join(csv_dir, "*.csv")) +
                       glob.glob(os.path.join(csv_dir, "*.CSV")))
    logger.info(f"掃描到 {len(csv_files)} 個 CSV 檔案")

    # 過濾日期：檔名中擷取 8 位數字，>= CUTOFF_DATE
    eligible = []
    for fp in csv_files:
        basename = os.path.basename(fp)
        m = _DATE_PATTERN.search(basename)
        if m:
            date_str = m.group(1)
            if date_str >= _CUTOFF_DATE:
                eligible.append((date_str, fp))

    eligible.sort(key=lambda x: x[0])
    logger.info(f"符合 {_CUTOFF_DATE} 之後的檔案: {len(eligible)} 個")

    if not eligible:
        logger.info("無需轉換的檔案，結束。")
        return

    for d, fp in eligible:
        logger.info(f"  {d}  {os.path.basename(fp)}")

    # ──────────────────────────────────────────
    # 2. 逐一轉換
    # ──────────────────────────────────────────
    success = []
    skipped = []

    for date_str, filepath in eligible:
        logger.info(f"[{date_str}] 開始轉換...")

        # 檢查是否已存在（跳過重複寫入）
        try:
            from quant_system_v2.database.storage import load_dataframe
            existing = load_dataframe(_TARGET_TABLE, date_str)
            if existing is not None and not existing.empty:
                logger.info(f"  ⏭️  已存在 ({len(existing)} 列)，跳過")
                skipped.append(date_str)
                continue
        except Exception:
            pass  # 若檢查失敗，仍然嘗試轉換

        try:
            # Step 1: 讀取 CSV
            df_raw = _read_csv_safe(filepath)

            # Step 2: 標準化欄位
            df_std = _standardize_tdcc_columns(df_raw)
            logger.info(f"  標準化後: {len(df_std)} 列, 欄位={list(df_std.columns)}")

            if df_std.empty:
                logger.warning(f"  標準化後為空，跳過")
                continue

            # Step 3: 寫入 Parquet
            save_dataframe(df_std, _TARGET_TABLE, date_str)
            success.append(date_str)
            logger.info(f"  ✅ 轉換完成")

        except Exception as e:
            logger.error(f"  ❌ 轉換失敗: {e}", exc_info=True)

    # ──────────────────────────────────────────
    # 3. 結果摘要
    # ──────────────────────────────────────────
    logger.info("")
    logger.info("=" * 55)
    logger.info(f"  轉換完成")
    logger.info(f"    成功: {len(success)} 個日期")
    logger.info(f"    跳過: {len(skipped)} 個（已存在）")
    logger.info("")

    if success:
        logger.info("  成功日期:")
        for d in success:
            logger.info(f"    ✅ {d}")
    if skipped:
        logger.info("  跳過日期:")
        for d in skipped:
            logger.info(f"    ⏭️  {d}")

    logger.info("")

    # 集保驅動區域回溯：只取最早的成功日期，一次涵蓋所有受影響交易日
    if success:
        from quant_system_v2.api.tdcc_backfill import trigger_tdcc_backfill
        earliest_date = min(success)
        logger.info(f"  觸發集保驅動回溯，起點: {earliest_date}")
        updated = trigger_tdcc_backfill(earliest_date)
        logger.info(f"  回溯完成: {updated} 個日期已更新")

    logger.info("=" * 55)


if __name__ == "__main__":
    main()