/**
 * watchlist-manager.js — 自選股管理彈窗 (Modal)
 *
 * 依賴：
 *   - window.WatchlistStore（由 watchlist-store.js 注入）
 *
 * 採用單一 IIFE 模組化，與 stock-modal.js 相同的色彩語意
 * 支援拖曳即時重排 (Live Layout Shift)，不依賴原生 HTML5 DnD 的 ghost 行為
 */

window.WatchlistManagerModal = (() => {
  'use strict';

  // ─── SVG Icon 模板 ───
  const ICON_GRIP = `<svg class="w-3.5 h-3.5 text-slate-500 shrink-0 mr-1.5 cursor-grab" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
  const ICON_PLUS = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const ICON_TRASH = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
  const ICON_X = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  let _currentListName = null;       // 當前在 Modal 中聚焦的清單
  let _stockIndexMap = null;         // { '2330': '台積電', '台積電': '2330', ... }
  let _stockIndexPromise = null;

  // ──────────────────────────────────────────────
  // DOM element cache
  // ──────────────────────────────────────────────
  let els = {};

  // ──────────────────────────────────────────────
  // Helper: 取得 WatchlistStore 參考
  // ──────────────────────────────────────────────
  function _store() {
    return window.WatchlistStore || null;
  }

  // ──────────────────────────────────────────────
  // Helper: 顯示短暫 error 提示
  // ──────────────────────────────────────────────
  function _showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ──────────────────────────────────────────────
  // 載入股票 index (id ↔ name)
  // ──────────────────────────────────────────────
  function _loadStockIndex() {
    if (_stockIndexPromise) return _stockIndexPromise;
    _stockIndexPromise = fetch('./api/stock/index.json')
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        _stockIndexMap = {};
        data.forEach(item => {
          _stockIndexMap[item.stock_id] = item.stock_name;
          _stockIndexMap[item.stock_name] = item.stock_id;
        });
      })
      .catch(() => { _stockIndexMap = {}; });
    return _stockIndexPromise;
  }

  // ──────────────────────────────────────────────
  // 初始化：建立 DOM 並注入 <body> 末尾
  // ──────────────────────────────────────────────
  function init() {
    _loadStockIndex(); // 觸發預載，不必 await
    buildModalDOM();
    cacheElements();
    bindEvents();
  }

  // ──────────────────────────────────────────────
  // 建立 Modal HTML 結構
  // ──────────────────────────────────────────────
  function buildModalDOM() {
    // 避免重複插入
    if (document.getElementById('wm-overlay')) return;

    const html = `
      <div id="wm-overlay" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 dark:bg-black/70 hidden" style="backdrop-filter:blur(2px);">
        <!-- 主 Modal 容器 -->
        <div class="relative w-[900px] h-[620px] max-w-[95vw] max-h-[90vh] bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">

          <!-- 頂部標題列 -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
            <h2 class="text-base font-bold text-slate-800 dark:text-slate-200">管理自選清單</h2>
            <button id="wm-close-btn" class="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="關閉">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <!-- 雙欄分頁區塊 -->
          <div class="flex-1 grid grid-cols-[280px_1fr] gap-6 p-6 overflow-hidden">

            <!-- ═══ 左欄：清單管理 ═══ -->
            <div class="flex flex-col overflow-hidden">
              <h3 class="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-3 shrink-0">清單列表</h3>

              <!-- 清單列表 Scroll -->
              <div id="wm-left-list" class="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0"></div>

              <!-- 新增清單輸入 -->
              <div class="shrink-0 mt-3">
                <div class="flex items-stretch gap-2">
                  <input id="wm-new-list-input" type="text" maxlength="20" placeholder="輸入清單名稱..."
                    class="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-500">
                  <button id="wm-new-list-btn"
                    class="shrink-0 bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 px-3 py-1.5 rounded flex items-center justify-center transition-colors">
                    ${ICON_PLUS}
                  </button>
                </div>
                <div class="relative h-4 mt-1">
                  <div id="wm-left-error" class="absolute top-0 left-0 text-[11px] text-rose-500 dark:text-rose-400 hidden"></div>
                </div>
              </div>
            </div>

            <!-- ═══ 右欄：個股管理 ═══ -->
            <div class="flex flex-col overflow-hidden pr-2">
              <!-- 右欄標題 + 刪除鈕 -->
              <div id="wm-right-header" class="flex items-center justify-between mb-3 shrink-0">
                <h3 id="wm-right-title" class="text-base font-bold text-slate-800 dark:text-slate-200"></h3>
                <button id="wm-delete-list-btn"
                  class="shrink-0 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 rounded px-2.5 py-1 text-xs flex items-center gap-1 transition-colors">
                  ${ICON_TRASH}<span>刪除</span>
                </button>
              </div>

              <!-- 個股列表 Scroll -->
              <div id="wm-right-stocks" class="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0"></div>

              <!-- 新增個股輸入 -->
              <div class="shrink-0 mt-3">
                <div class="flex items-stretch gap-2">
                  <input id="wm-new-stock-input" type="text" placeholder="輸入股票代號或名稱（逗號分隔）..."
                    class="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-400">
                  <button id="wm-new-stock-btn"
                    class="shrink-0 bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 px-3 py-1.5 rounded flex items-center justify-center transition-colors">
                    ${ICON_PLUS}
                  </button>
                </div>
                <div class="relative h-4 mt-1">
                  <div id="wm-right-error" class="absolute top-0 left-0 text-[11px] text-rose-500 dark:text-rose-400 hidden"></div>
                </div>
              </div>
            </div>

          </div><!-- /grid -->
        </div><!-- /modal container -->
      </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
  }

  // ──────────────────────────────────────────────
  // 快取 DOM 元素參照
  // ──────────────────────────────────────────────
  function cacheElements() {
    els.overlay = document.getElementById('wm-overlay');
    els.closeBtn = document.getElementById('wm-close-btn');
    els.leftList = document.getElementById('wm-left-list');
    els.newListInput = document.getElementById('wm-new-list-input');
    els.newListBtn = document.getElementById('wm-new-list-btn');
    els.leftError = document.getElementById('wm-left-error');
    els.rightHeader = document.getElementById('wm-right-header');
    els.rightTitle = document.getElementById('wm-right-title');
    els.deleteListBtn = document.getElementById('wm-delete-list-btn');
    els.rightError = document.getElementById('wm-right-error');
    els.rightStocks = document.getElementById('wm-right-stocks');
    els.newStockInput = document.getElementById('wm-new-stock-input');
    els.newStockBtn = document.getElementById('wm-new-stock-btn');
  }

  // ──────────────────────────────────────────────
  // 事件綁定
  // ──────────────────────────────────────────────
  function bindEvents() {
    // 關閉
    els.closeBtn.addEventListener('click', close);
    let mouseDownOnOverlay = false;
    els.overlay.addEventListener('mousedown', e => { mouseDownOnOverlay = (e.target === els.overlay); });
    els.overlay.addEventListener('mouseup', e => { if (e.target === els.overlay && mouseDownOnOverlay) close(); });
    els.overlay.addEventListener('click', e => { if (e.target === els.overlay && mouseDownOnOverlay) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.overlay.classList.contains('hidden')) close(); });

    // 監聽 Store 變更 → 自動重繪
    window.addEventListener('watchlistchange', () => {
      if (!els.overlay.classList.contains('hidden')) {
        _renderAll();
      }
    });

    // 新增清單
    els.newListBtn.addEventListener('click', _handleNewList);
    els.newListInput.addEventListener('keydown', e => { if (e.key === 'Enter') _handleNewList(); });

    // 新增個股
    els.newStockBtn.addEventListener('click', _handleNewStock);
    els.newStockInput.addEventListener('keydown', e => { if (e.key === 'Enter') _handleNewStock(); });

    // 刪除清單
    els.deleteListBtn.addEventListener('click', _handleDeleteList);
  }

  // ──────────────────────────────────────────────
  // 打開 Modal
  // ──────────────────────────────────────────────
  function open() {
    const ws = _store();
    if (!ws) return;

    // 同步 active list
    _currentListName = ws.getActiveListName();

    // 確保股票 index 已載入
    _loadStockIndex();

    els.overlay.classList.remove('hidden');
    _renderAll();
  }

  // ──────────────────────────────────────────────
  // 關閉 Modal
  // ──────────────────────────────────────────────
  function close() {
    els.overlay.classList.add('hidden');
  }

  // ──────────────────────────────────────────────
  // 全體重繪
  // ──────────────────────────────────────────────
  function _renderAll() {
    const ws = _store();
    if (!ws) return;
    _renderLeftList(ws);
    _renderRightPanel(ws);
  }

  // ──────────────────────────────────────────────
  // 左欄渲染
  // ──────────────────────────────────────────────
  function _renderLeftList(ws) {
    const container = els.leftList;
    if (!container) return;

    const allLists = ws.getAllLists();
    const activeName = ws.getActiveListName();
    const listNames = Object.keys(allLists);

    container.innerHTML = '';

    if (!listNames.length) {
      container.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 text-center py-4">尚無清單</div>';
      return;
    }

    listNames.forEach(name => {
      const ids = allLists[name] || [];
      const count = ids.length;
      const isActive = name === activeName;

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-1.5 px-2.5 rounded cursor-pointer select-none ' +
        (isActive
          ? 'bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
          : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700');
      row.style.cssText = row.style.cssText + 'transition:all 120ms ease;';
      row.draggable = true;
      row.dataset.listName = name;

      row.innerHTML = `${ICON_GRIP}<span class="text-xs font-medium truncate">${name}</span><span class="text-2xs text-slate-400 dark:text-slate-500 shrink-0 ml-2">(${count})</span>`;

      // 點擊切換 active
      row.addEventListener('click', e => {
        // 避免拖曳結束後觸發 click
        if (row.dataset.wasDragged === 'true') {
          row.dataset.wasDragged = 'false';
          return;
        }
        _currentListName = name;
        ws.setActiveList(name);
      });

      // Drag & Drop — 清單排序
      _bindListDragEvents(row, ws);

      container.appendChild(row);
    });
  }

  // ──────────────────────────────────────────────
  // 左欄清單拖曳 (獨立隔離)
  // ──────────────────────────────────────────────
  function _bindListDragEvents(row, ws) {
    const container = els.leftList;

    row.addEventListener('dragstart', e => {
      row.dataset.wasDragged = 'false';
      row.dataset.isDragging = 'true';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.listName);
      // 延遲套用視覺樣式（讓瀏覽器先擷取拖曳影像）
      requestAnimationFrame(() => {
        row.style.opacity = '0.85';
        row.style.border = '2px dashed #818cf8'; // indigo-400 (tailwind #818cf8)
      });
    });

    row.addEventListener('dragend', e => {
      // 復原樣式
      row.style.opacity = '';
      row.style.border = '';
      row.dataset.wasDragged = 'true';
      // 復原所有列樣式（防殘留）
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
        r.style.border = '';
        delete r.dataset.isDragging;
      });
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // 找出正在被拖曳的來源元素
      const sourceEl = container.querySelector('[data-is-dragging="true"]');

      // 沒有來源，或滑鼠在自己身上 → 不做事
      if (!sourceEl || sourceEl === row) return;

      // 計算滑鼠位置，決定插入在前或後
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        container.insertBefore(sourceEl, row);
      } else {
        container.insertBefore(sourceEl, row.nextSibling);
      }
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      // 根據目前 DOM 順序寫入 Store
      const rows = Array.from(container.querySelectorAll('[draggable]'));
      const draggedName = e.dataTransfer.getData('text/plain');

      // 找出目前 DOM 中 dragged 元素的位置 (fromIndex)
      const fromIdx = rows.findIndex(r => r.dataset.listName === draggedName);
      if (fromIdx === -1) return;

      const currentOrder = rows.map(r => r.dataset.listName);
      const allLists = ws.getAllLists();
      const originalOrder = Object.keys(allLists);

      const origFromIdx = originalOrder.indexOf(draggedName);
      const newToIdx = currentOrder.indexOf(draggedName);

      if (origFromIdx !== -1 && newToIdx !== -1 && origFromIdx !== newToIdx) {
        ws.moveList(origFromIdx, newToIdx);
      }
    });
  }

  // ──────────────────────────────────────────────
  // 右欄渲染
  // ──────────────────────────────────────────────
  function _renderRightPanel(ws) {
    // 決定當前清單
    let listName = _currentListName;
    const allLists = ws.getAllLists();
    const listNames = Object.keys(allLists);

    // fallback：若當前清單無效或不存在
    if (!listName || !allLists[listName]) {
      listName = ws.getActiveListName();
    }
    // 再 fallback：若 active 也不存在
    if (!allLists[listName] && listNames.length > 0) {
      listName = listNames[0];
      ws.setActiveList(listName);
    }

    _currentListName = listName;

    // 標題
    if (els.rightTitle) {
      els.rightTitle.textContent = listName || '';
    }

    // 刪除按鈕：清單數 ≤ 1 時隱藏
    if (els.deleteListBtn) {
      els.deleteListBtn.style.display = (listNames.length <= 1 || !listName) ? 'none' : '';
    }

    // 渲染個股列表
    const container = els.rightStocks;
    if (!container) return;

    const ids = listName ? (allLists[listName] || []) : [];

    container.innerHTML = '';

    if (!ids.length) {
      container.innerHTML = '<div class="text-xs text-slate-400 dark:text-slate-500 text-center py-8">此清單尚無股票</div>';
      return;
    }

    ids.forEach((stockId, idx) => {
      const stockName = _stockIndexMap ? (_stockIndexMap[stockId] || '') : '';

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-1.5 px-2.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-gray-700 dark:text-slate-300';
      row.style.cssText = 'transition:all 120ms ease;';
      row.draggable = true;
      row.dataset.stockId = stockId;

      // Drag Handle + 文字
      const leftSpan = document.createElement('span');
      leftSpan.className = 'text-xs font-medium flex items-center gap-1';
      leftSpan.innerHTML = `${ICON_GRIP}${stockName ? `${stockId} ${stockName}` : stockId}`;

      const rightBtn = document.createElement('button');
      rightBtn.className = 'text-2xs w-6 h-6 flex items-center justify-center rounded text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 border border-transparent hover:border-rose-300 dark:hover:border-rose-700 shrink-0 ml-2';
      rightBtn.innerHTML = ICON_X;
      rightBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!listName) return;
        ws.removeFromList(listName, stockId);
      });

      row.appendChild(leftSpan);
      row.appendChild(rightBtn);

      // Drag & Drop — 個股排序
      _bindStockDragEvents(row, ws, listName);

      container.appendChild(row);
    });
  }

  // ──────────────────────────────────────────────
  // 右欄個股拖曳 (獨立隔離)
  // ──────────────────────────────────────────────
  function _bindStockDragEvents(row, ws, listName) {
    const container = els.rightStocks;

    row.addEventListener('dragstart', e => {
      row.dataset.wasDragged = 'false';
      row.dataset.isDragging = 'true';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.stockId);
      requestAnimationFrame(() => {
        row.style.opacity = '0.85';
        row.style.border = '2px dashed #818cf8';
      });
    });

    row.addEventListener('dragend', e => {
      row.style.opacity = '';
      row.style.border = '';
      row.dataset.wasDragged = 'true';
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
        r.style.border = '';
        delete r.dataset.isDragging;
      });
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const sourceEl = container.querySelector('[data-is-dragging="true"]');

      if (!sourceEl || sourceEl === row) return;

      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        container.insertBefore(sourceEl, row);
      } else {
        container.insertBefore(sourceEl, row.nextSibling);
      }
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      const rows = Array.from(container.querySelectorAll('[draggable]'));
      const draggedId = e.dataTransfer.getData('text/plain');

      const fromIdx = rows.findIndex(r => r.dataset.stockId === draggedId);
      if (fromIdx === -1) return;

      const allLists = ws.getAllLists();
      const originalIds = [...(allLists[listName] || [])];
      const currentIds = rows.map(r => r.dataset.stockId);

      const origFromIdx = originalIds.indexOf(draggedId);
      const newToIdx = currentIds.indexOf(draggedId);

      if (origFromIdx !== -1 && newToIdx !== -1 && origFromIdx !== newToIdx) {
        ws.moveInList(listName, origFromIdx, newToIdx);
      }
    });
  }

  // ──────────────────────────────────────────────
  // 新增清單 handler
  // ──────────────────────────────────────────────
  function _handleNewList() {
    const input = els.newListInput;
    const ws = _store();
    if (!input || !ws) return;

    const name = input.value.trim();
    if (!name) return;

    const ok = ws.createList(name);
    if (ok) {
      input.value = '';
      // 清除 error
      if (els.leftError) els.leftError.classList.add('hidden');
    } else {
      _showError(els.leftError, '清單名稱重複或格式無效');
    }
  }

  // ──────────────────────────────────────────────
  // 新增個股 handler（支援空白/逗號分隔，支援名稱查詢，部分成功）
  // ──────────────────────────────────────────────
  function _handleNewStock() {
    const input = els.newStockInput;
    const ws = _store();
    if (!input || !ws) return;

    const raw = input.value.trim();
    if (!raw) return;

    const listName = _currentListName;
    if (!listName) return;

    // 分割：逗號或空白
    const tokens = raw.split(/[,，\s]+/).filter(Boolean);
    const notFound = [];
    let addedCount = 0;

    tokens.forEach(token => {
      const trimmed = token.trim();
      if (!trimmed) return;

      let stockId = null;

      // 優先：純數字+可選字母 = 直接當股票代號
      if (/^\d+[A-Za-z]?$/.test(trimmed)) {
        // 檢查是否存在於 index map
        if (_stockIndexMap && _stockIndexMap[trimmed] !== undefined && typeof _stockIndexMap[trimmed] === 'string') {
          stockId = trimmed;
        } else {
          // 不在 index map 中，但格式合法 → 仍可加入（可能是新上市）
          stockId = trimmed;
        }
      } else if (_stockIndexMap) {
        // 可能是股票名稱 → 反向查 id
        const resolvedId = _stockIndexMap[trimmed];
        if (resolvedId && typeof resolvedId === 'string') {
          stockId = resolvedId;
        }
      }

      if (stockId) {
        ws.addToList(listName, stockId);
        addedCount++;
      } else {
        notFound.push(trimmed);
      }
    });

    // 處理 input 值與 error
    if (notFound.length > 0) {
      input.value = notFound.join(' ');
      _showError(els.rightError, `找不到股票：${notFound.join(' ')}`);
    } else if (addedCount > 0) {
      input.value = '';
      if (els.rightError) els.rightError.classList.add('hidden');
    }
  }

  // ──────────────────────────────────────────────
  // 刪除清單 handler
  // ──────────────────────────────────────────────
  function _handleDeleteList() {
    const ws = _store();
    if (!ws) return;

    const allLists = ws.getAllLists();
    const listNames = Object.keys(allLists);
    if (listNames.length <= 1) return;

    const name = _currentListName;
    if (!name || !allLists[name]) return;

    if (!confirm(`確定要刪除清單「${name}」嗎？此操作無法復原。`)) return;

    ws.deleteList(name);
    _currentListName = null;
  }

  // ──────────────────────────────────────────────
  // Public interface
  // ──────────────────────────────────────────────
  return { init, open, close };
})();