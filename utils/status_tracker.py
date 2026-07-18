# -*- coding: utf-8 -*-
"""
狀態追蹤模組 — 指針 API + status.json 讀寫

職責範圍：
  1. fetch_market_date()  — 不帶參數呼叫 MI_INDEX 取得最新交易日
  2. load_status()        — 讀取指定日期的資料完整度（無紀錄時回傳全 false）
  3. save_status()        — 部分更新指定日期的狀態欄位
  4. get_all_status()     — 回傳完整 status.json（供前端使用）

目錄位置：docs/api/status.json（與 latest.json 並列，供前端 fetch）
"""

import json
import logging
import os
import sys
from datetime import datetime
from typing import Optional

import requests

from quant_system_v2.config.settings import DATA_DIR

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────
# 路徑解析
# ──────────────────────────────────────────

_STATUS_FILE = "status.json"

# 預設完整度結構（六個子源 + dashboard）
DEFAULT_COMPLETENESS = {
    "price_twse": False,
    "price_tpex": False,
    "chip_twse": False,
    "chip_tpex": False,
    "margin_twse": False,
    "margin_tpex": False,
    "tdcc_date": "",
    "dashboard": False,
}


def _resolve_project_root() -> str:
    """以 status_tracker.py 所在位置往上兩層（utils/ → quant_system_v2/）為基準"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _get_status_path() -> str:
    """回傳 status.json 的絕對路徑（位在 docs/api/ 下）"""
    project_root = _resolve_project_root()
    return os.path.join(project_root, "docs", "api", _STATUS_FILE)


# ──────────────────────────────────────────
# 1. 指針 API — MI_INDEX（不帶參數）
# ──────────────────────────────────────────


def fetch_market_date() -> Optional[str]:
    """
    不帶任何參數呼叫 TWSE MI_INDEX，從回應中提取最新交易日。

    此 API 回傳 stat="OK" 且 date 為最後交易日（YYYYMMDD），
    即使當天已收盤或休市，只要最近一次交易日存在就會回傳。

    Returns:
        str: YYYYMMDD 格式的最新交易日
        None: API 失敗或 stat != OK（例如週末、盤中未放榜）
    """
    url = "https://www.twse.com.tw/exchangeReport/MI_INDEX"
    params = {"response": "json"}

    try:
        res = requests.get(url, params=params, timeout=15)
        if res.status_code != 200:
            logger.warning(f"[market_date] HTTP {res.status_code}")
            return None

        data = res.json()
        if data.get("stat") != "OK":
            logger.warning(f"[market_date] stat={data.get('stat')}")
            return None

        date_str = data.get("date", "")
        if not date_str or not date_str.isdigit():
            logger.warning(f"[market_date] 無效日期: {date_str}")
            return None

        logger.info(f"[market_date] 最新交易日: {date_str}")
        return date_str

    except requests.exceptions.Timeout:
        logger.warning("[market_date] 連線超時")
        return None
    except requests.exceptions.ConnectionError as e:
        logger.warning(f"[market_date] 連線錯誤: {e}")
        return None
    except Exception as e:
        logger.warning(f"[market_date] 未知錯誤: {e}")
        return None


# ──────────────────────────────────────────
# 2. 狀態讀寫
# ──────────────────────────────────────────


def _read_status_file() -> dict:
    """讀取完整的 status.json，若檔案不存在回傳空 dict"""
    path = _get_status_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"[status] 讀取失敗 ({e})，初始化空結構")
        return {}


def _write_status_file(data: dict) -> None:
    """將完整 status dict 寫回檔案"""
    path = _get_status_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_status(date_str: str) -> dict:
    """
    讀取指定日期的資料完整度。

    若該日期尚無紀錄，回傳全 false 的預設結構。
    若 status.json 完全不存在，也回傳全 false（首次執行自動初始化）。

    Args:
        date_str: YYYYMMDD 格式日期

    Returns:
        dict: 該日期的完整度 dict（含六個子源、tdcc_date、dashboard）
    """
    d = date_str.replace("-", "")
    data = _read_status_file()
    dates = data.get("dates", {})
    record = dates.get(d, None)

    if record is None:
        # 回傳預設全 false
        return dict(DEFAULT_COMPLETENESS)

    # 確保所有欄位都存在（向後相容：若舊紀錄缺少某欄位，補 false）
    result = dict(DEFAULT_COMPLETENESS)
    result.update(record)
    return result


def save_status(date_str: str, updates: dict) -> None:
    """
    對指定日期做部分欄位更新，不影響其他日期。

    只有在任何欄位的值真正改變時才會寫入檔案並更新 updated_at；
    若更新值與既有紀錄完全相同，則跳過寫入，避免無意義的 git diff。

    範例：
     若更新值與既有紀錄完全相同，則跳過寫入，避免無意義的 git diff。

    Args:
        date_str: YYYYMMDD 格式日期
        updates: 要更新的欄位 dict（例如 {"price_twse": True}）
    """
    d = date_str.replace("-", "")
    data = _read_status_file()

    # 確保 dates 存在
    if "dates" not in data:
        data["dates"] = {}

    # 確保該日期紀錄存在（若無則初始化全 false）
    if d not in data["dates"]:
        data["dates"][d] = dict(DEFAULT_COMPLETENESS)

    # 檢查是否有任何欄位真正改變
    existing = data["dates"][d]
    has_changes = False
    for key, value in updates.items():
        if existing.get(key) != value:
            has_changes = True
            break

    if not has_changes:
        return

    # 部分更新
    data["dates"][d].update(updates)

    # 更新頂層時間戳
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _write_status_file(data)
    logger.debug(f"[status] {d} 已更新: {updates}")


def get_all_status() -> dict:
    """
    回傳完整 status.json 內容（供前端 / 外部取用）。

    Returns:
        dict: 完整 status 結構，至少包含 {"updated_at": "", "dates": {}}
    """
    data = _read_status_file()
    if not data:
        return {"updated_at": "", "dates": {}}
    return data