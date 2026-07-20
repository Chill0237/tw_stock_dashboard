/**
 * watchlist-manager.js — 自選股管理 Modal
 *
 * 獨立 UI 元件，掛載於 window.WatchlistManagerModal。
 * 提供清單增刪、個股移除、批次匯入三大管理功能。
 * 完全對接 WatchlistStore API 與全域 watchlistchange 事件。
 *
 * 生命週期：
 *   - open() 時建立 overlay DOM、綁定內部事件與 watchlistchange 監聽
 *   - close() 時移除所有監聽器並銷毀 DOM
 *
 * 無 emoji，純文字 UI。
 */

window.WatchlistManagerModal = (() => {
  'use strict';

  // ──────────────────────────────────────────────
  // 內部狀態
  // ──────────────────────────────────────────────
  let _overlay = null;
  let _currentListName = null;
  let _snapshotCache = null;
  let _wcHandler = null;

  // ──────────────────────────────────────────────
  // Toast 訊息
  // ──────────────────────────────────────────────
  function _showToast(msg, isError) {
    const toast = document.getElementById('wm-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = isError
      ? 'text-xs mt-2 text-rose-400'
      : 'text-xs mt-2 text-emerald-400';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.textContent = '';
      toast.className = 'text-xs mt-2';
    }, 3000);
  }

  // ──────────────────────────────────────────────
  // 取得 snapshot（含快取）
  // ──────────────────────────────────────────────
  async function _fetchSnapshot() {
    if (_snapshotCache) return _snapshotCache;
    try {
      const res = await fetch('./api/snapshot.json');
      if (!res.ok) throw new Error('fetch failed');
      _snapshotCache = await res.json();
      return _snapshotCache;
    } catch (e) {
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // 取得股票名稱（從 snapshotCache）
  // ──────────────────────────────────────────────
  function _getStockName(sid, stocks) {
    if (!stocks || !stocks[sid]) return '';
    return stocks[sid].n || '';
  }

  // ──────────────────────────────────────────────
  // 渲染清單下拉選單
  // ──────────────────────────────────────────────
  function _renderListSelect() {
    const select = document.getElementById('wm-list-select');
    if (!select) return;

    const ws = window.WatchlistStore;
    if (!ws) return;

    const lists = ws.getAllLists();
    const active = ws.getActiveListName();

    select.innerHTML = '';
    const keys = Object.keys(lists);
    keys.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + ' (' + lists[name].length + ')';
      select.appendChild(opt);
    });

    // 保留當前選中的清單，若已不存在則改用 active
    if (_currentListName && lists[_currentListName]) {
      select.value = _currentListName;
    } else {
      select.value = active;
      _currentListName = active;
    }
  }

  // ──────────────────────────────────────────────
  // 渲染個股列表
  // ──────────────────────────────────────────────
  async function _renderStockList() {
    const tbody = document.getElementById('wm-stock-tbody');
    if (!tbody) return;

    const ws = window.WatchlistStore;
    if (!ws) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center py-2 text-slate-400 dark:text-slate-500 text-2xs">WatchlistStore 未載入</td></tr>';
      return;
    }

    const ids = ws.getAllLists()[_currentListName] || [];
    if (!ids.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center py-2 text-slate-400 dark:text-slate-500 text-2xs">此清單尚無股票</td></tr>';
      return;
    }

    const snapshot = await _fetchSnapshot();
    const stocks = snapshot ? (snapshot.stocks || {}) : {};

    tbody.innerHTML = '';
    ids.forEach(sid => {
      const name = _getStockName(sid, stocks);
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-200 dark:border-slate-800';

      const tdId = document.createElement('td');
      tdId.className = 'py-1.5 px-2 font-mono text-slate-700 dark:text-slate-300 text-2xs';
      tdId.textContent = sid;

      const tdName = document.createElement('td');
      tdName.className = 'py-1.5 px-2 text-slate-600 dark:text-slate-400 text-2xs';
      tdName.textContent = name || '--';

      const tdAction = document.createElement('td');
      tdAction.className = 'py-1.5 px-2 text-right';

      const removeBtn = document.createElement('span');
      removeBtn.textContent = '[ 移除 ]';
      removeBtn.className = 'text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400 cursor-pointer text-2xs font-mono select-none';
      removeBtn.addEventListener('click', () => {
        ws.removeFromList(_currentListName, sid);
        // ws.removeFromList 內部會呼叫 _notify() 觸發 watchlistchange
        // Modal 自己的 watchlistchange handler 會重繪
      });

      tdAction.appendChild(removeBtn);
      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdAction);
      tbody.appendChild(tr);
    });
  }

  // ──────────────────────────────────────────────
  // 完整重繪（select + stock list）
  // ──────────────────────────────────────────────
  function _refreshAll() {
    _renderListSelect();
    _renderStockList();
  }

  // ──────────────────────────────────────────────
  // 建立 overlay DOM
  // ──────────────────────────────────────────────
  function _buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'watchlist-manager-overlay';
    overlay.className = 'fixed inset-0 z-[250] bg-slate-950/80 flex items-center justify-center p-4';

    overlay.innerHTML = `
      <div class="bg-white dark:bg-slate-900 max-w-lg w-full border border-slate-300 dark:border-slate-700 p-5 max-h-[85vh] overflow-y-auto">
        <!-- Header -->
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-slate-800 dark:text-slate-200 text-sm font-semibold m-0">自選管理</h2>
          <button id="wm-close-btn" class="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 text-2xs font-mono bg-transparent border-0 cursor-pointer select-none">[ 關閉 ]</button>
        </div>

        <!-- Section 1: 清單管理 -->
        <div class="mb-4">
          <div class="text-slate-500 dark:text-slate-400 text-2xs mb-1.5 font-semibold">清單管理</div>
          <div class="flex items-center gap-2 mb-2">
            <select id="wm-list-select" class="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-2xs px-2 py-1 flex-1 outline-none"></select>
          </div>
          <div class="flex items-center gap-2 mb-2">
            <input id="wm-new-list-input" type="text" maxlength="20" placeholder="新清單名稱" class="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-2xs px-2 py-1 flex-1 outline-none placeholder-slate-400 dark:placeholder-slate-500">
            <button id="wm-create-list-btn" class="bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-2xs px-3 py-1 border-0 cursor-pointer font-mono select-none whitespace-nowrap">[ 新增 ]</button>
          </div>
          <button id="wm-delete-list-btn" class="bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-rose-600 dark:text-rose-400 text-2xs px-3 py-1 border-0 cursor-pointer font-mono select-none">[ 刪除當前清單 ]</button>
        </div>

        <!-- Section 2: 個股管理 -->
        <div class="mb-4">
          <div class="text-slate-500 dark:text-slate-400 text-2xs mb-1.5 font-semibold">個股管理</div>
          <div class="max-h-48 overflow-y-auto">
            <table class="w-full text-2xs">
              <thead>
                <tr class="border-b border-slate-300 dark:border-slate-700 text-slate-400 dark:text-slate-500 text-left">
                  <th class="py-1 px-2 font-normal">代號</th>
                  <th class="py-1 px-2 font-normal">名稱</th>
                  <th class="py-1 px-2 text-right font-normal">操作</th>
                </tr>
              </thead>
              <tbody id="wm-stock-tbody"></tbody>
            </table>
          </div>
        </div>

        <!-- Section 3: 批次匯入 -->
        <div class="mb-4">
          <div class="text-slate-500 dark:text-slate-400 text-2xs mb-1.5 font-semibold">批次匯入</div>
          <textarea id="wm-batch-textarea" rows="3" placeholder="輸入股票代號，以逗號、空格或換行分隔" class="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-2xs px-2 py-1 w-full outline-none resize-none placeholder-slate-400 dark:text-slate-500 placeholder-slate-400 dark:placeholder-slate-500 mb-2"></textarea>
          <button id="wm-batch-import-btn" class="bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-2xs px-3 py-1 border-0 cursor-pointer font-mono select-none">[ 批次確認匯入 ]</button>
        </div>

        <!-- Toast -->
        <div id="wm-toast" class="text-xs mt-2 min-h-[1rem]"></div>
      </div>
    `;

    return overlay;
  }

  // ──────────────────────────────────────────────
  // 綁定內部事件
  // ──────────────────────────────────────────────
  function _bindEvents() {
    const overlay = _overlay;
    if (!overlay) return;

    // 關閉按鈕
    const closeBtn = overlay.querySelector('#wm-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', close);
    }

    // 點擊 overlay 背景關閉
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // ESC 關閉
    const escHandler = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escHandler);
    // 儲存 escHandler 以便 close 時移除
    overlay._escHandler = escHandler;

    // 清單切換
    const listSelect = overlay.querySelector('#wm-list-select');
    if (listSelect) {
      listSelect.addEventListener('change', () => {
        _currentListName = listSelect.value;
        _renderStockList();
      });
    }

    // 新增清單
    const createBtn = overlay.querySelector('#wm-create-list-btn');
    const newListInput = overlay.querySelector('#wm-new-list-input');
    if (createBtn && newListInput) {
      createBtn.addEventListener('click', () => {
        const ws = window.WatchlistStore;
        if (!ws) return;
        const raw = newListInput.value;
        const ok = ws.createList(raw);
        if (!ok) {
          if (!raw || !raw.trim()) {
            _showToast('新增失敗：清單名稱不可為空白', true);
          } else if (raw.trim().length > 20) {
            _showToast('新增失敗：清單名稱不可超過 20 字', true);
          } else {
            _showToast('新增失敗：名稱重複或無效', true);
          }
          return;
        }
        // 建立成功 → 自動切換至新清單
        _currentListName = raw.trim();
        _showToast('已建立清單: ' + _currentListName, false);
        newListInput.value = '';
        // watchlistchange 會觸發 _refreshAll
      });
    }

    // Enter 鍵新增清單
    if (newListInput) {
      newListInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const createBtn = overlay.querySelector('#wm-create-list-btn');
          if (createBtn) createBtn.click();
        }
      });
    }

    // 刪除清單
    const deleteBtn = overlay.querySelector('#wm-delete-list-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const ws = window.WatchlistStore;
        if (!ws) return;
        const lists = ws.getAllLists();
        if (Object.keys(lists).length <= 1) {
          _showToast('無法刪除：至少需保留一個清單', true);
          return;
        }
        ws.deleteList(_currentListName);
        // watchlistchange 會觸發 _refreshAll
      });
    }

    // 批次匯入
    const batchBtn = overlay.querySelector('#wm-batch-import-btn');
    const batchTextarea = overlay.querySelector('#wm-batch-textarea');
    if (batchBtn && batchTextarea) {
      batchBtn.addEventListener('click', () => {
        const ws = window.WatchlistStore;
        if (!ws) return;
        const raw = batchTextarea.value.trim();
        if (!raw) {
          _showToast('請輸入股票代號', true);
          return;
        }
        // 解析：以逗號、空格或換行分隔
        const tokens = raw.split(/[\s,]+/).filter(Boolean);
        const validIds = tokens.filter(t => /^\d+$/.test(t));
        if (!validIds.length) {
          _showToast('未偵測到有效股票代號', true);
          return;
        }
        let added = 0;
        validIds.forEach(id => {
          // addToList 內部有防重複，不會拋錯
          ws.addToList(_currentListName, id);
          added++;
        });
        _showToast('已匯入 ' + added + ' 檔股票', false);
        batchTextarea.value = '';
        // watchlistchange 會觸發 _refreshAll
      });
    }
  }

  // ──────────────────────────────────────────────
  // open: 建立並顯示 Modal
  // ──────────────────────────────────────────────
  function open() {
    // 避免重複建立
    if (_overlay) return;

    const ws = window.WatchlistStore;
    if (!ws) return;

    _snapshotCache = null; // 每次開啟強制重新 fetch snapshot
    _currentListName = ws.getActiveListName();

    _overlay = _buildOverlay();
    document.body.appendChild(_overlay);

    _bindEvents();

    // 初始渲染
    _renderListSelect();
    _renderStockList();

    // 註冊 watchlistchange 監聽
    _wcHandler = () => _refreshAll();
    window.addEventListener('watchlistchange', _wcHandler);
  }

  // ──────────────────────────────────────────────
  // close: 移除 Modal，清理所有監聽器
  // ──────────────────────────────────────────────
  function close() {
    if (!_overlay) return;

    // 移除 watchlistchange 監聽
    if (_wcHandler) {
      window.removeEventListener('watchlistchange', _wcHandler);
      _wcHandler = null;
    }

    // 移除 ESC 監聽
    if (_overlay._escHandler) {
      document.removeEventListener('keydown', _overlay._escHandler);
      _overlay._escHandler = null;
    }

    // 移除 DOM
    if (_overlay.parentNode) {
      _overlay.parentNode.removeChild(_overlay);
    }
    _overlay = null;
    _currentListName = null;
    // _snapshotCache 不清理，下次 open 時強制重取
  }

  // ──────────────────────────────────────────────
  // Public interface
  // ──────────────────────────────────────────────
  return { open, close };
})();