"""
一次性修復腳本：清理 weekly_tdcc/ 下所有 Parquet 檔案中
證券代號欄位的尾端空白字元。

執行方式：
  python3 clean_tdcc_parquet_whitespace.py
"""

import glob
import os
import sys

import pandas as pd

_project_root = os.path.dirname(os.path.abspath(__file__))
TDCC_DIR = os.path.join(_project_root, "data", "parquet", "weekly_tdcc")


def main():
    if not os.path.isdir(TDCC_DIR):
        print(f"❌ 目錄不存在: {TDCC_DIR}")
        sys.exit(1)

    parquet_files = sorted(glob.glob(os.path.join(TDCC_DIR, "*.parquet")))
    print(f"掃描到 {len(parquet_files)} 個 Parquet 檔案\n")

    fixed_count = 0
    skip_count = 0

    for fpath in parquet_files:
        fname = os.path.basename(fpath)
        df = pd.read_parquet(fpath, engine="pyarrow")

        if "證券代號" not in df.columns:
            print(f"  ⏭️  {fname} — 無證券代號欄位")
            skip_count += 1
            continue

        # 檢查是否有尾端空白
        before = df["證券代號"].str.strip().equals(df["證券代號"])
        if before:
            print(f"  ⏭️  {fname} — 已乾淨，無需修復")
            skip_count += 1
            continue

        # 修復：去除首尾空白
        df["證券代號"] = df["證券代號"].str.strip()

        # 覆寫回原檔案
        df.to_parquet(fpath, engine="pyarrow", index=False)
        print(f"  ✅ {fname} — 修復完成")
        fixed_count += 1

    print(f"\n總結：{fixed_count} 個檔案已修復，{skip_count} 個跳過")


if __name__ == "__main__":
    main()