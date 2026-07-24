"""
DataFrame 中英文欄位對照表
系統內部運算統一使用全小寫英文欄位名稱
"""

COLUMN_MAP = {
    # 基本資料
    "日期": "date",
    "證券代號": "stock_id",
    "證券名稱": "stock_name",
    "代號": "stock_id",                 # TPEx 價量（短名稱）
    "名稱": "stock_name",               # TPEx 價量（短名稱）

    # 價量（TWSE MI_INDEX 原始欄位 + TPEx 短名稱）
    "收盤價": "close_price",
    "收盤": "close_price",              # TPEx 價量
    "開盤價": "open_price",
    "開盤": "open_price",               # TPEx 價量
    "最高價": "high_price",
    "最高": "high_price",               # TPEx 價量
    "最低價": "low_price",
    "最低": "low_price",                # TPEx 價量
    "成交股數": "volume",               # TWSE 原始名稱（取代 "成交量"）
    "成交金額(元)": "amount",           # TPEx 價量
    "成交金額": "amount",
    "成交筆數": "trade_count",

    # 技術面
    "漲跌(+/-)": "price_change_sign",
    "漲跌價差": "price_change",
    "漲跌": "price_change",              # TPEx 上櫃價量
    "漲跌幅(%)": "price_change_pct",
    "振幅(%)": "amplitude",
    "週轉率(%)": "turnover_rate",
    "本益比": "pe_ratio",

    # 融資融券（TWSE MI_MARGN 原始欄位）
    "融資今日餘額(張)": "fin_balance",   # 取代 "融資餘額(張)"
    "融資前日餘額(張)": "fin_prev_balance",
    "融資買進(張)": "fin_buy",
    "融資賣出(張)": "fin_sell",
    "融資現金償還(張)": "fin_cash_repay",
    "融券今日餘額(張)": "mar_balance",   # 取代 "融券餘額(張)"
    "融券前日餘額(張)": "mar_prev_balance",
    "融券買進(張)": "mar_buy",
    "融券賣出(張)": "mar_sell",
    "融券現券償還(張)": "mar_cash_repay",

    # 三大法人買賣超（TWSE T86 原始欄位，以「股數」為單位）
    "外陸資買賣超股數(不含外資自營商)": "foreign_buy_sell",
    "投信買賣超股數": "trust_buy_sell",
    "自營商買賣超股數": "prop_buy_sell",
    "自營商買賣超股數(自行買賣)": "prop_dealer_buy_sell",
    "自營商買賣超股數(避險)": "prop_hedge_buy_sell",
    "三大法人買賣超股數": "total_inst_buy_sell",

    # TPEx 法人特有欄位（與 TWSE 同義映射，確保 pd.concat 能對應）
    "外資及陸資買賣超股數": "foreign_buy_sell",
    "三大法人買賣超股數合計": "total_inst_buy_sell",

    # 保留舊版相容（部分模組可能使用「張」為單位的欄位）
    "成交量": "volume",
    "融資餘額(張)": "fin_balance",
    "融券餘額(張)": "mar_balance",
    "外資買賣超(張)": "foreign_buy_sell",
    "投信買賣超(張)": "trust_buy_sell",
    "自營商買賣超(張)": "prop_buy_sell",
    "自營商(自行買賣)買賣超(張)": "prop_dealer_buy_sell",
    "自營商(避險)買賣超(張)": "prop_hedge_buy_sell",
    "三大法人買賣超(張)": "total_inst_buy_sell",

    # 集保 / 籌碼
    "集保股數": "total_shares",
    "集保張數": "total_units",
    "持股分級": "holder_level",
    "人數": "holder_count",
    "股數": "shares_held",
    "佔集保比例(%)": "holding_pct",

    # 處置股
    "處置日期": "punish_date",
    "處置起日": "punish_start",
    "處置迄日": "punish_end",
    "處置原因": "punish_reason",
    "處置方式": "punish_method",
}


def apply_column_mapping(df, mapping=None):
    """將 DataFrame 的中文欄位轉換為英文欄位名稱（僅轉換存在的欄位）"""
    if mapping is None:
        mapping = COLUMN_MAP
    rename_dict = {col: eng for col, eng in mapping.items() if col in df.columns}
    if rename_dict:
        df = df.rename(columns=rename_dict)
    return df


def reverse_column_map(mapping=None):
    """反轉 COLUMN_MAP, 英文 -> 中文"""
    if mapping is None:
        mapping = COLUMN_MAP
    return {v: k for k, v in mapping.items()}