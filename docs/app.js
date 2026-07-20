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
    // Watchlist state
    // ──────────────────────────────────────────
    const WATCHLIST_SORT_STATE = { field: null, asc: null };
    let _snapshotCache = null;
    let _watchlistDirty = false;

    // ──────────────────────────────────────────
    // 初始化
    // ──────────────────────────────────────────
    const _fullStatusPromise = fetch("./api/status.json").then(r => r.json()).catch(() => null);

    buildCards();
    setupTabListeners();
    setupWatchlistListeners();
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
                <div class="p-3 border border-slate-200 dark:border-slate-700 h-full flex flex-col bg-white dark:bg-slate-900">
                    <div class="flex justify-between items-baseline mb-2 pb-1 border-b border-slate-200 dark:border-slate-700">
                        <span class="text-sm font-medium text-slate-600 dark:text-slate-400">${cfg.title}</span>
                        <span class="text-xs text-slate-400 dark:text-slate-500">${cfg.unit}</span>
                    </div>
                    <table class="table-fixed w-full text-xs">
                        <thead>
                            <tr class="text-slate-400 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
                                <th class="w-1/2 pb-1 text-left font-normal">代號名稱</th>
                                <th class="w-1/5 pb-1 text-right font-normal">收盤</th>
                                <th class="w-[30%] pb-1 text-right font-normal">數值</th>
                            </tr>
                        </thead>
                        <tbody id="body-${key}" class="divide-y divide-slate-100 dark:divide-slate-800">
                            <tr><td colspan="3" class="text-center py-3 text-slate-400 dark:text-slate-500 text-2xs">loading</td></tr>
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
                    b.classList.remove("border-emerald-500", "text-emerald-500", "dark:text-emerald-500");
                    b.classList.add("border-transparent", "text-slate-400", "dark:text-slate-400");
                });
                btn.classList.remove("border-transparent", "text-slate-400", "dark:text-slate-400");
                btn.classList.add("border-emerald-500", "text-emerald-500", "dark:text-emerald-500");

                contents.forEach(c => c.classList.add("hidden"));

                const target = document.getElementById(btn.dataset.tab);
                if (target) target.classList.remove("hidden");

                // 切換至自選頁籤時觸發渲染（含 dirty flag 檢查）
                if (btn.dataset.tab === "tab-watchlist") {
                    if (_watchlistDirty) {
                        _snapshotCache = null;
                        const select = document.getElementById("watchlist-select");
                        const ws = window.WatchlistStore;
                        if (select && ws) populateWatchlistSelect(select, ws);
                        _watchlistDirty = false;
                    }
                    fetchAndRenderWatchlist();
                }
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
                if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center py-3 text-rose-600 dark:text-rose-400 text-2xs">error</td></tr>`;
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
            tbody.innerHTML = `<tr><td colspan="3" class="text-center py-3 text-slate-400 dark:text-slate-500 text-2xs">no signal</td></tr>`;
            return;
        }

        const cfg = METRIC_CONFIGS[metricKey];
        const colorClass = cfg.isBuy ? "text-emerald-600 dark:text-emerald-500" : "text-rose-500 dark:text-rose-500";

        data.forEach(item => {
            const tr = document.createElement("tr");
            tr.className = "hover:bg-slate-100 dark:hover:bg-slate-800";

            const stockId = item.stock_id || "";
            const stockName = item.stock_name || "";
            const closePrice = item.close_price;
            const rawValue = item[cfg.valueKey];

            const displayVal = formatValue(rawValue, cfg.unit);
            const displayPrice = (closePrice != null && !isNaN(closePrice))
                ? Number(closePrice).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
                : "--";

            tr.innerHTML = `
                <td class="py-2 pr-1 truncate">
                    <span class="text-2xs text-slate-200 dark:text-slate-600">${stockId}</span>
                    <span class="text-xs text-slate-200 dark:text-slate-300 ml-1">${stockName}</span>
                </td>
                <td class="py-2 text-right font-mono text-slate-400 dark:text-slate-500 text-xs">${displayPrice}</td>
                <td class="py-2 text-right font-mono font-semibold text-xs ${colorClass}">${displayVal}</td>
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
            statusBar.innerHTML = `<span class="text-3xs text-slate-400 dark:text-slate-500">狀態載入中...</span>`;
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
            const color = ok ? "text-emerald-600 dark:text-emerald-500" : "text-slate-400 dark:text-slate-500";
            const dot = `<span class="${color}">●</span>`;
            const extraHtml = extra ? `<span class="text-slate-400 dark:text-slate-500">${extra}</span>` : "";
            return `<span class="inline-flex items-center gap-1">${dot} ${item.label} ${extraHtml}</span>`;
        });

        statusBar.innerHTML = `
            <span class="text-slate-400 dark:text-slate-500 text-3xs mr-1">${dataDate.slice(0,4)}-${dataDate.slice(4,6)}-${dataDate.slice(6,8)}</span>
            ${dots.join('<span class="text-slate-300 dark:text-slate-700 mx-0.5">|</span>')}
        `;
    }

    // ──────────────────────────────────────────
    // 8. 日期切換事件
    // ──────────────────────────────────────────
    dateSelect.addEventListener("change", (e) => {
        fetchAndRender(e.target.value);
    });

    // ──────────────────────────────────────────
    // 9. Watchlist: 設定監聽器
    // ──────────────────────────────────────────
    function setupWatchlistListeners() {
        // watchlistchange 全域事件
        window.addEventListener("watchlistchange", () => {
            const watchlistTab = document.getElementById("tab-watchlist");
            const isVisible = watchlistTab && !watchlistTab.classList.contains("hidden");

            if (isVisible) {
                // 可見 → 立即重繪
                const select = document.getElementById("watchlist-select");
                const ws = window.WatchlistStore;
                if (select && ws) populateWatchlistSelect(select, ws);
                _snapshotCache = null;
                _watchlistDirty = false;
                fetchAndRenderWatchlist();
            } else {
                // 不可見 → 標記 dirty
                _watchlistDirty = true;
            }
        });

        // select 切換
        const select = document.getElementById("watchlist-select");
        if (select) {
            select.addEventListener("change", (e) => {
                const ws = window.WatchlistStore;
                if (!ws) return;
                ws.setActiveList(e.target.value);
            });
        }

        // 表格排序（三態循環：指定欄位升序 → 降序 → 回自訂原始順序）
        // 監聽器掛在 span[data-sort] 上，避免點擊 th 空白處誤觸
        document.querySelectorAll("#watchlist-table [data-sort]").forEach(el => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                const field = el.dataset.sort;
                if (WATCHLIST_SORT_STATE.field === field) {
                    if (WATCHLIST_SORT_STATE.asc === true) {
                        // 升序 → 降序
                        WATCHLIST_SORT_STATE.asc = false;
                    } else if (WATCHLIST_SORT_STATE.asc === false) {
                        // 降序 → 回自訂排序（原始 ids 陣列順序）
                        WATCHLIST_SORT_STATE.field = null;
                        WATCHLIST_SORT_STATE.asc = null;
                    }
                } else {
                    // 不同欄位 → 升序
                    WATCHLIST_SORT_STATE.field = field;
                    WATCHLIST_SORT_STATE.asc = true;
                }
                fetchAndRenderWatchlist();
                });
        });

        // 編輯按鈕 → 開啟管理 Modal
        const editTrigger = document.getElementById("watchlist-edit-trigger");
        if (editTrigger) {
            editTrigger.addEventListener("click", () => {
                if (typeof window.WatchlistManagerModal !== "undefined" && window.WatchlistManagerModal.open) {
                    window.WatchlistManagerModal.open();
                }
            });
        }
    }

    // ──────────────────────────────────────────
    // 10. Watchlist: populate dropdown
    // ──────────────────────────────────────────
    function populateWatchlistSelect(select, ws) {
        const lists = ws.getAllLists();
        const active = ws.getActiveListName();
        select.innerHTML = "";
        Object.keys(lists).forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = `${name} (${lists[name].length})`;
            select.appendChild(opt);
        });
        select.value = active;
    }

    // ──────────────────────────────────────────
    // 11. Watchlist: fetch & render
    // ──────────────────────────────────────────
    async function fetchAndRenderWatchlist() {
        const tbody = document.getElementById("watchlist-tbody");
        const select = document.getElementById("watchlist-select");
        if (!tbody || !select) return;

        const ws = window.WatchlistStore;
        if (!ws) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-3 text-slate-400 dark:text-slate-500 text-2xs">WatchlistStore 未載入</td></tr>`;
            return;
        }

        // 初始化下拉選單
        populateWatchlistSelect(select, ws);

        const ids = ws.getActiveIds();
        if (!ids.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-3 text-slate-400 dark:text-slate-500 text-2xs">尚無自選股</td></tr>`;
            return;
        }

        // 非同步載入 snapshot
        if (!_snapshotCache) {
            try {
                const res = await fetch("./api/snapshot.json");
                if (!res.ok) throw new Error("fetch failed");
                _snapshotCache = await res.json();
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center py-3 text-rose-600 dark:text-rose-400 text-2xs">snapshot 載入失敗</td></tr>`;
                return;
            }
        }

        const stocks = _snapshotCache.stocks || {};
        const rows = [];
        for (let i = 0; i < ids.length; i++) {
            const sid = ids[i];
            const s = stocks[sid];
            if (!s) continue;
            rows.push({
                _order: i,
                stock_id: sid,
                stock_name: s.n || "",
                close: s.c,
                change: s.d,
                change_pct: s.p,
                volume: s.v
            });
        }

        sortWatchlistRows(rows, WATCHLIST_SORT_STATE.field, WATCHLIST_SORT_STATE.asc);
        renderWatchlistTable(tbody, rows);
        updateSortIndicators();
    }

    // ──────────────────────────────────────────
    // 12. Watchlist: sorting
    // ──────────────────────────────────────────
    function sortWatchlistRows(rows, field, asc) {
        if (field === null) {
            rows.sort((a, b) => (a._order || 0) - (b._order || 0));
            return;
        }
        rows.sort((a, b) => {
            let va = a[field], vb = b[field];
            if (va == null) va = 0;
            if (vb == null) vb = 0;
            if (typeof va === "string") va = va.toLowerCase();
            if (typeof vb === "string") vb = vb.toLowerCase();
            if (va < vb) return asc ? -1 : 1;
            if (va > vb) return asc ? 1 : -1;
            return 0;
        });
    }

    // ──────────────────────────────────────────
    // 13. Watchlist: render table
    // ──────────────────────────────────────────
    function renderWatchlistTable(tbody, rows) {
        tbody.innerHTML = "";
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-3 text-slate-400 dark:text-slate-500 text-2xs">無符合資料</td></tr>`;
            return;
        }
        rows.forEach(r => {
            const closeStr = (r.close != null && !isNaN(r.close))
                ? Number(r.close).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "--";
            const changeStr = (r.change != null && !isNaN(r.change))
                ? (r.change > 0 ? "+" : "") + Number(r.change).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "--";
            const pctStr = (r.change_pct != null && !isNaN(r.change_pct))
                ? (r.change_pct > 0 ? "+" : "") + Number(r.change_pct).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"
                : "--";
            const volStr = (r.volume != null && !isNaN(r.volume))
                ? Number(r.volume).toLocaleString(undefined, { maximumFractionDigits: 0 })
                : "--";

            const changeCls = (r.change != null) ? (r.change > 0 ? "text-emerald-500" : r.change < 0 ? "text-rose-500" : "text-slate-500") : "text-slate-500";
            const pctCls = (r.change_pct != null) ? (r.change_pct > 0 ? "text-emerald-500" : r.change_pct < 0 ? "text-rose-500" : "text-slate-500") : "text-slate-500";

            const tr = document.createElement("tr");
            tr.className = "hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer";
            tr.dataset.stockId = r.stock_id;
            tr.innerHTML = `
                <td class="py-2 px-2 text-slate-200 dark:text-slate-500 font-mono">${r.stock_id}</td>
                <td class="py-2 px-2 text-slate-200 dark:text-slate-300">${r.stock_name}</td>
                <td class="py-2 px-2 text-right font-mono text-slate-200 dark:text-slate-300">${closeStr}</td>
                <td class="py-2 px-2 text-right font-mono ${changeCls}">${changeStr}</td>
                <td class="py-2 px-2 text-right font-mono ${pctCls}">${pctStr}</td>
                <td class="py-2 px-2 text-right font-mono text-slate-400 dark:text-slate-500">${volStr}</td>
            `;
            tr.addEventListener("click", () => {
                if (typeof StockModal !== "undefined" && StockModal.openStockModal) {
                    StockModal.openStockModal(r.stock_id);
                }
            });
            tbody.appendChild(tr);
        });
    }

    // ──────────────────────────────────────────
    // 14. Watchlist: sort indicator arrows
    // ──────────────────────────────────────────
    function updateSortIndicators() {
        document.querySelectorAll("#watchlist-table th").forEach(th => {
            const span = th.querySelector("[data-sort]");
            if (!span) return;
            const field = span.dataset.sort;
            // 清除該 span 內所有舊箭頭
            span.querySelectorAll(".sort-arrow").forEach(a => a.remove());

            if (WATCHLIST_SORT_STATE.field === field) {
                const arrow = document.createElement("span");
                arrow.className = "sort-arrow";
                arrow.textContent = WATCHLIST_SORT_STATE.asc ? "▲" : "▼";
                if (th.classList.contains("text-right")) {
                    // 靠右欄位：箭頭置於文字左側，避免靠右文字被推擠位移
                    arrow.className += " mr-1";
                    span.prepend(arrow);
                } else {
                    arrow.className += " ml-1";
                    span.appendChild(arrow);
                }
            }
        });
    }
});