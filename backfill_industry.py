"""
一次性腳本：對現有 docs/api/stock/*.json 補上 industry 欄位

執行：
  python3 -m quant_system_v2.backfill_industry
"""

import json
import os
import sys

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from quant_system_v2.utils.industry import INDUSTRY_MAP


def main():
    pkg_root = os.path.dirname(os.path.abspath(__file__))
    stock_dir = os.path.join(pkg_root, "docs", "api", "stock")

    if not os.path.isdir(stock_dir):
        print(f"❌ 目錄不存在: {stock_dir}")
        sys.exit(1)

    count = 0
    for fname in sorted(os.listdir(stock_dir)):
        if not fname.endswith(".json") or fname == "index.json":
            continue
        stock_id = fname.replace(".json", "")
        fpath = os.path.join(stock_dir, fname)

        try:
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ⚠️  {fname} 讀取失敗: {e}")
            continue

        # 如果已有 industry 且不為空，跳過
        if data.get("industry"):
            continue

        industry = INDUSTRY_MAP.get(stock_id, "")
        data["industry"] = industry

        try:
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"  ✅ {stock_id} → {industry or '(空)'}")
            count += 1
        except Exception as e:
            print(f"  ❌ {fname} 寫入失敗: {e}")

    print(f"\n完成: {count} 檔補上 industry")


if __name__ == "__main__":
    main()