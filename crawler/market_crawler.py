"""
台股市場資料爬蟲

職責範圍（僅此而已）：
  1. 發送 HTTP 請求至 TWSE / TPEx API
  2. 將回應解析為原始 Pandas DataFrame（保留原始中文欄位名稱）
  3. 不做任何欄位重新命名、型別轉換或數值清洗

依賴：僅 quant_system_v2.config.settings
禁止：import database, 存取磁碟/Parquet, 任何資料清理
"""

import time
import random
import logging
from typing import Optional
from io import StringIO

import requests
import pandas as pd

from quant_system_v2.config.settings import MAX_RETRIES, DEFAULT_TIMEOUT, USER_AGENTS

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)


# ==========================================
# 底層請求函數
# ==========================================

def _rotate_user_agent() -> dict:
    """從 USER_AGENTS 列表中隨機選取一個 User-Agent"""
    return {"User-Agent": random.choice(USER_AGENTS)}


def _exponential_backoff(attempt: int, base: float = 0.5, cap: float = 4.0) -> float:
    """指數退避：0.5 → 1.0 → 2.0 (cap at 4.0)"""
    return min(base * (2 ** attempt), cap)


def _fetch_json(
    url: str,
    params: Optional[dict] = None,
    payload: Optional[dict] = None,
    method: str = "GET",
    label: str = "unknown",
) -> Optional[dict]:
    """
    發送 HTTP 請求並回傳 JSON dict。
    支援 GET 與 POST，內建重試 + 指數退避 + User-Agent 輪換。
    回傳 None 代表所有嘗試均失敗。
    """
    for attempt in range(MAX_RETRIES):
        headers = _rotate_user_agent()
        try:
            wait = _exponential_backoff(attempt)
            if attempt > 0:
                logger.info(f"[{label}] 重試 #{attempt + 1} (等待 {wait:.1f}s)...")
                time.sleep(wait)

            logger.info(f"[{label}] 請求中 (第 {attempt + 1}/{MAX_RETRIES} 次)...")

            if method == "POST":
                res = requests.post(url, data=payload, params=params, headers=headers, timeout=DEFAULT_TIMEOUT, verify=False)
            else:
                res = requests.get(url, params=params, headers=headers, timeout=DEFAULT_TIMEOUT, verify=False)

            if res.status_code == 200:
                return res.json()
            else:
                logger.warning(f"[{label}] HTTP {res.status_code}")

        except requests.exceptions.Timeout:
            logger.warning(f"[{label}] 連線超時 (timeout={DEFAULT_TIMEOUT}s)")
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"[{label}] 連線錯誤: {e}")
        except Exception as e:
            logger.warning(f"[{label}] 未知錯誤: {e}")

    logger.error(f"[{label}] 已達最大重試次數 ({MAX_RETRIES})，放棄請求。")
    return None


def _fetch_csv_text(
    url: str,
    params: Optional[dict] = None,
    label: str = "unknown",
) -> Optional[str]:
    """
    發送 HTTP 請求並回傳原始 CSV 文字內容。
    用於 TDCC 集保等以 CSV 格式回傳的 API。

    內建 Cache-Busting：
      - Cache-Control / Pragma / Expires headers 強制穿透 CDN 與代理快取
      - URL 帶入 timestamp query param 繞過 CDN key-based 快取
    """
    for attempt in range(MAX_RETRIES):
        headers = _rotate_user_agent()
        # 強制穿透所有快取層級（CDN + 代理 + 伺服器端）
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        headers["Pragma"] = "no-cache"
        headers["Expires"] = "0"

        # 每次請求附加不重複 timestamp，繞過 CDN key-based 快取
        req_params = dict(params) if params else {}
        req_params["_"] = int(time.time() * 1000)

        try:
            wait = _exponential_backoff(attempt)
            if attempt > 0:
                logger.info(f"[{label}] 重試 #{attempt + 1} (等待 {wait:.1f}s)...")
                time.sleep(wait)

            logger.info(f"[{label}] 請求中 (第 {attempt + 1}/{MAX_RETRIES} 次)...")
            res = requests.get(url, params=req_params, headers=headers, timeout=DEFAULT_TIMEOUT * 2, verify=False)

            if res.status_code == 200:
                return res.text
            else:
                logger.warning(f"[{label}] HTTP {res.status_code}")

        except requests.exceptions.Timeout:
            logger.warning(f"[{label}] 連線超時")
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"[{label}] 連線錯誤: {e}")
        except Exception as e:
            logger.warning(f"[{label}] 未知錯誤: {e}")

    logger.error(f"[{label}] 已達最大重試次數，放棄。")
    return None


# ==========================================
# 輔助函數
# ==========================================

def _roc_date_to_param(date_str: str, sep: str = "/") -> str:
    """將 YYYYMMDD 或 YYYY-MM-DD 轉為民國年格式（用於 TPEx API 參數）"""
    d = date_str.replace("-", "")
    roc_year = int(d[:4]) - 1911
    return f"{roc_year}{sep}{d[4:6]}{sep}{d[6:8]}"


def _extract_actual_date_from_tpex_table(table: dict) -> Optional[str]:
    """
    從 TPEx 回傳的 table 中解析實際交易日期（民國年轉西元年）。
    回傳 YYYY-MM-DD 字串或 None。
    """
    raw_date = table.get("date", "")
    if not raw_date:
        return None
    try:
        parts = raw_date.split("/")
        if len(parts) == 3:
            y = int(parts[0]) + 1911
            m = int(parts[1])
            d = int(parts[2])
            return f"{y}-{m:02d}-{d:02d}"
    except (ValueError, IndexError):
        pass
    return None


# ==========================================
# 1. TWSE 上市－每日價量
# ==========================================

def fetch_twse_daily_quotes(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TWSE 上市每日收盤價量（MI_INDEX API）。

    回傳 DataFrame 包含原始中文欄位，例如：
        證券代號, 證券名稱, 收盤價, 開盤價, 最高價, 最低價, 成交股數, ...
    """
    d = date_str.replace("-", "")
    url = f"https://www.twse.com.tw/exchangeReport/MI_INDEX"
    params = {"response": "json", "date": d, "type": "ALL"}

    data = _fetch_json(url, params=params, label=f"上市價量 {date_str}")
    if data is None or data.get("stat") != "OK":
        logger.warning(f"[{date_str}] 上市價量 API 回傳異常: stat={data.get('stat', 'N/A') if data else 'N/A'}")
        return None

    # 找出包含證券代號與收盤價的 table
    target_rows = None
    target_fields = None

    if "tables" in data:
        for table in data["tables"]:
            raw_fields = table.get("fields", [])
            fields = [str(f).replace("<b>", "").replace("</b>", "").strip() for f in raw_fields]
            if "證券代號" in fields and "收盤價" in fields:
                target_rows = table.get("data", [])
                target_fields = fields
                break
    elif "fields8" in data:
        target_fields = [str(f).strip() for f in data["fields8"]]
        target_rows = data.get("data8", [])

    if target_rows is None or not target_fields:
        logger.warning(f"[{date_str}] 上市價量：無法定位資料表格")
        return None

    df = pd.DataFrame(target_rows, columns=target_fields)
    df["日期"] = pd.to_datetime(d)
    logger.info(f"[{date_str}] 上市價量: {len(df)} 筆")
    return df


# ==========================================
# 2. TPEx 上櫃－每日價量
# ==========================================

def fetch_tpex_daily_quotes(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TPEx 上櫃每日收盤價量（dailyQuotes API, POST）。

    回傳 DataFrame 包含原始中文欄位，例如：
        代號, 名稱, 收盤, 開盤, 最高, 最低, 成交股數, ...
    """
    d = date_str.replace("-", "")
    date_formatted = f"{d[:4]}/{d[4:6]}/{d[6:8]}"
    url = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"
    payload = {"date": date_formatted, "id": "", "response": "json"}

    data = _fetch_json(url, payload=payload, method="POST", label=f"上櫃價量 {date_str}")
    if data is None:
        return None

    tables = data.get("tables", [])
    if not tables:
        logger.warning(f"[{date_str}] 上櫃價量：無 tables")
        return None

    table = tables[0]
    fields = table.get("fields", [])
    rows = table.get("data", [])
    if not fields or not rows:
        logger.warning(f"[{date_str}] 上櫃價量：fields 或 data 為空")
        return None

    # 日期驗證：比對回傳日期與請求日期
    actual_date = _extract_actual_date_from_tpex_table(table)
    if actual_date:
        request_dt = pd.to_datetime(d)
        actual_dt = pd.to_datetime(actual_date)
        if actual_dt != request_dt:
            logger.warning(
                f"[{date_str}] 上櫃價量回傳日期 {actual_date} 與請求日期不一致，跳過"
            )
            return None

    df = pd.DataFrame(rows, columns=fields)
    df["日期"] = pd.to_datetime(actual_date if actual_date else d)
    logger.info(f"[{date_str}] 上櫃價量: {len(df)} 筆")
    return df


# ==========================================
# 3. TWSE 上市－三大法人買賣超
# ==========================================

def fetch_twse_institutional(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TWSE 上市三大法人買賣超（T86 API）。

    回傳 DataFrame 包含原始中文欄位，例如：
        證券代號, 證券名稱, 外資買賣超股數, 投信買賣超股數, 自營商買賣超股數, ...
    """
    d = date_str.replace("-", "")
    url = f"https://www.twse.com.tw/rwd/zh/fund/T86"
    params = {"date": d, "selectType": "ALL", "response": "JSON"}

    data = _fetch_json(url, params=params, label=f"上市法人 {date_str}")
    if data is None or data.get("stat") != "OK":
        logger.warning(f"[{date_str}] 上市法人 API 回傳異常")
        return None

    # 找出包含買賣超欄位的 table
    target_rows = None
    target_fields = None

    if "tables" in data:
        for table in data["tables"]:
            fields = [str(f).strip() for f in table.get("fields", [])]
            if any("買賣超" in f for f in fields):
                target_rows = table.get("data", [])
                target_fields = fields
                break
    elif "fields" in data:
        target_fields = [str(f).strip() for f in data["fields"]]
        target_rows = data.get("data", [])

    if target_rows is None or not target_fields:
        logger.warning(f"[{date_str}] 上市法人：無法定位資料表格")
        return None

    df = pd.DataFrame(target_rows, columns=target_fields)
    df["日期"] = pd.to_datetime(d)
    logger.info(f"[{date_str}] 上市法人: {len(df)} 筆")
    return df


# ==========================================
# 4. TPEx 上櫃－三大法人買賣超
# ==========================================

def fetch_tpex_institutional(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TPEx 上櫃三大法人買賣超（dailyTrade API）。

    回傳 DataFrame 包含原始欄位（數字索引，無中文欄位名），
    因為 TPEx 回傳的是無 header 的二維陣列。
    """
    d = date_str.replace("-", "")
    date_formatted = f"{d[:4]}/{d[4:6]}/{d[6:8]}"
    url = "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"
    params = {
        "type": "Daily",
        "sect": "AL",
        "date": date_formatted,
        "id": "",
        "response": "json",
    }

    data = _fetch_json(url, params=params, label=f"上櫃法人 {date_str}")
    if data is None:
        return None

    tables = data.get("tables", [])
    if not tables:
        logger.warning(f"[{date_str}] 上櫃法人：無 tables")
        return None

    # TPEx 回傳的 field 標題不足（僅 5 欄但實際 24 欄），
    # 取其 fields 做為參考，但直接用數字索引建立 DataFrame
    table = tables[0]
    fields = table.get("fields", [])
    rows = table.get("data", [])
    if not rows:
        logger.warning(f"[{date_str}] 上櫃法人：資料為空")
        return None

    # TPEx 法人買賣超回傳 24 個 data 欄位（無主標題、部分名稱重複）
    # 此處強行賦予唯一精確中文名稱，使 apply_column_mapping 可正確對映
    _TPEX_INST_COLUMNS = [
        "代號", "名稱",
        "外資不含自營買進股數", "外資不含自營賣出股數", "外資不含自營買賣超股數",               # Index 2-4
        "外資自營買進股數", "外資自營賣出股數", "外資自營買賣超股數",                           # Index 5-7
        "外資及陸資買進股數", "外資及陸資賣出股數", "外資及陸資買賣超股數",                       # Index 8-10 (對應外資合計)
        "投信買進股數", "投信賣出股數", "投信買賣超股數",                                       # Index 11-13 (與上市同)
        "自營商買進股數(自行買賣)", "自營商賣出股數(自行買賣)", "自營商買賣超股數(自行買賣)",      # Index 14-16 (與上市同)
        "自營商買進股數(避險)", "自營商賣出股數(避險)", "自營商買賣超股數(避險)",                  # Index 17-19 (與上市同)
        "自營商買進股數", "自營商賣出股數", "自營商買賣超股數",                                   # Index 20-22 (與上市同)
        "三大法人買賣超股數合計",                                                                  # Index 23 (TPEx特有)
    ]

    if rows:
        col_count = max(len(row) for row in rows)
    else:
        col_count = len(fields)

    if col_count <= len(_TPEX_INST_COLUMNS):
        col_names = _TPEX_INST_COLUMNS[:col_count]
    else:
        col_names = [f"index_{i}" for i in range(col_count)]

    df = pd.DataFrame(rows, columns=col_names)

    df["日期"] = pd.to_datetime(d)
    logger.info(f"[{date_str}] 上櫃法人: {len(df)} 筆 (欄位: {list(df.columns)})")
    return df


# ==========================================
# 5. TWSE 上市－融資融券
# ==========================================

def fetch_twse_margin_trading(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TWSE 上市融資融券（MI_MARGN API）。

    回傳 DataFrame 包含原始中文欄位，例如：
        證券代號, 證券名稱, 融資買進, 融資賣出, 融資現金償還,
        融資前日餘額, 融資今日餘額, 融券買進, 融券賣出, ...
    """
    d = date_str.replace("-", "")
    url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN"
    params = {"date": d, "selectType": "STOCK", "response": "json"}

    data = _fetch_json(url, params=params, label=f"上市融資券 {date_str}")
    if data is None or data.get("stat") != "OK":
        logger.warning(f"[{date_str}] 上市融資券 API 回傳異常")
        return None

    tables = data.get("tables", [])
    # 第二個 table 為個股明細
    if len(tables) < 2:
        logger.warning(f"[{date_str}] 上市融資券：tables 結構異常 (<2)")
        return None

    table = tables[1]
    rows = table.get("data", [])
    if not rows:
        logger.warning(f"[{date_str}] 上市融資券：data 為空")
        return None

    # TWSE 回傳的 fields 中，融資與融券共用相同名稱（如 '買進', '賣出', '前日餘額'），
    # 導致 DataFrame 建立時拋出 ValueError: Duplicate column names。
    # 此處以索引順序重建唯一的中文欄位名稱，確保與 schema.py COLUMN_MAP 匹配。
    _TWSE_MARGIN_COLUMNS = [
        "證券代號",          # 0
        "證券名稱",          # 1
        "融資買進(張)",      # 2
        "融資賣出(張)",      # 3
        "融資現金償還(張)",  # 4
        "融資前日餘額(張)",  # 5
        "融資今日餘額(張)",  # 6
        "融資次一營業日限額", # 7
        "融券買進(張)",      # 8
        "融券賣出(張)",      # 9
        "融券現券償還(張)",  # 10
        "融券前日餘額(張)",  # 11
        "融券今日餘額(張)",  # 12
        "融券次一營業日限額", # 13
        "資券互抵",          # 14
        "註記",              # 15
    ]

    # 過濾掉匯總列（證券代號不是數字的行）
    valid_rows = []
    for row in rows:
        sid = str(row[0]).strip() if row else ""
        if sid and sid[0].isdigit():
            valid_rows.append(row)

    if not valid_rows:
        logger.warning(f"[{date_str}] 上市融資券：無有效明細資料")
        return None

    df = pd.DataFrame(valid_rows, columns=_TWSE_MARGIN_COLUMNS)
    df["日期"] = pd.to_datetime(d)
    logger.info(f"[{date_str}] 上市融資券: {len(df)} 筆")
    return df


# ==========================================
# 6. TPEx 上櫃－融資融券
# ==========================================

def fetch_tpex_margin_trading(date_str: str) -> Optional[pd.DataFrame]:
    """
    抓取 TPEx 上櫃融資融券（margin/balance API）。

    回傳 DataFrame 包含原始欄位名稱（中文），例如：
        代號, 名稱, 前資餘額, 資買, 資賣, 現償, 資餘額, ...
    """
    d = date_str.replace("-", "")
    date_formatted = f"{d[:4]}/{d[4:6]}/{d[6:8]}"
    url = "https://www.tpex.org.tw/www/zh-tw/margin/balance"
    params = {"date": date_formatted, "id": "", "response": "json"}

    data = _fetch_json(url, params=params, label=f"上櫃融資券 {date_str}")
    if data is None:
        return None

    tables = data.get("tables", [])
    if not tables:
        logger.warning(f"[{date_str}] 上櫃融資券：無 tables")
        return None

    table = tables[0]
    fields = table.get("fields", [])
    rows = table.get("data", [])
    if not fields or not rows:
        logger.warning(f"[{date_str}] 上櫃融資券：fields 或 data 為空")
        return None

    df = pd.DataFrame(rows, columns=fields)
    df["日期"] = pd.to_datetime(d)
    logger.info(f"[{date_str}] 上櫃融資券: {len(df)} 筆")
    return df


# ==========================================
# 7. TDCC 集保戶股權分散表 (OpenData CSV)
# ==========================================

TDCC_DISTRIBUTION_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"
"""TDCC 集保戶股權分散表 OpenData CSV 端點。
每日更新（但實務上僅週六會發布新一期結算資料）。
採用「每日輪詢、重複不寫入」架構，由呼叫方處理去重。
"""


def fetch_tdcc_distribution() -> Optional[pd.DataFrame]:
    """
    抓取 TDCC 集保戶股權分散表最新快照 (id=1-5)。

    不回傳錯誤，失敗時回傳 None。
    回傳的 DataFrame 包含以下 6 個標準欄位：
        - 日期          (從原始 '資料日期' 重新命名)
        - 證券代號
        - 持股分級
        - 人數
        - 股數
        - 占集保庫存數比例%

    Notes
    -----
    - **無 `date_str` 參數**：永遠取 API 上的最新快照。
    - **不做日期過濾**：由呼叫方依 `日期` 欄位自行判斷是否需要寫入。
    - 採用 V2 既有的 `_fetch_csv_text()` 進行重試 + User-Agent 輪換。
    """
    label = "TDCC集保"

    try:
        csv_text = _fetch_csv_text(TDCC_DISTRIBUTION_URL, label=label)
        if csv_text is None:
            return None

        df = pd.read_csv(StringIO(csv_text))

        # 精準欄位重新命名：僅將 '資料日期' → '日期'
        rename_map = {}
        for col in df.columns:
            col_clean = col.strip()
            if col_clean == "資料日期":
                rename_map[col] = "日期"

        if rename_map:
            df = df.rename(columns=rename_map)

        # 確保只保留 6 個標準欄位
        expected_cols = ["日期", "證券代號", "持股分級", "人數", "股數", "占集保庫存數比例%"]
        available_cols = [c for c in expected_cols if c in df.columns]
        df = df[available_cols]

        # 日期欄位統一為 YYYYMMDD 字串格式
        df["日期"] = df["日期"].astype(str).str.strip()

        # 證券代號去除首尾空白（TDCC 原始 CSV 的證券代號帶有尾端空白）
        if "證券代號" in df.columns:
            df["證券代號"] = df["證券代號"].str.strip()

        logger.info(f"[{label}] 成功抓取: {len(df)} 筆, 日期={df['日期'].iloc[0] if not df.empty else 'N/A'}")
        return df

    except Exception as e:
        logger.error(f"[{label}] 抓取或解析失敗: {e}", exc_info=True)
        return None
