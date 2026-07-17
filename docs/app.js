document.addEventListener("DOMContentLoaded", () => {
    const dateSelect = document.getElementById("date-select");
    const statusBar = document.getElementById("data-status");

    // ──────────────────────────────────────────
    // 28 項指標對照表（7 個頁籤）
    // ──────────────────────────────────────────
    const METRIC_CONFIGS = {
        // 1. 法人買超（金額）(4) — 後端單位為千元
        "buysell_total_buy_amount":    { tab:"tab-buy-amount", title:"三大法人買超",        unit:"百萬元", valueKey:"value", isBuy:true },
        "buysell_foreign_buy_amount":  { tab:"tab-buy-amount", title:"外資買超",            unit:"百萬元", valueKey:"value", isBuy:true },
        "buysell_trust_buy_amount":    { tab:"tab-buy-amount", title:"投信買超",            unit:"百萬元", valueKey:"value", isBuy:true },
        "buysell_prop_buy_amount":     { tab:"tab-buy-amount", title:"自營商買超",          unit:"百萬元", valueKey:"value", isBuy:true },
        // 2. 法人賣超（金額）(4) — 後端單位為千元
        "buysell_total_sell_amount":   { tab:"tab-sell-amount", title:"三大法人賣超",        unit:"百萬元", valueKey:"value", isBuy:false },
        "buysell_foreign_sell_amount": { tab:"tab-sell-amount", title:"外資賣超",            unit:"百萬元", valueKey:"value", isBuy:false },
        "buysell_trust_sell_amount":   { tab:"tab-sell-amount", title:"投信賣超",            unit:"百萬元", valueKey:"value", isBuy:false },
        "buysell_prop_sell_amount":    { tab:"tab-sell-amount", title:"自營商賣超",          unit:"百萬元", valueKey:"value", isBuy:false },
        // 3. 法人買超（張數）(4)
        "buysell_total_buy_shares":    { tab:"tab-buy-shares", title:"三大法人買超",        unit:"張", valueKey:"value", isBuy:true },
        "buysell_foreign_buy_shares":  { tab:"tab-buy-shares", title:"外資買超",            unit:"張", valueKey:"value", isBuy:true },
        "buysell_trust_buy_shares":    { tab:"tab-buy-shares", title:"投信買超",            unit:"張", valueKey:"value", isBuy:true },
        "buysell_prop_buy_shares":     { tab:"tab-buy-shares", title:"自營商買超",          unit:"張", valueKey:"value", isBuy:true },
        // 4. 法人賣超（張數）(4)
        "buysell_total_sell_shares":   { tab:"tab-sell-shares", title:"三大法人賣超",        unit:"張", valueKey:"value", isBuy:false },
        "buysell_foreign_sell_shares": { tab:"tab-sell-shares", title:"外資賣超",            unit:"張", valueKey:"value", isBuy:false },
        "buysell_trust_sell_shares":   { tab:"tab-sell-shares", title:"投信賣超",            unit:"張", valueKey:"value", isBuy:false },
        "buysell_prop_sell_shares":    { tab:"tab-sell-shares", title:"自營商賣超",          unit:"張", valueKey:"value", isBuy:false },
        // 5. 融資券增減 (4) — 後端單位為千元
        "margin_fin_buy":    { tab:"tab-margin", title:"融資增加",      unit:"百萬元", valueKey:"value", isBuy:true },
        "margin_fin_sell":   { tab:"tab-margin", title:"融資減少",      unit:"百萬元", valueKey:"value", isBuy:false },
        "margin_mar_buy":    { tab:"tab-margin", title:"融券增加",      unit:"百萬元", valueKey:"value", isBuy:false },
        "margin_mar_sell":   { tab:"tab-margin", title:"融券減少",      unit:"百萬元", valueKey:"value", isBuy:true },
        // 6. 爆量 (4)
        "surge_daily":   { tab:"tab-momentum", title:"單日爆量倍數",  unit:"倍", valueKey:"surge_ratio",   isBuy:true },
        "surge_weekly":  { tab:"tab-momentum", title:"週量增溫倍數",  unit:"倍", valueKey:"weekly_ratio",  isBuy:true },
        "streak_trust":  { tab:"tab-momentum", title:"投信連買強度",  unit:"天", valueKey:"streak_days",   isBuy:true },
        "streak_foreign":{ tab:"tab-momentum", title:"外資連買強度",  unit:"天", valueKey:"streak_days",   isBuy:true },
        // 7. 大戶增減 (4)
        "chip_large_ratio_buy":  { tab:"tab-large", title:"大戶比例增", unit:"%", valueKey:"大戶比例增幅", isBuy:true },
        "chip_large_ratio_sell": { tab:"tab-large", title:"大戶比例減", unit:"%", valueKey:"大戶比例增幅", isBuy:false },
        "chip_large_count_buy":  { tab:"tab-large", title:"大戶人數增", unit:"人", valueKey:"大戶人數增幅", isBuy:true },
        "chip_large_count_sell": { tab:"tab-large", title:"大戶人數減", unit:"人", valueKey:"大戶人數增幅", isBuy:false },
    };

    // ──────────────────────────────────────────
    // 初始化
    // ──────────────────────────────────────────
    const _fullStatusPromise = fetch("./api/status.json").then(r => r.json()).catch(() => null);

    buildCards();
    setupTabListeners();
    loadDropdownDates();
    fetchAndRender("latest");

    // ──────────────────────────────────────────
    // 1. 在每個 tab-content 內生成卡片容器
    // ──────────────────────────────────────────
    function buildCards() {
        const tabContainers = {};
        document.querySelectorAll(".tab-content").forEach(el => {
            tabContainers[el.id] = el;
        });

        Object.entries(METRIC_CONFIGS).forEach(([key, cfg]) => {
            const parent = tabContainers[cfg.tab];
            if (!parent) return;

            const card = document.createElement("div");
            card.id = `card-${key}`;
            card.className = "h-full";
            card.innerHTML = `
                <div class="p-3 border border-slate-800 dark:border-gray-300 h-full flex flex-col dark:bg-slate-100">
                    <div class="flex justify-between items-baseline mb-2 pb-1 border-b border-slate-800 dark:border-gray-200">
                        <span class="text-sm font-medium text-slate-400 dark:text-gray-600">${cfg.title}</span>
                        <span class="text-xs text-slate-600 dark:text-gray-400">${cfg.unit}</span>
                    </div>
                    <table class="table-fixed w-full text-xs">
                        <thead>
                            <tr class="text-slate-600 dark:text-gray-400 border-b border-slate-800 dark:border-gray-200">
                                <th class="w-1/2 pb-1 text-left font-normal">代號名稱</th>
                                <th class="w-1/5 pb-1 text-right font-normal">收盤</th>
                                <th class="w-[30%] pb-1 text-right font-normal">數值</th>
                            </tr>
                        </thead>
                        <tbody id="body-${key}" class="divide-y divide-slate-900 dark:divide-gray-200">
                            <tr><td colspan="3" class="text-center py-3 text-slate-700 dark:text-gray-400 text-2xs">loading</td></tr>
                        </tbody>
                    </table>
                </div>`;
            parent.appendChild(card);
        });
    }

    // ──────────────────────────────────────────
    // 2. 頁籤切換
    // ──────────────────────────────────────────
    function setupTabListeners() {
        const buttons = document.querySelectorAll(".tab-btn");
        const contents = document.querySelectorAll(".tab-content");

        buttons.forEach(btn => {
            btn.addEventListener("click", () => {
                buttons.forEach(b => {
                    b.classList.remove("border-emerald-500", "text-emerald-500", "dark:text-emerald-600");
                    b.classList.add("border-transparent", "text-slate-500", "dark:text-gray-500");
                });
                btn.classList.remove("border-transparent", "text-slate-500", "dark:text-gray-500");
                btn.classList.add("border-emerald-500", "text-emerald-500", "dark:text-emerald-600");

                contents.forEach(c => c.classList.add("hidden"));

                const target = document.getElementById(btn.dataset.tab);
                if (target) target.classList.remove("hidden");
            });
        });
    }

    // ──────────────────────────────────────────
    // 3. 載入日期下拉選單
    // ──────────────────────────────────────────
    async function loadDropdownDates() {
        try {
            const res = await fetch("./api/dates.json");
            if (!res.ok) return;
            const dates = await res.json();
            dateSelect.innerHTML = '<option value="latest">latest</option>';
            dates.forEach(date => {
                const opt = document.createElement("option");
                opt.value = date;
                opt.textContent = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
                dateSelect.appendChild(opt);
            });
        } catch (e) {
            console.error("dates.json load error:", e);
        }
    }

    // ──────────────────────────────────────────
    // 4. 取得資料 & 渲染
    // ──────────────────────────────────────────
    async function fetchAndRender(option) {
        const url = option === "latest" ? "./api/latest.json" : `./api/dashboard_${option}.json`;
        try {
            const res = await fetch(url);
            const payload = await res.json();
            const rankings = payload.rankings || {};
            const dataDate = payload.data_date || "";
            let dataStatus = payload.data_status || {};

            // 若 dashboard JSON 沒有 data_status（舊版），從全量 status.json 補
            if (!dataStatus || Object.keys(dataStatus).length === 0) {
                const full = await _fullStatusPromise;
                if (full && full.dates && full.dates[dataDate]) {
                    dataStatus = full.dates[dataDate];
                }
            }

            renderStatusBar(dataDate, dataStatus);

            Object.keys(METRIC_CONFIGS).forEach(key => {
                renderTable(key, rankings[key] || []);
            });
        } catch (e) {
            console.error("fetch error:", e);
            renderStatusBar("", null);
            Object.keys(METRIC_CONFIGS).forEach(key => {
                const tbody = document.getElementById(`body-${key}`);
                if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center py-3 text-rose-800 dark:text-rose-500 text-2xs">error</td></tr>`;
            });
        }
    }

    // ──────────────────────────────────────────
    // 5. 渲染單張表格
    // ──────────────────────────────────────────
    function renderTable(metricKey, data) {
        const tbody = document.getElementById(`body-${metricKey}`);
        if (!tbody) return;
        tbody.innerHTML = "";

        if (!data || data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="text-center py-3 text-slate-700 dark:text-gray-400 text-2xs">no signal</td></tr>`;
            return;
        }

        const cfg = METRIC_CONFIGS[metricKey];
        const colorClass = cfg.isBuy ? "text-emerald-500 dark:text-emerald-600" : "text-rose-500 dark:text-rose-500";

        data.forEach(item => {
            const tr = document.createElement("tr");
            tr.className = "hover:bg-slate-900 dark:hover:bg-gray-100";

            const stockId = item.stock_id || "";
            const stockName = item.stock_name || "";
            const closePrice = item.close_price;
            const rawValue = item[cfg.valueKey];

            const displayVal = formatValue(rawValue, cfg.unit);
            const displayPrice = (closePrice != null && !isNaN(closePrice))
                ? Number(closePrice).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
                : "--";

            tr.innerHTML = `
                <td class="py-1.5 pr-1 truncate">
                    <span class="text-2xs text-slate-600 dark:text-gray-400">${stockId}</span>
                    <span class="text-xs text-slate-300 dark:text-gray-800 ml-1">${stockName}</span>
                </td>
                <td class="py-1.5 text-right font-mono text-slate-500 dark:text-gray-500 text-xs">${displayPrice}</td>
                <td class="py-1.5 text-right font-mono font-semibold text-xs ${colorClass}">${displayVal}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // ──────────────────────────────────────────
    // 6. 數值格式化
    // ──────────────────────────────────────────
    function formatValue(val, unit) {
        if (val == null || isNaN(val)) return "--";
        const n = Number(val);
        if (unit === "百萬元") {
            return (n / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        }
        if (unit === "元") {
            return (n / 10000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "萬";
        }
        if (unit === "張") {
            return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
        }
        if (unit === "倍") {
            return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        if (unit === "%") {
            return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
        }
        if (unit === "天") {
            return n.toLocaleString(undefined, { maximumFractionDigits: 0 }) + "天";
        }
        if (unit === "人") {
            return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
        }
        return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    // ──────────────────────────────────────────
    // 7. 資料狀態列渲染
    // ──────────────────────────────────────────
    function renderStatusBar(dataDate, dataStatus) {
        if (!statusBar) return;
        if (!dataDate || !dataStatus) {
            statusBar.innerHTML = `<span class="text-3xs text-slate-700 dark:text-gray-400">狀態載入中...</span>`;
            return;
        }

        const items = [
            { label: "價量上市", key: "price_twse" },
            { label: "價量上櫃", key: "price_tpex" },
            { label: "法人上市", key: "chip_twse" },
            { label: "法人上櫃", key: "chip_tpex" },
            { label: "融資券上市", key: "margin_twse" },
            { label: "融資券上櫃", key: "margin_tpex" },
            { label: "大戶",      key: "tdcc_date", isDate: true },
        ];

        const dots = items.map(item => {
            let ok, extra = "";
            if (item.isDate) {
                ok = !!dataStatus[item.key];
                if (ok && dataStatus[item.key]) {
                    const d = String(dataStatus[item.key]).replace(/-/g, "");
                    extra = d.slice(4,6) + "/" + d.slice(6,8);
                }
            } else {
                ok = !!dataStatus[item.key];
            }
            const color = ok ? "text-emerald-500 dark:text-emerald-600" : "text-slate-700 dark:text-gray-400";
            const dot = `<span class="${color}">●</span>`;
            const extraHtml = extra ? `<span class="text-slate-600 dark:text-gray-400">${extra}</span>` : "";
            return `<span class="inline-flex items-center gap-1">${dot} ${item.label} ${extraHtml}</span>`;
        });

        statusBar.innerHTML = `
            <span class="text-slate-500 dark:text-gray-500 text-3xs mr-1">${dataDate.slice(0,4)}-${dataDate.slice(4,6)}-${dataDate.slice(6,8)}</span>
            ${dots.join('<span class="text-slate-800 dark:text-gray-300 mx-0.5">|</span>')}
        `;
    }

    // ──────────────────────────────────────────
    // 8. 日期切換事件
    // ──────────────────────────────────────────
    dateSelect.addEventListener("change", (e) => {
        fetchAndRender(e.target.value);
    });
});