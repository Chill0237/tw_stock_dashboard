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
  const ICON_GRIP = `<svg class="w-3.5 h-3.5 text-slate-700 dark:text-slate-400 shrink-0 mr-1.5 cursor-grab" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
  const ICON_PLUS = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const ICON_TRASH = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
  const ICON_EDIT = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const ICON_X = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  let _currentListName = null;       // 當前在 Modal 中聚焦的清單
  let _stockIndexMap = null;         // { '2330': '台積電', '台積電': '2330', ... }
  let _stockIndexPromise = null;

  // 1x1 透明像素，用於消除原生 drag ghost
  const _transparentImg = new Image();
  _transparentImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // 自訂 floating drag preview 參照
  let _dragPreview = null;

  // rAF 節流標記 (dragover 高頻事件)
  let _rafPending = false;

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
            <button id="wm-close-btn" class="w-8 h-8 flex items-center justify-center rounded-full text-slate-700 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="關閉">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <!-- 雙欄分頁區塊 -->
          <div class="flex-1 grid grid-cols-[280px_1fr] gap-6 p-6 overflow-hidden">

            <!-- ═══ 左欄：清單管理 ═══ -->
            <div class="flex flex-col overflow-hidden">
              <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-400 mb-3 shrink-0">清單列表</h3>

              <!-- 清單列表 Scroll -->
              <div id="wm-left-list" class="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0"></div>

              <!-- 新增清單輸入 -->
              <div class="shrink-0 mt-3">
                <div class="flex items-stretch gap-2">
                  <input id="wm-new-list-input" type="text" maxlength="20" placeholder="輸入清單名稱..."
                    class="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-300 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 dark:focus:border-indigo-500">
                  <button id="wm-new-list-btn"
                    class="shrink-0 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 border border-slate-300 dark:border-slate-600 px-3 py-1.5 rounded flex items-center justify-center transition-colors">
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
                <div class="flex items-center gap-1">
                  <button id="wm-edit-list-btn"
                    class="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 border border-slate-300 dark:border-slate-600 p-1.5 rounded flex items-center justify-center transition-colors"
                    title="編輯名稱">
                    ${ICON_EDIT}
                  </button>
                  <button id="wm-delete-list-btn"
                    class="shrink-0 bg-rose-50 dark:bg-rose-900 text-rose-500 dark:text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-800 border border-rose-200 dark:border-rose-700 rounded px-2.5 py-1 text-xs flex items-center gap-1 transition-colors">
                    ${ICON_TRASH}<span>刪除</span>
                  </button>
                </div>
              </div>

              <!-- 個股列表 Scroll -->
              <div id="wm-right-stocks" class="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0"></div>

              <!-- 新增個股輸入 -->
              <div class="shrink-0 mt-3">
                <div class="flex items-stretch gap-2">
                  <input id="wm-new-stock-input" type="text" placeholder="輸入股票代號或名稱（逗號分隔）..."
                    class="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-300 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-400">
                  <button id="wm-new-stock-btn"
                    class="shrink-0 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 border border-slate-300 dark:border-slate-600 px-3 py-1.5 rounded flex items-center justify-center transition-colors">
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
    els.editListBtn = document.getElementById('wm-edit-list-btn');
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
    window.addEventListener('watchlistchange', async () => {
      if (!els.overlay.classList.contains('hidden')) {
        await _renderAll();
      }
    });

    // 新增清單
    els.newListBtn.addEventListener('click', async () => { await _handleNewList(); });
    els.newListInput.addEventListener('keydown', async e => { if (e.key === 'Enter') await _handleNewList(); });

    // 新增個股
    els.newStockBtn.addEventListener('click', async () => { await _handleNewStock(); });
    els.newStockInput.addEventListener('keydown', async e => { if (e.key === 'Enter') await _handleNewStock(); });

    // 編輯清單名稱（右側標題）
    els.editListBtn.addEventListener('click', _handleEditListTitle);

    // 刪除清單
    els.deleteListBtn.addEventListener('click', async () => { await _handleDeleteList(); });

    // 最高優先級全螢幕 document dragover：無條件設為合法 DropZone + preview 座標追蹤
    document.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      if (!_dragPreview) return;

      // (0,0) 防護：瀏覽器偶發座標歸零
      if (e.clientX === 0 && e.clientY === 0) return;

      // 更新 floating preview 位置 (GPU 加速 + rAF 節流)
      const targetX = e.clientX - _dragPreview._offsetX;
      const targetY = e.clientY - _dragPreview._offsetY;
      if (!_rafPending) {
        _rafPending = true;
        requestAnimationFrame(() => {
          if (_dragPreview) {
            _dragPreview.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
          }
          _rafPending = false;
        });
      }
    });

    // 全域 drop：僅取消瀏覽器預設行為（開新分頁、飛回原位）
    // 真正的排序寫入由內部 drop 處理器負責
    document.addEventListener('drop', e => {
      e.preventDefault();
    });
  }

  // ──────────────────────────────────────────────
  // 打開 Modal
  // ──────────────────────────────────────────────
  async function open() {
    const ws = _store();
    if (!ws) return;

    await ws.init();

    // 確保股票 index 已載入
    _loadStockIndex();

    els.overlay.classList.remove('hidden');
    await _renderAll();
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
  async function _renderAll() {
    const ws = _store();
    if (!ws) return;
    const readOnly = ws.isReadOnly();

    // 唯讀模式：隱藏新增/編輯/刪除 UI
    if (els.newListInput) {
      const newListBlock = els.newListInput.closest('.shrink-0');
      if (newListBlock) newListBlock.style.display = readOnly ? 'none' : '';
    }
    if (els.newStockInput) {
      const newStockBlock = els.newStockInput.closest('.shrink-0');
      if (newStockBlock) newStockBlock.style.display = readOnly ? 'none' : '';
    }
    if (els.editListBtn) els.editListBtn.style.display = readOnly ? 'none' : '';
    if (els.deleteListBtn) els.deleteListBtn.style.display = readOnly ? 'none' : '';

    await _renderLeftList(ws);
    await _renderRightPanel(ws);
  }

  // ──────────────────────────────────────────────
  // 左欄渲染
  // ──────────────────────────────────────────────
  async function _renderLeftList(ws) {
    const container = els.leftList;
    if (!container) return;

    const readOnly = ws.isReadOnly();
    const allLists = await ws.getAllLists();
    const activeName = await ws.getActiveListName();
    const listNames = Object.keys(allLists);

    container.innerHTML = '';

    if (!listNames.length) {
      container.innerHTML = '<div class="text-xs text-slate-700 dark:text-slate-400 text-center py-4">尚無清單</div>';
      return;
    }

    listNames.forEach(name => {
      const ids = allLists[name] || [];
      const count = ids.length;
      const isActive = name === activeName;

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-1.5 px-2.5 rounded cursor-pointer select-none ' +
        (isActive
          ? 'bg-indigo-50 dark:bg-indigo-900 border border-indigo-200 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
          : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700');
      row.style.cssText = row.style.cssText + 'transition:all 120ms ease;';
      row.draggable = !readOnly;
      row.dataset.listName = name;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'text-xs font-medium truncate';
      nameSpan.textContent = name;

      const countSpan = document.createElement('span');
      countSpan.className = 'text-xs text-slate-700 dark:text-slate-400 shrink-0 ml-1';
      countSpan.textContent = `(${count})`;

      const gripEl = document.createElement('span');
      gripEl.className = 'shrink-0 flex items-center';
      gripEl.innerHTML = readOnly ? '' : ICON_GRIP;

      const leftGroup = document.createElement('span');
      leftGroup.className = 'flex items-center min-w-0 flex-1 gap-0.5';
      leftGroup.appendChild(nameSpan);

      const rightGroup = document.createElement('span');
      rightGroup.className = 'flex items-center shrink-0 gap-0.5';
      rightGroup.appendChild(countSpan);

      row.appendChild(gripEl);
      row.appendChild(leftGroup);
      row.appendChild(rightGroup);

      // 點擊 row 切換 active
      row.addEventListener('click', async e => {
        // 避免拖曳結束後觸發 click
        if (row.dataset.wasDragged === 'true') {
          row.dataset.wasDragged = 'false';
          return;
        }
        _currentListName = name;
        await ws.setActiveList(name);
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

      // 消除原生 ghost：使用 1x1 透明像素
      e.dataTransfer.setDragImage(_transparentImg, 0, 0);

      // 建立自訂 floating preview（100% 不透明）
      const rowRect = row.getBoundingClientRect();
      const dragOffsetX = e.clientX - rowRect.left;
      const dragOffsetY = e.clientY - rowRect.top;

      const clone = row.cloneNode(true);
      clone.removeAttribute('id');
      clone.style.cssText = `position:fixed;top:0;left:0;pointer-events:none;z-index:99999;opacity:1;will-change:transform;width:${rowRect.width}px;box-sizing:border-box;transform:translate3d(${e.clientX - dragOffsetX}px, ${e.clientY - dragOffsetY}px, 0);`;
      document.body.appendChild(clone);
      _dragPreview = clone;
      _dragPreview._offsetX = dragOffsetX;
      _dragPreview._offsetY = dragOffsetY;

      // 原位保留透明輪廓
      requestAnimationFrame(() => {
        row.style.opacity = '0';
      });
    });

    row.addEventListener('dragend', e => {
      // 清理 floating preview
      if (_dragPreview) {
        _dragPreview.remove();
        _dragPreview = null;
      }
      // 恢復所有 row opacity
      row.style.opacity = '';
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
        delete r.dataset.isDragging;
      });
      row.dataset.wasDragged = 'true';
    });

    // container 層 dragover：確保行間縫隙也是合法落點
    container.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragenter', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // (0,0) 防護：瀏覽器偶發座標歸零
      if (e.clientX === 0 && e.clientY === 0) return;

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

    row.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();

      // 清理 floating preview
      if (_dragPreview) {
        _dragPreview.remove();
        _dragPreview = null;
      }

      // 立即恢復所有行 opacity，阻止瀏覽器播放飛回動畫
      row.style.opacity = '';
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
      });

      // 根據目前 DOM 順序寫入 Store
      const rows = Array.from(container.querySelectorAll('[draggable]'));
      const draggedName = e.dataTransfer.getData('text/plain');

      // 找出目前 DOM 中 dragged 元素的位置 (fromIndex)
      const fromIdx = rows.findIndex(r => r.dataset.listName === draggedName);
      if (fromIdx === -1) return;

      const currentOrder = rows.map(r => r.dataset.listName);
      const allLists = await ws.getAllLists();
      const originalOrder = Object.keys(allLists);

      const origFromIdx = originalOrder.indexOf(draggedName);
      const newToIdx = currentOrder.indexOf(draggedName);

      if (origFromIdx !== -1 && newToIdx !== -1 && origFromIdx !== newToIdx) {
        await ws.moveList(origFromIdx, newToIdx);
      }
    });
  }

  // ──────────────────────────────────────────────
  // 右欄渲染
  // ──────────────────────────────────────────────
  async function _renderRightPanel(ws) {
    const readOnly = ws.isReadOnly();
    // 直接從 Store 的 active_list 取得當前清單（localStorage 記憶）
    const allLists = await ws.getAllLists();
    const listNames = Object.keys(allLists);

    let listName = await ws.getActiveListName();

    // fallback：若 active 不存在於 lists 中
    if (!allLists[listName] && listNames.length > 0) {
      listName = listNames[0];
      await ws.setActiveList(listName);
    }

    // 標題
    if (els.rightTitle) {
      els.rightTitle.textContent = listName || '';
    }

    // 刪除按鈕：清單數 <= 1 或唯讀時隱藏
    if (els.deleteListBtn) {
      els.deleteListBtn.style.display = (listNames.length <= 1 || !listName || readOnly) ? 'none' : '';
    }

    // 渲染個股列表
    const container = els.rightStocks;
    if (!container) return;

    const ids = listName ? (allLists[listName] || []) : [];

    container.innerHTML = '';

    if (!ids.length) {
      container.innerHTML = '<div class="text-xs text-slate-700 dark:text-slate-400 text-center py-8">此清單尚無股票</div>';
      return;
    }

    ids.forEach((stockId, idx) => {
      const stockName = _stockIndexMap ? (_stockIndexMap[stockId] || '') : '';

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between py-1.5 px-2.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-300';
      row.style.cssText = 'transition:all 120ms ease;';
      row.draggable = !readOnly;
      row.dataset.stockId = stockId;

      // Drag Handle + 文字（唯讀時隱藏 grip 並無法拖曳）
      const leftSpan = document.createElement('span');
      leftSpan.className = 'text-xs font-medium flex items-center gap-1';
      leftSpan.innerHTML = readOnly ? (stockName ? `${stockId} ${stockName}` : stockId) : `${ICON_GRIP}${stockName ? `${stockId} ${stockName}` : stockId}`;

      const rightBtn = document.createElement('button');
      rightBtn.className = 'w-5 h-5 flex items-center justify-center rounded text-rose-500 dark:text-rose-400 hover:text-rose-600 dark:hover:text-rose-300 bg-rose-50 dark:bg-rose-900 hover:bg-rose-100 dark:hover:bg-rose-800 border border-rose-200 dark:border-rose-700 transition-colors shrink-0 ml-2';
      rightBtn.innerHTML = ICON_X;
      if (readOnly) { rightBtn.style.display = 'none'; }
      rightBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!listName) return;
        await ws.removeFromList(listName, stockId);
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

      // 消除原生 ghost：使用 1x1 透明像素
      e.dataTransfer.setDragImage(_transparentImg, 0, 0);

      // 建立自訂 floating preview（100% 不透明）
      const rowRect = row.getBoundingClientRect();
      const dragOffsetX = e.clientX - rowRect.left;
      const dragOffsetY = e.clientY - rowRect.top;

      const clone = row.cloneNode(true);
      clone.removeAttribute('id');
      clone.style.cssText = `position:fixed;top:0;left:0;pointer-events:none;z-index:99999;opacity:1;will-change:transform;width:${rowRect.width}px;box-sizing:border-box;transform:translate3d(${e.clientX - dragOffsetX}px, ${e.clientY - dragOffsetY}px, 0);`;
      document.body.appendChild(clone);
      _dragPreview = clone;
      _dragPreview._offsetX = dragOffsetX;
      _dragPreview._offsetY = dragOffsetY;

      // 原位保留透明輪廓
      requestAnimationFrame(() => {
        row.style.opacity = '0';
      });
    });

    row.addEventListener('dragend', e => {
      // 清理 floating preview
      if (_dragPreview) {
        _dragPreview.remove();
        _dragPreview = null;
      }
      // 恢復所有 row opacity
      row.style.opacity = '';
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
        delete r.dataset.isDragging;
      });
      row.dataset.wasDragged = 'true';
    });

    // container 層 dragover：確保行間縫隙也是合法落點
    container.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragenter', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      // (0,0) 防護：瀏覽器偶發座標歸零
      if (e.clientX === 0 && e.clientY === 0) return;

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

    row.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();

      // 清理 floating preview
      if (_dragPreview) {
        _dragPreview.remove();
        _dragPreview = null;
      }

      // 立即恢復所有行 opacity，阻止瀏覽器播放飛回動畫
      row.style.opacity = '';
      container.querySelectorAll('[draggable]').forEach(r => {
        r.style.opacity = '';
      });

      const rows = Array.from(container.querySelectorAll('[draggable]'));
      const draggedId = e.dataTransfer.getData('text/plain');

      const fromIdx = rows.findIndex(r => r.dataset.stockId === draggedId);
      if (fromIdx === -1) return;

      const allLists = await ws.getAllLists();
      const originalIds = [...(allLists[listName] || [])];
      const currentIds = rows.map(r => r.dataset.stockId);

      const origFromIdx = originalIds.indexOf(draggedId);
      const newToIdx = currentIds.indexOf(draggedId);

      if (origFromIdx !== -1 && newToIdx !== -1 && origFromIdx !== newToIdx) {
        await ws.moveInList(listName, origFromIdx, newToIdx);
      }
    });
  }

  // ──────────────────────────────────────────────
  // 新增清單 handler
  // ──────────────────────────────────────────────
  async function _handleNewList() {
    const input = els.newListInput;
    const ws = _store();
    if (!input || !ws) return;

    const name = input.value.trim();
    if (!name) return;

    const ok = await ws.createList(name);
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
  async function _handleNewStock() {
    const input = els.newStockInput;
    const ws = _store();
    if (!input || !ws) return;

    const raw = input.value.trim();
    if (!raw) return;

    const listName = await ws.getActiveListName();
    if (!listName) return;

    // 分割：逗號或空白
    const tokens = raw.split(/[,，\s]+/).filter(Boolean);
    const notFound = [];
    let addedCount = 0;

    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;

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
        await ws.addToList(listName, stockId);
        addedCount++;
      } else {
        notFound.push(trimmed);
      }
    }

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
  // Inline 編輯清單名稱
  // ──────────────────────────────────────────────
  function _startRename(row, nameSpan, oldName, ws) {
    const leftGroup = nameSpan.parentElement;
    if (!leftGroup) return;

    // 隱藏 nameSpan + renameBtn
    nameSpan.style.display = 'none';
    const renameBtn = row.querySelector('button');
    if (renameBtn) renameBtn.style.display = 'none';

    // 建立 input
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = oldName;
    input.className = 'px-1 py-0.5 text-xs border border-indigo-300 dark:border-indigo-500 rounded bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 outline-none min-w-0 flex-1';
    input.setAttribute('autocomplete', 'off');

    // 插入到 leftGroup 中
    leftGroup.insertBefore(input, leftGroup.firstChild);
    input.focus();
    input.select();

    row.dataset.editing = 'true';

    // 提交編輯
    const _commit = async () => {
      const newName = input.value.trim();
      cleanup();
      if (newName && newName !== oldName) {
        const ok = await ws.renameList(oldName, newName);
        if (!ok) {
          _showError(els.leftError, '名稱重複或格式無效');
        }
        // 無論成功與否，由 watchlistchange 觸發 _renderAll 重繪
      }
    };

    // 取消編輯
    const _cancel = () => {
      cleanup();
    };

    const cleanup = () => {
      // 移除 input
      if (leftGroup.contains(input)) leftGroup.removeChild(input);
      // 顯示 nameSpan + renameBtn
      nameSpan.style.display = '';
      if (renameBtn) renameBtn.style.display = '';
      delete row.dataset.editing;
    };

    input.addEventListener('blur', () => {
      // 延遲，讓 click/keydown 先處理
      setTimeout(() => {
        if (row.dataset.editing === 'true') _commit();
      }, 100);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        _cancel();
      }
    });
  }

  // ──────────────────────────────────────────────
  // 右側標題 Inline 編輯 handler
  // ──────────────────────────────────────────────
  async function _handleEditListTitle() {
    const ws = _store();
    const titleEl = els.rightTitle;
    if (!titleEl || !ws) return;

    const oldName = await ws.getActiveListName();
    if (!oldName) return;

    // 隱藏 h3 文字內容
    titleEl.textContent = '';

    // 建立 input
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = oldName;
    input.className = 'px-1 py-0.5 text-xs border border-indigo-300 dark:border-indigo-500 rounded bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 outline-none min-w-0 flex-1';
    input.setAttribute('autocomplete', 'off');
    titleEl.appendChild(input);
    input.focus();
    input.select();

    const cleanup = () => {
      if (titleEl.contains(input)) titleEl.removeChild(input);
      titleEl.textContent = oldName;
    };

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== oldName) {
        const ok = await ws.renameList(oldName, newName);
        if (!ok) {
          _showError(els.rightError, '名稱重複或格式無效');
          // 失敗時還原名稱
          titleEl.textContent = oldName;
        }
        // 成功時由 watchlistchange → _renderAll 重繪
      }
      // 清理 input（無論成功或失敗）
      if (titleEl.contains(input)) titleEl.removeChild(input);
      if (!titleEl.textContent) titleEl.textContent = oldName;
    };

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (titleEl.contains(input)) commit();
      }, 100);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    });
  }

  // ──────────────────────────────────────────────
  // 刪除清單 handler
  // ──────────────────────────────────────────────
  async function _handleDeleteList() {
    const ws = _store();
    if (!ws) return;

    const allLists = await ws.getAllLists();
    const listNames = Object.keys(allLists);
    if (listNames.length <= 1) return;

    const name = await ws.getActiveListName();
    if (!name || !allLists[name]) return;

    if (!confirm(`確定要刪除清單「${name}」嗎？此操作無法復原。`)) return;

    await ws.deleteList(name);
  }

  // ──────────────────────────────────────────────
  // Public interface
  // ──────────────────────────────────────────────
  return { init, open, close };
})();