/**
 * stock-modal.js — 個股歷史資訊彈窗（Modal）
 *
 * 依賴（CDN，在 index.html 中引入）：
 *   - TradingView Lightweight Charts
 *   - Chart.js
 *
 * 資料來源：api/stock/{stock_id}.json（on-demand fetch）
 * 資料順序：時間正序（最舊在前、最新在後）
 */
window.StockModal = (() => {
  'use strict';

  let stockIndex = [];
  let currentStockId = null;
  let lwcChart = null;
  let lwcCandleSeries = null;
  let lwcVolumeSeries = null;
  let lwcMASeries = {};
  let chartJsInstance = null;
  let resizeObserver = null;
  let els = {};

  const MA_WINDOWS = [5, 10, 20, 60, 120, 240];
  const MA_COLORS = { ma5: '#f59e0b', ma10: '#3b82f6', ma20: '#8b5cf6', ma60: '#10b981', ma120: '#f97316', ma240: '#ef4444' };
  const C = { up: 'rgba(239,68,68,0.5)', upBorder: '#ef4444', down: 'rgba(16,185,129,0.5)', downBorder: '#10b981', foreign: '#3b82f6', trust: '#10b981', prop: '#f59e0b' };

  function init() {
    buildModalDOM();
    cacheElements();
    bindEvents();
    loadStockIndex().then(() => bindTableRowClicks());
  }

  function buildModalDOM() {
    const maHTML = MA_WINDOWS.map(w => {
      const cls = w === 5 ? 'text-amber-500' : w === 10 ? 'text-blue-500' : w === 20 ? 'text-violet-500' : w === 60 ? 'text-emerald-500' : w === 120 ? 'text-orange-500' : 'text-red-500';
      return `<label class="inline-flex items-center gap-1 text-2xs cursor-pointer select-none ${cls}"><input type="checkbox" class="ma-toggle rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-0 focus:ring-offset-0" data-ma="ma${w}" ${w <= 20 ? 'checked' : ''}>MA${w}</label>`;
    }).join('');
    const html = `<div id="stock-modal-overlay" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 hidden" style="backdrop-filter:blur(2px);">
      <div id="stock-modal" class="relative w-[90vw] max-w-5xl h-[90vh] max-h-[900px] bg-black border border-slate-800 flex flex-col overflow-hidden shadow-2xl">
        <div class="shrink-0 flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-black/90">
          <div id="modal-header-info" class="flex items-center gap-3 min-w-0"><span class="text-lg font-bold text-slate-100">載入中...</span></div>
          <div class="flex items-center gap-2 shrink-0">
            <button id="modal-btn-cmoney" title="股市同學會" class="hidden text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200">💬 同學會</button>
            <button id="modal-btn-google" title="Google 搜尋" class="hidden text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200">🔍 Google</button>
            <button id="modal-close-btn" class="ml-2 text-slate-500 hover:text-slate-200 text-xl leading-none">&times;</button>
          </div>
        </div>
        <div class="shrink-0 px-3 pt-2 pb-0" style="height:45%;min-height:280px;"><div id="kline-container" class="w-full h-full"></div></div>
        <div id="ma-toggles" class="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-slate-800"><span class="text-2xs text-slate-600 mr-1">均線</span>${maHTML}</div>
        <div class="shrink-0 flex border-b border-slate-800">
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-emerald-500 text-emerald-500" data-subtab="institutional">法人買賣超</button>
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-300" data-subtab="margin">融資融券餘額</button>
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-300" data-subtab="tdcc">集保股權分散</button>
        </div>
        <div class="flex-1 min-h-0 px-3 py-2"><div id="subchart-container" class="w-full h-full relative"><div class="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">選取頁籤以檢視圖表</div></div></div>
      </div>
    </div>`;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstElementChild);
  }

  function cacheElements() {
    els.overlay = document.getElementById('stock-modal-overlay');
    els.headerInfo = document.getElementById('modal-header-info');
    els.closeBtn = document.getElementById('modal-close-btn');
    els.klineContainer = document.getElementById('kline-container');
    els.subchartContainer = document.getElementById('subchart-container');
    els.maToggles = document.querySelectorAll('.ma-toggle');
    els.subTabBtns = document.querySelectorAll('.sub-tab-btn');
    els.btnCmoney = document.getElementById('modal-btn-cmoney');
    els.btnGoogle = document.getElementById('modal-btn-google');
  }

  function bindEvents() {
    els.closeBtn.addEventListener('click', closeModal);
    els.overlay.addEventListener('click', e => { if (e.target === els.overlay) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    els.maToggles.forEach(cb => {
      cb.addEventListener('change', e => { const s = lwcMASeries[e.target.dataset.ma]; if (s) s.applyOptions({ visible: e.target.checked }); });
    });
    els.subTabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        els.subTabBtns.forEach(b => { b.classList.remove('border-emerald-500', 'text-emerald-500'); b.classList.add('border-transparent', 'text-slate-500'); });
        btn.classList.remove('border-transparent', 'text-slate-500');
        btn.classList.add('border-emerald-500', 'text-emerald-500');
        renderSubTab(btn.dataset.subtab);
      });
    });
    els.btnCmoney.addEventListener('click', () => { if (currentStockId) window.open(`https://www.cmoney.tw/forum/stock/${currentStockId}`, '_blank'); });
    els.btnGoogle.addEventListener('click', () => { if (currentStockId) window.open(`https://www.google.com/search?q=${currentStockId}+%E5%81%9A%E4%BB%80%E9%BA%BC`, '_blank'); });
  }

  async function loadStockIndex() {
    try { const r = await fetch('./api/stock/index.json'); if (r.ok) stockIndex = await r.json(); } catch (e) { console.warn('[StockModal] index.json 載入失敗:', e); }
  }

  function bindTableRowClicks() {
    const main = document.querySelector('main');
    if (!main) return;
    main.addEventListener('click', e => {
      let t = e.target;
      while (t && t.tagName !== 'TR') { if (t.tagName === 'TH' || t.tagName === 'THEAD') return; t = t.parentElement; }
      if (!t || t.tagName !== 'TR') return;
      const el = t.querySelector('td:first-child .text-2xs');
      if (el) openStockModal(el.textContent.trim());
    });
  }

  async function openStockModal(stockId) {
    if (!stockId) return;
    currentStockId = stockId;
    els.overlay.classList.remove('hidden');
    els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100">${stockId}</span><span class="text-slate-600 text-xs ml-2">載入中...</span>`;
    els.btnCmoney.classList.add('hidden');
    els.btnGoogle.classList.add('hidden');
    cleanupCharts();
    els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">載入中...</div>';
    try {
      const r = await fetch(`./api/stock/${stockId}.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderHeader(data);
      renderCandlestick(data.price || []);
      els.subTabBtns.forEach(b => { b.classList.remove('border-emerald-500', 'text-emerald-500'); b.classList.add('border-transparent', 'text-slate-500'); });
      const ft = els.subTabBtns[0];
      if (ft) { ft.classList.remove('border-transparent', 'text-slate-500'); ft.classList.add('border-emerald-500', 'text-emerald-500'); }
      renderSubTab('institutional');
    } catch (e) {
      console.error('[StockModal]', e);
      els.headerInfo.innerHTML = `<span class="text-lg font-bold text-rose-500">${stockId}</span><span class="text-rose-700 text-xs ml-2">載入失敗</span>`;
      els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-rose-800 text-xs">無法載入資料</div>';
    }
  }

  function closeModal() { els.overlay.classList.add('hidden'); cleanupCharts(); currentStockId = null; }

  function cleanupCharts() {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (lwcChart) { lwcChart.remove(); lwcChart = null; lwcCandleSeries = null; lwcVolumeSeries = null; lwcMASeries = {}; }
    if (chartJsInstance) { chartJsInstance.destroy(); chartJsInstance = null; }
  }

  function renderHeader(data) {
    const arr = data.price || [];
    const name = data.stock_name || '';
    const industry = data.industry || '';
    const industryBadge = industry ? `<span class="text-2xs text-slate-200 ml-2">${industry}</span>` : '';
    if (!arr.length) { els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100">${currentStockId}</span><span class="text-sm text-slate-400 ml-2">${name}${industryBadge}</span><span class="text-slate-600 text-xs ml-4">暫無價量資料</span>`; return; }
    const last = arr[arr.length - 1], prev = arr.length >= 2 ? arr[arr.length - 2] : null;
    const close = last.close;
    let ch = null, chPct = null;
    if (prev && prev.close != null) { ch = close - prev.close; chPct = (ch / prev.close) * 100; }
    const cc = ch > 0 ? 'text-rose-500' : ch < 0 ? 'text-emerald-500' : 'text-slate-400';
    const ar = ch > 0 ? '▲' : ch < 0 ? '▼' : '—';
    const disp = close != null ? close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
    els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100">${currentStockId}</span><span class="text-sm text-slate-400 ml-2">${name}${industryBadge}</span><span class="text-lg font-mono font-bold text-slate-100 ml-4">${disp}</span>${ch != null ? `<span class="text-sm font-mono font-semibold ${cc} ml-2">${ar} ${ch >= 0 ? '+' : ''}${ch.toFixed(2)} (${chPct >= 0 ? '+' : ''}${chPct.toFixed(2)}%)</span>` : ''}`;
    els.btnCmoney.classList.remove('hidden');
    els.btnGoogle.classList.remove('hidden');
  }

  function renderCandlestick(priceArr) {
    if (!priceArr || !priceArr.length) { els.klineContainer.innerHTML = '<div class="w-full h-full flex items-center justify-center text-slate-700 text-xs">無價量資料</div>'; return; }
    els.klineContainer.innerHTML = '';
    lwcChart = LightweightCharts.createChart(els.klineContainer, {
      layout: { background: { type: 'solid', color: '#000000' }, textColor: '#94a3b8', fontSize: 10 },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: '#475569', width: 1, labelBackgroundColor: '#334155' }, horzLine: { color: '#475569', width: 1, labelBackgroundColor: '#334155' } },
      rightPriceScale: { borderColor: '#334155', scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderColor: '#334155', timeVisible: true, secondsVisible: false },
      handleScroll: { vertTouchDrag: false },
    });
    resizeObserver = new ResizeObserver(entries => { for (const e of entries) { const { width, height } = e.contentRect; if (lwcChart && width > 0 && height > 0) lwcChart.applyOptions({ width, height }); } });
    resizeObserver.observe(els.klineContainer);
    lwcCandleSeries = lwcChart.addCandlestickSeries({ upColor: C.upBorder, downColor: C.downBorder, borderUpColor: C.upBorder, borderDownColor: C.downBorder, wickUpColor: C.upBorder, wickDownColor: C.downBorder });
    lwcCandleSeries.setData(priceArr.map(p => ({ time: p.date, open: p.open, high: p.high, low: p.low, close: p.close })));
    lwcVolumeSeries = lwcChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
    lwcChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0.02 } });
    lwcVolumeSeries.setData(priceArr.map(p => ({ time: p.date, value: p.volume || 0, color: p.close >= p.open ? C.up : C.down })));
    MA_WINDOWS.forEach(w => {
      const key = 'ma' + w;
      const s = lwcChart.addLineSeries({ color: MA_COLORS[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: w <= 20 });
      const d = []; priceArr.forEach(p => { if (p[key] != null) d.push({ time: p.date, value: p[key] }); });
      s.setData(d);
      lwcMASeries[key] = s;
    });
    const len = priceArr.length;
    if (len > 0) {
      const from = priceArr[Math.max(0, len - 60)].date;
      const to = priceArr[len - 1].date;
      lwcChart.timeScale().setVisibleRange({ from, to });
    }
    els.maToggles.forEach(cb => { const s = lwcMASeries[cb.dataset.ma]; if (s) s.applyOptions({ visible: cb.checked }); });
  }

  function renderSubTab(tab) {
    if (!currentStockId) return;
    fetch(`./api/stock/${currentStockId}.json`).then(r => r.json()).then(data => {
      if (chartJsInstance) { chartJsInstance.destroy(); chartJsInstance = null; }
      if (tab === 'institutional') renderInstitutional(data.institutional || []);
      else if (tab === 'margin') renderMargin(data.margin || []);
      else if (tab === 'tdcc') renderTdccPyramid(data.tdcc || []);
    }).catch(() => { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-rose-800 text-xs">載入失敗</div>'; });
  }

  function renderInstitutional(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">無法人買賣超資料</div>'; return; }
    const canvas = document.createElement('canvas');
    els.subchartContainer.innerHTML = '';
    els.subchartContainer.appendChild(canvas);
    chartJsInstance = new Chart(canvas, {
      type: 'bar',
      data: { labels: data.map(d => d.date.slice(5)), datasets: [
        { label: '外資', data: data.map(d => (d.foreign_buy_sell || 0) / 1000), backgroundColor: C.foreign, borderRadius: 1 },
        { label: '投信', data: data.map(d => (d.trust_buy_sell || 0) / 1000), backgroundColor: C.trust, borderRadius: 1 },
        { label: '自營商', data: data.map(d => (d.prop_buy_sell || 0) / 1000), backgroundColor: C.prop, borderRadius: 1 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12, padding: 8 } }, tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(0)} 張` } } },
        scales: { x: { ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: '#1e293b' }, title: { display: true, text: '千張', color: '#64748b', font: { size: 9 } } } },
      },
    });
  }

  function renderMargin(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">無融資券資料</div>'; return; }
    const canvas = document.createElement('canvas');
    els.subchartContainer.innerHTML = '';
    els.subchartContainer.appendChild(canvas);
    chartJsInstance = new Chart(canvas, {
      type: 'line',
      data: { labels: data.map(d => d.date.slice(5)), datasets: [
        { label: '融資餘額', data: data.map(d => (d.fin_balance || 0)), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHitRadius: 8 },
        { label: '融券餘額', data: data.map(d => (d.mar_balance || 0)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHitRadius: 8, yAxisID: 'y1' },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 12, padding: 8 } }, tooltip: { backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#cbd5e1', borderColor: '#334155', borderWidth: 1, callbacks: { label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y / 10000).toFixed(1)} 萬` } } },
        scales: {
          x: { ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45 }, grid: { color: '#1e293b' } },
          y: { position: 'left', ticks: { color: '#f59e0b', font: { size: 9 }, callback: v => (v / 10000).toFixed(1) + '萬' }, grid: { color: '#1e293b' }, title: { display: true, text: '融資', color: '#f59e0b', font: { size: 9 } } },
          y1: { position: 'right', ticks: { color: '#3b82f6', font: { size: 9 }, callback: v => v.toFixed(0) }, grid: { display: false }, title: { display: true, text: '融券', color: '#3b82f6', font: { size: 9 } } },
        },
      },
    });
  }

  function renderTdccPyramid(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">無集保資料</div>'; return; }

    let selectedIndex = data.length - 1;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

    const nav = document.createElement('div');
    nav.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:2px 0;flex-shrink:0;';
    const btnPrev = document.createElement('button');
    btnPrev.textContent = '◀';
    btnPrev.style.cssText = 'background:none;border:1px solid #334155;color:#94a3b8;border-radius:4px;width:28px;height:24px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;';
    const spanDate = document.createElement('span');
    spanDate.style.cssText = 'font-size:12px;color:#cbd5e1;font-weight:600;min-width:80px;text-align:center;';
    const btnNext = document.createElement('button');
    btnNext.textContent = '▶';
    btnNext.style.cssText = 'background:none;border:1px solid #334155;color:#94a3b8;border-radius:4px;width:28px;height:24px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;';
    nav.appendChild(btnPrev);
    nav.appendChild(spanDate);
    nav.appendChild(btnNext);
    wrapper.appendChild(nav);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;min-height:0;';
    const chartDiv = document.createElement('div');
    chartDiv.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:2px 76px;position:relative;';
    body.appendChild(chartDiv);
    wrapper.appendChild(body);

    els.subchartContainer.innerHTML = '';
    els.subchartContainer.appendChild(wrapper);

    function draw() {
      chartDiv.innerHTML = '';
      const cur = data[selectedIndex];
      const prev = selectedIndex > 0 ? data[selectedIndex - 1] : null;
      const rawDate = cur.date || '';
      const fmtDate = rawDate.length === 8 ? rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8) : rawDate;
      spanDate.textContent = fmtDate;
      btnPrev.disabled = (selectedIndex <= 1);
      btnPrev.style.opacity = selectedIndex <= 1 ? '0.3' : '1';
      btnNext.disabled = (selectedIndex >= data.length - 1);
      btnNext.style.opacity = selectedIndex >= data.length - 1 ? '0.3' : '1';

      let levels = [...(cur.levels || [])];
      if (!levels.length) { chartDiv.innerHTML = '<div class="text-slate-700 text-xs text-center py-4">無持股分級資料</div>'; return; }
      levels = levels.reverse();

      const maxCount = Math.max(...levels.map(l => l.count || 0), 1);
      const maxRatio = Math.max(...levels.map(l => l.ratio || 0), 1);
      const prevMap = {};
      if (prev && prev.levels) { for (const pl of prev.levels) { prevMap[pl.code] = pl; } }
      const MAX_PCT = 94;

      // 垂直漂浮標籤
      const leftLabel = document.createElement('div');
      leftLabel.style.cssText = 'position:absolute;left:6px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
      leftLabel.innerHTML = '<span style="writing-mode:vertical-rl;text-orientation:mixed;font-size:16px;color:#64748b;white-space:nowrap;letter-spacing:3px;opacity:0.5;">持股人數</span>';
      const rightLabel = document.createElement('div');
      rightLabel.style.cssText = 'position:absolute;right:6px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
      rightLabel.innerHTML = '<span style="writing-mode:vertical-rl;text-orientation:mixed;font-size:16px;color:#64748b;white-space:nowrap;letter-spacing:3px;opacity:0.5;">持股比例</span>';
      chartDiv.appendChild(leftLabel);
      chartDiv.appendChild(rightLabel);

      // 差值顯示
      function diffSpan(diff, isRatio) {
        const suffix = isRatio ? '%' : '人';
        if (diff > 0) return `<span style="color:#ef4444;font-size:11px;">▲ +${diff.toLocaleString(undefined, {minimumFractionDigits: isRatio ? 2 : 0, maximumFractionDigits: isRatio ? 2 : 0})}${suffix}</span>`;
        if (diff < 0) return `<span style="color:#10b981;font-size:11px;">▼ -${Math.abs(diff).toLocaleString(undefined, {minimumFractionDigits: isRatio ? 2 : 0, maximumFractionDigits: isRatio ? 2 : 0})}${suffix}</span>`;
        if (isRatio) return `<span style="color:#475569;font-size:11px;">— +0.00%</span>`;
        return `<span style="color:#475569;font-size:10px;">— +0人</span>`;
      }

      for (const level of levels) {
        const count = level.count || 0;
        const ratio = level.ratio || 0;
        let countPct = maxCount > 0 ? (count / maxCount) * MAX_PCT : 0;
        let ratioPct = maxRatio > 0 ? (ratio / maxRatio) * MAX_PCT : 0;
        let countDiff = 0, ratioDiff = 0;
        if (prevMap[level.code] != null) {
          countDiff = count - (prevMap[level.code].count || 0);
          ratioDiff = ratio - (prevMap[level.code].ratio || 0);
        }
        const countFmt = count.toLocaleString() + '人';
        const ratioFmt = ratio.toFixed(2) + '%';

        // 整列 hover 微亮
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;min-height:18px;margin:0 0;cursor:default;';
        row.addEventListener('mouseenter', () => { row.style.backgroundColor = 'rgba(255,255,255,0.15)'; });
        row.addEventListener('mouseleave', () => { row.style.backgroundColor = ''; });

        // 左：人數差值
        const countDiffOuter = document.createElement('span');
        countDiffOuter.style.cssText = 'flex-shrink:0;width:60px;text-align:left;font-size:11px;white-space:nowrap;';
        countDiffOuter.innerHTML = prev ? diffSpan(countDiff, false) : '';
        row.appendChild(countDiffOuter);

        // 左：人數 bar
        const leftBarWrap = document.createElement('div');
        leftBarWrap.style.cssText = 'flex:1;display:flex;flex-direction:row-reverse;align-items:center;height:17px;';
        const leftBar = document.createElement('div');
        leftBar.style.cssText =
          `height:17px;width:${countPct.toFixed(1)}%;min-width:2px;` +
          `background:#3b82f6;border-radius:4px 0 0 4px;` +
          `position:relative;display:flex;align-items:center;justify-content:flex-end;padding-right:2px;`;
        leftBar.innerHTML = `<span style="color:#e2e8f0;font-size:10px;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7);">${countFmt}</span>`;
        leftBarWrap.appendChild(leftBar);
        row.appendChild(leftBarWrap);

        // 中：級距
        const midCol = document.createElement('div');
        midCol.style.cssText =
          'flex:0 0 auto;width:90px;text-align:center;font-size:11px;' +
          'color:#cbd5e1;padding:0 3px;white-space:nowrap;';
        midCol.textContent = level.level || '';
        row.appendChild(midCol);

        // 右：比例 bar
        const rightBarWrap = document.createElement('div');
        rightBarWrap.style.cssText = 'flex:1;display:flex;align-items:center;height:17px;';
        const rightBar = document.createElement('div');
        rightBar.style.cssText =
          `height:17px;width:${ratioPct.toFixed(1)}%;min-width:2px;` +
          `background:#3b82f6;border-radius:0 4px 4px 0;` +
          `position:relative;display:flex;align-items:center;padding-left:2px;`;
        rightBar.innerHTML = `<span style="color:#e2e8f0;font-size:10px;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7);">${ratioFmt}</span>`;
        rightBarWrap.appendChild(rightBar);
        row.appendChild(rightBarWrap);

        // 右：比例差值
        const ratioDiffOuter = document.createElement('span');
        ratioDiffOuter.style.cssText = 'flex-shrink:0;width:60px;text-align:left;font-size:11px;white-space:nowrap;';
        ratioDiffOuter.innerHTML = prev ? diffSpan(ratioDiff, true) : '';
        row.appendChild(ratioDiffOuter);

        chartDiv.appendChild(row);
      }
    }

    btnPrev.addEventListener('click', () => { if (selectedIndex > 1) { selectedIndex--; draw(); } });
    btnNext.addEventListener('click', () => { if (selectedIndex < data.length - 1) { selectedIndex++; draw(); } });
    draw();
  }

  return { init, openStockModal };
})();