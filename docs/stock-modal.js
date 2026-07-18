/**
 * stock-modal.js — 個股歷史資訊彈窗（Modal）
 *
 * 依賴（CDN，在 index.html 中引入）：
 *   - TradingView Lightweight Charts
 *   - Chart.js
 *
 * 資料來源：api/stock/{stock_id}.json（on-demand fetch）
 * 資料順序：時間正序（最舊在前、最新在後）
 *
 * 支援 Dark/Light theme 切換：
 *   - 監聽 window 'themechange' event → applyOptions / update('none')
 *   - inline style 顏色已改用 Tailwind utility class，由 Tailwind dark: 機制自動處理
 */
window.StockModal = (() => {
  'use strict';

  let stockIndex = [];
  let currentStockId = null;
  let lwcChart = null;
  let lwcCandleSeries = null;
  let lwcVolumeSeries = null;
  let lwcMASeries = {};
  let lwcBBUpper = null;
  let lwcBBLower = null;
  let chartJsInstance = null;
  let chartJsType = null; // 'institutional' | 'margin' | null — 用於 theme toggle 時 rebuild 配色
  let resizeObserver = null;
  let els = {};
  let currentMode = 'ma';
  let lastPriceBar = null;

  const MA_WINDOWS = [5, 10, 20, 60, 120, 240];
  const MA_COLORS = { ma5: '#06b0df', ma10: '#fa8beb', ma20: '#8b5cf6', ma60: '#10b981', ma120: '#ff6a07', ma240: '#f42929' };
  const MA_COLORS_LIGHT = { ma5: '#00acfc', ma10: '#de62ce', ma20: '#6d28d9', ma60: '#059669', ma120: '#d95c08', ma240: '#de1d1d' };
  const BB_COLOR = '#a78bfa';
  const C = { up: 'rgba(239,68,68,0.5)', upBorder: '#ef4444', down: 'rgba(16,185,129,0.5)', downBorder: '#10b981', foreign: '#3b82f6', trust: '#10b981', prop: '#f59e0b' };

  // ── Theme color configs for Lightweight Charts & Chart.js ──
  const LWC_THEME = {
    dark: {
      bg: '#000000', text: '#94a3b8', grid: '#1e293b',
      crosshairLine: '#475569', crosshairLabelBg: '#334155',
      border: '#334155',
    },
    light: {
      bg: '#ffffff', text: '#475569', grid: '#e2e8f0',
      crosshairLine: '#94a3b8', crosshairLabelBg: '#cbd5e1',
      border: '#cbd5e1',
    },
  };

  const CHARTJS_THEME = {
    dark: {
      legendColor: '#94a3b8', tooltipBg: '#1e293b', tooltipTitle: '#f1f5f9', tooltipBody: '#cbd5e1', tooltipBorder: '#334155',
      gridColor: '#1e293b', tickColor: '#64748b',
      yGridColor: '#1e293b', yTickColor: '#64748b',
    },
    light: {
      legendColor: '#475569', tooltipBg: '#f1f5f9', tooltipTitle: '#1e293b', tooltipBody: '#475569', tooltipBorder: '#cbd5e1',
      gridColor: '#e2e8f0', tickColor: '#64748b',
      yGridColor: '#e2e8f0', yTickColor: '#64748b',
    },
  };

  function isDarkMode() {
    return !document.documentElement.classList.contains('dark');
  }

  function init() {
    buildModalDOM();
    cacheElements();
    bindEvents();
    loadStockIndex().then(() => bindTableRowClicks());
  }

  function buildModalDOM() {
    // MA capsule buttons (using data-active for state management)
    const maCapsules = MA_WINDOWS.map(w => {
      const key = 'ma' + w;
      const color = MA_COLORS[key]; // e.g. '#f59e0b'
      const active = w <= 20 ? 'true' : 'false';
      // active: colored bg; inactive: transparent tailwind classes (dark-aware)
      const activeBg = `background:${color};color:${isDarkMode()?'#000':'#fff'};border-color:${color}`;
      const inactiveClass = 'bg-transparent text-slate-500 border-slate-700 dark:text-slate-400 dark:border-slate-300';
      const baseStyle = 'padding:2px 7px;font-size:10px;border-radius:9999px;border-width:1px;border-style:solid;cursor:pointer;transition:all 150ms ease;font-family:monospace;line-height:1.4;user-select:none;';
      return `<button class="ma-capsule ${active === 'false' ? inactiveClass : ''}" data-ma="${key}" data-active="${active}" style="${baseStyle}${active === 'true' ? activeBg : ''}">MA${w}</button>`;
    }).join('');
    const html = `<div id="stock-modal-overlay" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 dark:bg-black/40 hidden" style="backdrop-filter:blur(2px);">
      <div id="stock-modal" class="relative w-[90vw] max-w-5xl h-[90vh] max-h-[900px] bg-black dark:bg-white border border-slate-800 dark:border-gray-300 flex flex-col overflow-hidden shadow-2xl">
        <div class="shrink-0 flex items-center justify-between px-4 py-2 border-b border-slate-800 dark:border-gray-200 bg-black/90 dark:bg-white/90">
          <div id="modal-header-info" class="flex items-center gap-3 min-w-0"><span class="text-lg font-bold text-slate-100 dark:text-gray-900">載入中...</span></div>
          <div class="flex items-center gap-2 shrink-0">
             <button id="modal-btn-cmoney" title="股市同學會" class="hidden text-xs px-2 py-1 rounded bg-slate-800 dark:bg-gray-100 hover:bg-slate-700 dark:hover:bg-gray-200 text-slate-400 dark:text-gray-500 hover:text-slate-200 dark:hover:text-gray-700 flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>同學會</button>
             <button id="modal-btn-google" title="Google 搜尋" class="hidden text-xs px-2 py-1 rounded bg-slate-800 dark:bg-gray-100 hover:bg-slate-700 dark:hover:bg-gray-200 text-slate-400 dark:text-gray-500 hover:text-slate-200 dark:hover:text-gray-700 flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>做什麼</button>
            <button id="modal-close-btn" class="ml-2 text-slate-500 dark:text-gray-400 hover:text-slate-200 dark:hover:text-gray-700 text-xl leading-none">&times;</button>
          </div>
        </div>
        <div class="shrink-0 px-3 pt-2 pb-0" style="height:45%;min-height:280px;">
          <div id="kline-container" class="w-full h-full"></div>
        </div>
        <div class="shrink-0 flex items-center px-3 py-1 gap-2 border-b border-slate-800 dark:border-gray-200" style="min-height:38px;">
          <div id="hover-legend" class="flex-1 min-w-0 overflow-hidden flex flex-col justify-center text-slate-400 dark:text-slate-500" style="font-size:11px;font-family:monospace;line-height:1.25;">
            <div id="hover-legend-line1" style="white-space:nowrap;"></div>
            <div id="hover-legend-line2" style="white-space:nowrap;"></div>
          </div>
          <span id="ma-checkboxes" class="inline-flex flex-wrap items-center gap-1.5 shrink-0">${maCapsules}</span>
          <div class="flex rounded bg-slate-800 dark:bg-gray-100 p-0.5 shrink-0">
            <button id="mode-btn-ma" class="px-2 py-0.5 rounded bg-slate-700 dark:bg-gray-200 text-slate-200 dark:text-gray-800" style="font-size:11px;">MA</button>
            <button id="mode-btn-bb" class="px-2 py-0.5 rounded text-slate-500 dark:text-gray-400" style="font-size:11px;">BB</button>
          </div>
        </div>
        <div class="shrink-0 flex border-b border-slate-800 dark:border-gray-200">
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-emerald-500 text-emerald-500 dark:text-emerald-600" data-subtab="institutional">法人買賣超</button>
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-transparent text-slate-500 dark:text-gray-400 hover:text-slate-300 dark:hover:text-gray-600" data-subtab="margin">融資融券餘額</button>
          <button class="sub-tab-btn px-3 py-1.5 text-xs font-medium border-b-2 border-transparent text-slate-500 dark:text-gray-400 hover:text-slate-300 dark:hover:text-gray-600" data-subtab="tdcc">集保股權分散</button>
        </div>
        <div class="flex-1 min-h-0 px-3 py-2"><div id="subchart-container" class="w-full h-full relative"><div class="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">選取頁籤以檢視圖表</div></div></div>
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
    els.maToggles = document.querySelectorAll('.ma-capsule');
    els.subTabBtns = document.querySelectorAll('.sub-tab-btn');
    els.btnCmoney = document.getElementById('modal-btn-cmoney');
    els.btnGoogle = document.getElementById('modal-btn-google');
    els.btnModeMa = document.getElementById('mode-btn-ma');
    els.btnModeBb = document.getElementById('mode-btn-bb');
    els.maCheckboxes = document.getElementById('ma-checkboxes');
    els.hoverLegend = document.getElementById('hover-legend');
    els.hoverLegendLine1 = document.getElementById('hover-legend-line1');
    els.hoverLegendLine2 = document.getElementById('hover-legend-line2');
  }

  /** Format a number for hover legend display */
  function fmtNum(v) {
    if (v == null || isNaN(v)) return '—';
    if (Math.abs(v) >= 1000 || Math.abs(v) < 1) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dec = Math.abs(v) >= 10 ? 0 : 2;
    return v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  /** Render hover legend panel with given price bar and mode */
  function updateHoverLegend(bar, mode) {
    const el1 = els.hoverLegendLine1;
    const el2 = els.hoverLegendLine2;
    if (!el1 || !el2) return;
    if (!bar) bar = lastPriceBar;
    if (!bar) return;
    const dateStr = bar.date || '';
    const fmtDate = dateStr.length === 8 ? dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8) : dateStr;
    // 使用 Tailwind class 取代 inline style color
    let line1 = `<span class="text-slate-500 dark:text-slate-400">${fmtDate}</span> `;
    line1 += `<span class="text-slate-500 dark:text-slate-400">開: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.open)}</span> `;
    line1 += `<span class="text-slate-500 dark:text-slate-400">高: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.high)}</span> `;
    line1 += `<span class="text-slate-500 dark:text-slate-400">低: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.low)}</span> `;
    line1 += `<span class="text-slate-500 dark:text-slate-400">收: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.close)}</span> `;
    line1 += `<span class="text-slate-500 dark:text-slate-400">量: </span><span class="text-slate-200 dark:text-gray-800">${bar.volume != null ? Math.round(bar.volume / 1000).toLocaleString() : '—'}</span>`;
    let line2 = '';
    if (mode === 'ma') {
      els.maToggles.forEach(btn => {
        if (btn.dataset.active !== 'true') return;
        const key = btn.dataset.ma;
        const v = bar[key];
        if (v != null) {
          const col = (isDarkMode() ? MA_COLORS : MA_COLORS_LIGHT)[key] || '#94a3b8';
          line2 += ` <span style="color:${col};">${key.toUpperCase()}: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(v)}</span>`;
        }
      });
    } else {
      if (bar.bband_upper != null) {
        line2 += ` <span style="color:#a78bfa;">上: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.bband_upper)}</span>`;
      }
      if (bar.ma20 != null) {
        line2 += ` <span style="color:#8b5cf6;">中: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.ma20)}</span>`;
      }
      if (bar.bband_lower != null) {
        line2 += ` <span style="color:#a78bfa;">下: </span><span class="text-slate-200 dark:text-gray-800">${fmtNum(bar.bband_lower)}</span>`;
      }
    }
    el1.innerHTML = line1;
    el2.innerHTML = line2 || '&nbsp;';
  }

  function updateModeUI() {
    if (!els.btnModeMa || !els.btnModeBb) return;
    const isMA = currentMode === 'ma';
    els.btnModeMa.className = isMA ? 'px-2 py-0.5 rounded bg-slate-700 dark:bg-gray-200 text-slate-200 dark:text-gray-800' : 'px-2 py-0.5 rounded text-slate-500 dark:text-gray-400';
    els.btnModeBb.className = isMA ? 'px-2 py-0.5 rounded text-slate-500 dark:text-gray-400' : 'px-2 py-0.5 rounded bg-slate-700 dark:bg-gray-200 text-slate-200 dark:text-gray-800';
    // 隱藏/顯示 MA 膠囊按鈕容器
    if (els.maCheckboxes) {
      els.maCheckboxes.style.display = isMA ? '' : 'none';
    }
    // BB lines
    if (lwcBBUpper) lwcBBUpper.applyOptions({ visible: !isMA });
    if (lwcBBLower) lwcBBLower.applyOptions({ visible: !isMA });
    // MA lines: in BB mode hide all except ma20 (as bband center line); in MA mode restore capsule active state
    for (const w of MA_WINDOWS) {
      const key = 'ma' + w;
      const s = lwcMASeries[key];
      if (!s) continue;
      if (isMA) {
        // restore capsule active state
        let visible = false;
        els.maToggles.forEach(cb => { if (cb.dataset.ma === key && cb.dataset.active === 'true') visible = true; });
        s.applyOptions({ visible });
      } else {
        // BB mode: only ma20 visible as center line
        s.applyOptions({ visible: w === 20 });
      }
    }
    // 重新繪製 hover legend（依據切換後模式及最後一筆或當前 crosshair 位置）
    if (lwcChart && els.hoverLegend) {
      updateHoverLegend(null, currentMode); // trigger fallback to last bar — see renderCandlestick crosshair handler
    }
  }

  function bindEvents() {
    els.closeBtn.addEventListener('click', closeModal);
    els.overlay.addEventListener('click', e => { if (e.target === els.overlay) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    if (els.btnModeMa) els.btnModeMa.addEventListener('click', () => { currentMode = 'ma'; updateModeUI(); });
    if (els.btnModeBb) els.btnModeBb.addEventListener('click', () => { currentMode = 'bb'; updateModeUI(); });
    els.maToggles.forEach(btn => {
      btn.addEventListener('click', e => {
        const b = e.currentTarget;
        const key = b.dataset.ma;
        const isActive = b.dataset.active === 'true';
        const newActive = isActive ? 'false' : 'true';
        b.dataset.active = newActive;
        // update capsule style (theme-aware)
        const dark = isDarkMode();
        const palette = dark ? MA_COLORS : MA_COLORS_LIGHT;
        const color = palette[key] || '#64748b';
        const textCol = dark ? '#000' : '#fff';
        const activeBg = `background:${color};color:${textCol};border-color:${color}`;
        const base = 'padding:2px 7px;font-size:10px;border-radius:9999px;border-width:1px;border-style:solid;cursor:pointer;transition:all 150ms ease;font-family:monospace;line-height:1.4;user-select:none;';
        if (newActive === 'true') {
          b.style.cssText = base + activeBg;
          b.className = 'ma-capsule';
        } else {
          b.style.cssText = base;
          b.className = 'ma-capsule bg-transparent text-slate-500 border-slate-700 dark:text-slate-400 dark:border-slate-300';
        }
        // toggle line visibility (only effective in MA mode)
        const s = lwcMASeries[key];
        if (s) {
          s.applyOptions({ visible: currentMode === 'ma' ? (newActive === 'true') : (key === 'ma20') });
        }
        // refresh hover legend
        if (lwcChart && els.hoverLegend) {
          updateHoverLegend(null, currentMode);
        }
      });
    });
    els.subTabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        els.subTabBtns.forEach(b => { b.classList.remove('border-emerald-500', 'text-emerald-500', 'dark:text-emerald-600'); b.classList.add('border-transparent', 'text-slate-500', 'dark:text-gray-400'); });
        btn.classList.remove('border-transparent', 'text-slate-500', 'dark:text-gray-400');
        btn.classList.add('border-emerald-500', 'text-emerald-500', 'dark:text-emerald-600');
        renderSubTab(btn.dataset.subtab);
      });
    });
    els.btnCmoney.addEventListener('click', () => { if (currentStockId) window.open(`https://www.cmoney.tw/forum/stock/${currentStockId}`, '_blank'); });
    els.btnGoogle.addEventListener('click', () => { if (currentStockId) window.open(`https://www.google.com/search?q=${currentStockId}+%E5%81%9A%E4%BB%80%E9%BA%BC`, '_blank'); });

    // ── Theme change listener ──
    window.addEventListener('themechange', () => {
      applyLwcTheme();       // 更新圖表背景、網格、文字顏色 + MA 色彩
      updateModeUI();         // 重新套用 MA/BB 模式的可見性狀態
      applyChartJsTheme();   // 更新 Chart.js 顏色（若有 Chart.js）
    });
  }

  /** Apply current theme to Lightweight Charts */
  function applyLwcTheme() {
    if (!lwcChart) return;
    const t = isDarkMode() ? LWC_THEME.dark : LWC_THEME.light;
    lwcChart.applyOptions({
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: {
        vertLine: { color: t.crosshairLine, labelBackgroundColor: t.crosshairLabelBg },
        horzLine: { color: t.crosshairLine, labelBackgroundColor: t.crosshairLabelBg },
      },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    applyMAColors();
  }

  /** Update MA capsule colors and LWC series line colors on theme change */
  function applyMAColors() {
    const isDark = isDarkMode();
    const palette = isDark ? MA_COLORS : MA_COLORS_LIGHT;
    // update active capsule styles
    els.maToggles.forEach(btn => {
      if (btn.dataset.active === 'true') {
        const key = btn.dataset.ma;
        const col = palette[key] || '#64748b';
        const textCol = isDark ? '#000' : '#fff';
        const base = 'padding:2px 7px;font-size:10px;border-radius:9999px;border-width:1px;border-style:solid;cursor:pointer;transition:all 150ms ease;font-family:monospace;line-height:1.4;user-select:none;';
        btn.style.cssText = base + `background:${col};color:${textCol};border-color:${col}`;
        btn.className = 'ma-capsule';
      }
    });
    // update LWC MA line series colors
    Object.keys(lwcMASeries).forEach(key => {
      const s = lwcMASeries[key];
      if (s) {
        s.applyOptions({ color: palette[key] });
      }
    });
  }

  /** Apply current theme to Chart.js (via update('none'), no destroy needed) */
  function applyChartJsTheme() {
    if (!chartJsInstance || !chartJsType) return;
    const t = isDarkMode() ? CHARTJS_THEME.dark : CHARTJS_THEME.light;
    const opts = chartJsInstance.options;
    opts.plugins.legend.labels.color = t.legendColor;
    opts.plugins.tooltip.backgroundColor = t.tooltipBg;
    opts.plugins.tooltip.titleColor = t.tooltipTitle;
    opts.plugins.tooltip.bodyColor = t.tooltipBody;
    opts.plugins.tooltip.borderColor = t.tooltipBorder;
    opts.scales.x.grid.color = t.gridColor;
    opts.scales.x.ticks.color = t.tickColor;
    if (opts.scales.y) {
      opts.scales.y.grid.color = t.yGridColor;
      opts.scales.y.ticks.color = t.yTickColor;
      if (opts.scales.y.title) opts.scales.y.title.color = t.yTickColor;
    }
    if (chartJsType === 'margin' && opts.scales.y1) {
      opts.scales.y1.ticks.color = '#3b82f6';
      if (opts.scales.y1.title) opts.scales.y1.title.color = '#3b82f6';
    }
    chartJsInstance.update('none');
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
    els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100 dark:text-gray-900">${stockId}</span><span class="text-slate-600 dark:text-gray-400 text-xs ml-2">載入中...</span>`;
    els.btnCmoney.classList.add('hidden');
    els.btnGoogle.classList.add('hidden');
    cleanupCharts();
    els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">載入中...</div>';
    try {
      const r = await fetch(`./api/stock/${stockId}.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderHeader(data);
      renderCandlestick(data.price || []);
      updateModeUI();  // 同步按鈕與圖表狀態（保留上次關閉時的模式選擇）
      els.subTabBtns.forEach(b => { b.classList.remove('border-emerald-500', 'text-emerald-500', 'dark:text-emerald-600'); b.classList.add('border-transparent', 'text-slate-500', 'dark:text-gray-400'); });
      const ft = els.subTabBtns[0];
      if (ft) { ft.classList.remove('border-transparent', 'text-slate-500', 'dark:text-gray-400'); ft.classList.add('border-emerald-500', 'text-emerald-500', 'dark:text-emerald-600'); }
      renderSubTab('institutional');
    } catch (e) {
      console.error('[StockModal]', e);
      els.headerInfo.innerHTML = `<span class="text-lg font-bold text-rose-500 dark:text-rose-600">${stockId}</span><span class="text-rose-700 dark:text-rose-500 text-xs ml-2">載入失敗</span>`;
      els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-rose-800 dark:text-rose-500 text-xs">無法載入資料</div>';
    }
  }

  function closeModal() { els.overlay.classList.add('hidden'); cleanupCharts(); currentStockId = null; }

  function cleanupCharts() {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (lwcChart) { lwcChart.remove(); lwcChart = null; lwcCandleSeries = null; lwcVolumeSeries = null; lwcMASeries = {}; lwcBBUpper = null; lwcBBLower = null; }
    if (chartJsInstance) { chartJsInstance.destroy(); chartJsInstance = null; chartJsType = null; }
    // 保留 currentMode（不重置為 'ma'），讓重新開啟 modal 時圖表與按鈕保持同步
  }

  function renderHeader(data) {
    const arr = data.price || [];
    const name = data.stock_name || '';
    const industry = data.industry || '';
    const industryBadge = industry ? `<span class="text-2xs text-slate-200 dark:text-gray-700 ml-2">${industry}</span>` : '';
    if (!arr.length) { els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100 dark:text-gray-900">${currentStockId}</span><span class="text-sm text-slate-400 dark:text-gray-500 ml-2">${name}${industryBadge}</span><span class="text-slate-600 dark:text-gray-400 text-xs ml-4">暫無價量資料</span>`; return; }
    const last = arr[arr.length - 1], prev = arr.length >= 2 ? arr[arr.length - 2] : null;
    const close = last.close;
    let ch = null, chPct = null;
    if (prev && prev.close != null) { ch = close - prev.close; chPct = (ch / prev.close) * 100; }
    const cc = ch > 0 ? 'text-rose-500 dark:text-rose-600' : ch < 0 ? 'text-emerald-500 dark:text-emerald-600' : 'text-slate-400 dark:text-gray-500';
    const ar = ch > 0 ? '▲' : ch < 0 ? '▼' : '—';
    const disp = close != null ? close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
    els.headerInfo.innerHTML = `<span class="text-lg font-bold text-slate-100 dark:text-gray-900">${currentStockId}</span><span class="text-sm text-slate-400 dark:text-gray-500 ml-2">${name}${industryBadge}</span><span class="text-lg font-mono font-bold text-slate-100 dark:text-gray-900 ml-4">${disp}</span>${ch != null ? `<span class="text-sm font-mono font-semibold ${cc} ml-2">${ar} ${ch >= 0 ? '+' : ''}${ch.toFixed(2)} (${chPct >= 0 ? '+' : ''}${chPct.toFixed(2)}%)</span>` : ''}`;
    els.btnCmoney.classList.remove('hidden');
    els.btnGoogle.classList.remove('hidden');
  }

  function renderCandlestick(priceArr) {
    if (!priceArr || !priceArr.length) { els.klineContainer.innerHTML = '<div class="w-full h-full flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">無價量資料</div>'; return; }
    const validPrice = priceArr.filter(p => p.open != null && p.high != null && p.low != null && p.close != null);
    if (!validPrice.length) { els.klineContainer.innerHTML = '<div class="w-full h-full flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">無有效價量資料</div>'; return; }
    els.klineContainer.innerHTML = '';
    const t = isDarkMode() ? LWC_THEME.dark : LWC_THEME.light;
    lwcChart = LightweightCharts.createChart(els.klineContainer, {
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, fontSize: 10 },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: t.crosshairLine, width: 1, labelBackgroundColor: t.crosshairLabelBg }, horzLine: { color: t.crosshairLine, width: 1, labelBackgroundColor: t.crosshairLabelBg } },
      rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
      localization: {
        locale: 'zh-TW',
        timeFormatter: function(ts) {
          if (ts.year !== undefined) {
            return `${ts.year}-${String(ts.month).padStart(2,'0')}-${String(ts.day).padStart(2,'0')}`;
          }
          if (ts instanceof Date) {
            return ts.getFullYear() + '-' + String(ts.getMonth()+1).padStart(2,'0') + '-' + String(ts.getDate()).padStart(2,'0');
          }
          return String(ts);
        },
      },
      timeScale: {
        borderColor: t.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: function(ts, tickMarkType, locale) {
          if (ts.year !== undefined) {
            switch (tickMarkType) {
              case 0 /* Year */:       return ts.year + '年';
              case 1 /* Month */:      return String(ts.month).padStart(2,'0') + '月';
              case 2 /* DayOfMonth */:
              default:                 return String(ts.month).padStart(2,'0') + '/' + String(ts.day).padStart(2,'0');
            }
          }
          return String(ts);
        },
      },
      handleScroll: { vertTouchDrag: false },
    });
    resizeObserver = new ResizeObserver(entries => { for (const e of entries) { const { width, height } = e.contentRect; if (lwcChart && width > 0 && height > 0) lwcChart.applyOptions({ width, height }); } });
    resizeObserver.observe(els.klineContainer);
    lwcCandleSeries = lwcChart.addCandlestickSeries({ upColor: C.upBorder, downColor: C.downBorder, borderUpColor: C.upBorder, borderDownColor: C.downBorder, wickUpColor: C.upBorder, wickDownColor: C.downBorder });
    lwcCandleSeries.setData(validPrice.map(p => ({ time: p.date, open: p.open, high: p.high, low: p.low, close: p.close })));
    lwcVolumeSeries = lwcChart.addHistogramSeries({ priceScaleId: 'volume' });
    lwcChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0.02 } });
    lwcVolumeSeries.setData(validPrice.map(p => ({ time: p.date, value: p.volume != null ? p.volume / 1000 : 0, color: p.close >= p.open ? C.up : C.down })));
    MA_WINDOWS.forEach(w => {
      const key = 'ma' + w;
      // 初始可見性直接根據 currentMode 決定，避免 LWC 內部重新渲染時重置為錯誤狀態
      let visible;
      if (currentMode === 'ma') {
        // MA 模式下，只有膠囊 active (w<=20) 的才顯示
        visible = w <= 20;
      } else {
        // BB 模式下，只有 ma20 作為布林中線顯示
        visible = w === 20;
      }
      const s = lwcChart.addLineSeries({ color: (isDarkMode() ? MA_COLORS : MA_COLORS_LIGHT)[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible });
      const d = []; validPrice.forEach(p => { if (p[key] != null) d.push({ time: p.date, value: p[key] }); });
      s.setData(d);
      lwcMASeries[key] = s;
    });
    const len = validPrice.length;
    if (len > 0) {
      const from = validPrice[Math.max(0, len - 60)].date;
      const to = validPrice[len - 1].date;
      lwcChart.timeScale().setVisibleRange({ from, to });
    }
    // BBands lines
    lwcBBUpper = lwcChart.addLineSeries({
    color: BB_COLOR, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.LargeDashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    visible: currentMode === 'bb',
    });
    const bbUpperData = []; validPrice.forEach(p => { if (p.bband_upper != null) bbUpperData.push({ time: p.date, value: p.bband_upper }); });
    lwcBBUpper.setData(bbUpperData);
    lwcBBLower = lwcChart.addLineSeries({
    color: BB_COLOR, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.LargeDashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    visible: currentMode === 'bb',
    });
    const bbLowerData = []; validPrice.forEach(p => { if (p.bband_lower != null) bbLowerData.push({ time: p.date, value: p.bband_lower }); });
    lwcBBLower.setData(bbLowerData);
    // Hover legend: subscribe crosshair move
    lastPriceBar = validPrice[validPrice.length - 1];
    if (els.hoverLegend && lastPriceBar) {
      updateHoverLegend(lastPriceBar, currentMode);
    }
    lwcChart.subscribeCrosshairMove(param => {
      if (!param || !param.time || !validPrice.length) {
        updateHoverLegend(lastPriceBar, currentMode);
        return;
      }
      const idx = validPrice.findIndex(p => p.date === param.time);
      if (idx >= 0) {
        updateHoverLegend(validPrice[idx], currentMode);
      } else {
        updateHoverLegend(lastPriceBar, currentMode);
      }
    });
  }

  function renderSubTab(tab) {
    if (!currentStockId) return;
    fetch(`./api/stock/${currentStockId}.json`).then(r => r.json()).then(data => {
      if (chartJsInstance) { chartJsInstance.destroy(); chartJsInstance = null; chartJsType = null; }
      if (tab === 'institutional') renderInstitutional(data.institutional || []);
      else if (tab === 'margin') renderMargin(data.margin || []);
      else if (tab === 'tdcc') { chartJsType = null; renderTdccPyramid(data.tdcc || []); }
    }).catch(() => { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-rose-800 dark:text-rose-500 text-xs">載入失敗</div>'; });
  }

  function renderInstitutional(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">無法人買賣超資料</div>'; return; }
    const canvas = document.createElement('canvas');
    els.subchartContainer.innerHTML = '';
    els.subchartContainer.appendChild(canvas);
    const t = isDarkMode() ? CHARTJS_THEME.dark : CHARTJS_THEME.light;
    chartJsInstance = new Chart(canvas, {
      type: 'bar',
      data: { labels: data.map(d => d.date.slice(5)), datasets: [
        { label: '外資', data: data.map(d => (d.foreign_buy_sell || 0) / 1000), backgroundColor: C.foreign, borderRadius: 1 },
        { label: '投信', data: data.map(d => (d.trust_buy_sell || 0) / 1000), backgroundColor: C.trust, borderRadius: 1 },
        { label: '自營商', data: data.map(d => (d.prop_buy_sell || 0) / 1000), backgroundColor: C.prop, borderRadius: 1 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { color: t.legendColor, font: { size: 10 }, boxWidth: 12, padding: 8 } }, tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipTitle, bodyColor: t.tooltipBody, borderColor: t.tooltipBorder, borderWidth: 1, callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(0)} 張` } } },
        scales: { x: { ticks: { color: t.tickColor, font: { size: 9 }, maxRotation: 45 }, grid: { color: t.gridColor } }, y: { ticks: { color: t.yTickColor, font: { size: 9 } }, grid: { color: t.yGridColor }, title: { display: true, text: '千張', color: t.yTickColor, font: { size: 9 } } } },
      },
    });
    chartJsType = 'institutional';
  }

  function renderMargin(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">無融資券資料</div>'; return; }
    const canvas = document.createElement('canvas');
    els.subchartContainer.innerHTML = '';
    els.subchartContainer.appendChild(canvas);
    const t = isDarkMode() ? CHARTJS_THEME.dark : CHARTJS_THEME.light;
    chartJsInstance = new Chart(canvas, {
      type: 'line',
      data: { labels: data.map(d => d.date.slice(5)), datasets: [
        { label: '融資餘額', data: data.map(d => (d.fin_balance || 0)), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHitRadius: 8 },
        { label: '融券餘額', data: data.map(d => (d.mar_balance || 0)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 2, pointHitRadius: 8, yAxisID: 'y1' },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { color: t.legendColor, font: { size: 10 }, boxWidth: 12, padding: 8 } }, tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipTitle, bodyColor: t.tooltipBody, borderColor: t.tooltipBorder, borderWidth: 1, callbacks: { label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y / 10000).toFixed(1)} 萬` } } },
        scales: {
          x: { ticks: { color: t.tickColor, font: { size: 9 }, maxRotation: 45 }, grid: { color: t.gridColor } },
          y: { position: 'left', ticks: { color: '#f59e0b', font: { size: 9 }, callback: v => (v / 10000).toFixed(1) + '萬' }, grid: { color: t.yGridColor }, title: { display: true, text: '融資', color: '#f59e0b', font: { size: 9 } } },
          y1: { position: 'right', ticks: { color: '#3b82f6', font: { size: 9 }, callback: v => v.toFixed(0) }, grid: { display: false }, title: { display: true, text: '融券', color: '#3b82f6', font: { size: 9 } } },
        },
      },
    });
    chartJsType = 'margin';
  }

  function renderTdccPyramid(data) {
    if (!data || !data.length) { els.subchartContainer.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-700 dark:text-gray-400 text-xs">無集保資料</div>'; return; }

    let selectedIndex = data.length - 1;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

    const nav = document.createElement('div');
    nav.className = 'flex items-center justify-center gap-3 py-1 flex-shrink-0';
    nav.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:2px 0;flex-shrink:0;';
    const btnPrev = document.createElement('button');
    btnPrev.textContent = '◀';
    btnPrev.className = 'border border-slate-700 dark:border-slate-300 text-slate-400 dark:text-slate-500 rounded';
    btnPrev.style.cssText = 'background:none;border-radius:4px;width:28px;height:24px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;';
    const spanDate = document.createElement('span');
    spanDate.className = 'text-slate-300 dark:text-slate-700 font-semibold';
    spanDate.style.cssText = 'font-size:12px;font-weight:600;min-width:80px;text-align:center;';
    const btnNext = document.createElement('button');
    btnNext.textContent = '▶';
    btnNext.className = 'border border-slate-700 dark:border-slate-300 text-slate-400 dark:text-slate-500 rounded';
    btnNext.style.cssText = 'background:none;border-radius:4px;width:28px;height:24px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;';
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
      if (!levels.length) { chartDiv.innerHTML = '<div class="text-slate-700 dark:text-gray-400 text-xs text-center py-4">無持股分級資料</div>'; return; }
      levels = levels.reverse();

      const maxCount = Math.max(...levels.map(l => l.count || 0), 1);
      const maxRatio = Math.max(...levels.map(l => l.ratio || 0), 1);
      const prevMap = {};
      if (prev && prev.levels) { for (const pl of prev.levels) { prevMap[pl.code] = pl; } }
      const MAX_PCT = 94;

      // 垂直漂浮標籤 — 使用 Tailwind class
      const leftLabel = document.createElement('div');
      leftLabel.style.cssText = 'position:absolute;left:6px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
      leftLabel.innerHTML = '<span class="text-slate-500 dark:text-slate-400 opacity-50" style="writing-mode:vertical-rl;text-orientation:mixed;font-size:16px;white-space:nowrap;letter-spacing:3px;">持股人數</span>';
      const rightLabel = document.createElement('div');
      rightLabel.style.cssText = 'position:absolute;right:6px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;';
      rightLabel.innerHTML = '<span class="text-slate-500 dark:text-slate-400 opacity-50" style="writing-mode:vertical-rl;text-orientation:mixed;font-size:16px;white-space:nowrap;letter-spacing:3px;">持股比例</span>';
      chartDiv.appendChild(leftLabel);
      chartDiv.appendChild(rightLabel);

      // 差值顯示 — 語意色保持 hardcoded
      function diffSpan(diff, isRatio) {
        const suffix = isRatio ? '%' : '人';
        if (diff > 0) return `<span style="color:#ef4444;font-size:11px;">▲ +${diff.toLocaleString(undefined, {minimumFractionDigits: isRatio ? 2 : 0, maximumFractionDigits: isRatio ? 2 : 0})}${suffix}</span>`;
        if (diff < 0) return `<span style="color:#10b981;font-size:11px;">▼ -${Math.abs(diff).toLocaleString(undefined, {minimumFractionDigits: isRatio ? 2 : 0, maximumFractionDigits: isRatio ? 2 : 0})}${suffix}</span>`;
        if (isRatio) return `<span class="text-slate-500 dark:text-slate-400" style="font-size:11px;">— +0.00%</span>`;
        return `<span class="text-slate-500 dark:text-slate-400" style="font-size:10px;">— +0人</span>`;
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

        // 整列 hover — 使用 event listener (dark: 用 dark hover)
        const row = document.createElement('div');
        row.className = 'flex items-center cursor-default';
        row.style.cssText = 'min-height:18px;margin:0 0;';
        row.addEventListener('mouseenter', () => { row.style.backgroundColor = isDarkMode() ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)'; });
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
        leftBar.innerHTML = `<span class="text-slate-200 dark:text-gray-800" style="font-size:10px;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7);">${countFmt}</span>`;
        leftBarWrap.appendChild(leftBar);
        row.appendChild(leftBarWrap);

        // 中：級距
        const midCol = document.createElement('div');
        midCol.className = 'text-slate-300 dark:text-slate-700';
        midCol.style.cssText =
          'flex:0 0 auto;width:90px;text-align:center;font-size:11px;' +
          'padding:0 3px;white-space:nowrap;';
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
        rightBar.innerHTML = `<span class="text-slate-200 dark:text-gray-800" style="font-size:10px;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7);">${ratioFmt}</span>`;
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