/**
 * watchlist-store.js — 自選股純資料層
 *
 * 零 DOM、零 HTML。透過 GitHub Gist API 做遠端持久化。
 * 掛載於 window.WatchlistStore。
 *
 * Gist 結構:
 *   window.GIST_ID — 由使用者設定於 HTML 或外部
 *   localStorage GH_GIST_PAT — 由 Konami Code Modal 設定
 *   檔案 chill_watchlist.json 內容: { lists: { "清單名": ["代號", ...] }, list_order: ["清單名", ...], active_list: "清單名" }
 */

window.WatchlistStore = (() => {
  'use strict';

  const GIST_ID = window.GIST_ID || 'b94daabf1616008aa1bbe10839a27df9';
  const GIST_FILENAME = 'watchlist.json';
  const GIST_API_BASE = 'https://api.github.com/gists';
  const LS_ACTIVE_LIST_KEY = 'WATCHLIST_ACTIVE_LIST';

  const DEFAULT_DATA = {
    lists: {
      "預設自選": [],
      "長線觀察": []
    },
    list_order: ["預設自選", "長線觀察"],
    active_list: "預設自選"
  };

  /** @type {null|{lists:Object<string,string[]>, list_order:string[], active_list:string}} */
  let _cache = null;

  // ──────────────────────────────────────────────
  // 私有 helpers
  // ──────────────────────────────────────────────

  /**
   * 驗證並修復從 Gist / fallback 讀出的資料結構
   * @param {any} rawData JSON.parse 後的原始物件
   * @returns {{lists:Object, list_order:string[], active_list:string}} 合法結構
   */
  function _validate(rawData) {
    if (!rawData || typeof rawData !== 'object') {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists }, list_order: [...DEFAULT_DATA.list_order] };
    }

    const lists = rawData.lists;
    if (!lists || typeof lists !== 'object' || Array.isArray(lists)) {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists }, list_order: [...DEFAULT_DATA.list_order] };
    }

    // 確保每個 list 的值都是 array
    const sanitizedLists = {};
    for (const [name, ids] of Object.entries(lists)) {
      sanitizedLists[name] = Array.isArray(ids) ? ids.map(String) : [];
    }

    // 確保至少有一個 list
    const listNames = Object.keys(sanitizedLists);
    if (listNames.length === 0) {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists }, list_order: [...DEFAULT_DATA.list_order] };
    }

    // 確保 active_list 在 lists 中存在
    let activeList = rawData.active_list;
    if (typeof activeList !== 'string' || !sanitizedLists[activeList]) {
      activeList = listNames[0];
    }

    // 處理 list_order
    let listOrder = [];
    if (Array.isArray(rawData.list_order)) {
      // 過濾出仍存在的清單名稱，並去重
      const seen = new Set();
      for (const name of rawData.list_order) {
        if (sanitizedLists[name] && !seen.has(name)) {
          listOrder.push(name);
          seen.add(name);
        }
      }
    }
    // 補上遺漏的清單名稱
    for (const name of listNames) {
      if (!listOrder.includes(name)) {
        listOrder.push(name);
      }
    }

    return { lists: sanitizedLists, list_order: listOrder, active_list: activeList };
  }

  /**
   * 讀取資料（快取優先），需要時從 Gist API fetch
   * @returns {Promise<{lists:Object, list_order:string[], active_list:string}>}
   */
  async function _load() {
    if (_cache !== null) return _cache;

    // 讀取 localStorage 中的 active_list（跨 session 記憶，不與其他人共享）
    const lsActive = localStorage.getItem(LS_ACTIVE_LIST_KEY);

    // 若無 GIST_ID，直接使用預設資料作為 memory-only 模式
    if (!GIST_ID) {
      _cache = { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists }, list_order: [...DEFAULT_DATA.list_order] };
      _cache.active_list = lsActive || DEFAULT_DATA.active_list;
      return _cache;
    }

    try {
      const res = await fetch(`${GIST_API_BASE}/${GIST_ID}`);
      if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);

      const gist = await res.json();
      const file = gist.files && gist.files[GIST_FILENAME];
      if (!file || typeof file.content !== 'string') {
        throw new Error('Gist file not found or content is not a string');
      }

      let parsed;
      try {
        parsed = JSON.parse(file.content);
      } catch (e) {
        throw new Error('Gist content JSON parse failed');
      }

      _cache = _validate(parsed);

      // 用 localStorage 中的 active_list 覆蓋 Gist 可能殘留的值（舊資料可能帶 active_list）
      if (lsActive && _cache.lists[lsActive]) {
        _cache.active_list = lsActive;
      } else if (!_cache.lists[_cache.active_list]) {
        // localStorage 無值或已無效時，fallback 到第一個 list
        const listNames = Object.keys(_cache.lists);
        if (listNames.length > 0) _cache.active_list = listNames[0];
      }

      return _cache;
    } catch (e) {
      console.error('WatchlistStore _load error, falling back to default:', e);
      _cache = { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists }, list_order: [...DEFAULT_DATA.list_order] };
      _cache.active_list = lsActive || DEFAULT_DATA.active_list;
      return _cache;
    }
  }

  /**
   * 寫入：記憶體快取 + 遠端 Gist PATCH（若有 PAT 且有 GIST_ID）
   * @param {{lists:Object, list_order:string[], active_list:string}} data
   */
  async function _save(data) {
    // 將 active_list 寫入 localStorage，不放入 Gist
    if (typeof data.active_list === 'string') {
      localStorage.setItem(LS_ACTIVE_LIST_KEY, data.active_list);
    }

    _cache = data;
    _notify();

    // 唯讀或無 GIST_ID，不寫遠端
    if (isReadOnly() || !GIST_ID) return;

    const pat = localStorage.getItem('GH_GIST_PAT');
    if (!pat) return;

    // 寫入 Gist 時剝除 active_list，只寫 lists + list_order (共享資料不包含個人偏好)
    const gistPayload = { lists: data.lists, list_order: data.list_order };

    try {
      const res = await fetch(`${GIST_API_BASE}/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${pat}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          files: {
            [GIST_FILENAME]: { content: JSON.stringify(gistPayload) }
          }
        })
      });

      if (!res.ok) {
        console.error('WatchlistStore _save PATCH failed:', res.status, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.error('WatchlistStore _save network error:', e);
    }
  }

  /**
   * 發出全域變更事件
   */
  function _notify() {
    window.dispatchEvent(new CustomEvent('watchlistchange'));
  }

  /**
   * 內部深拷貝 lists（用於回傳值，避免外部意外 mutate _cache）
   */
  function _deepCloneLists(lists) {
    const clone = {};
    for (const [name, ids] of Object.entries(lists)) {
      clone[name] = [...ids];
    }
    return clone;
  }

  // ──────────────────────────────────────────────
  // 公開 API
  // ──────────────────────────────────────────────

  /**
   * 是否為唯讀模式（無 PAT 時，變更僅在 memory，不寫 Gist）
   * @returns {boolean}
   */
  function isReadOnly() {
    return !localStorage.getItem('GH_GIST_PAT');
  }

  /**
   * 初始化：觸發首次遠端載入（或 fallback）
   * @returns {Promise<void>}
   */
  async function init() {
    await _load();
  }

  /**
   * 取得所有清單（依 list_order 排序）
   * @returns {Promise<Object<string, string[]>>} { 清單名: [股票代號, ...] }
   */
  async function getAllLists() {
    const data = await _load();
    const lists = _deepCloneLists(data.lists);
    // 建立依 order 排序的新物件（ES6 以後物件 key 順序可保留 insertion order）
    const ordered = {};
    for (const name of data.list_order) {
      if (lists[name] !== undefined) {
        ordered[name] = lists[name];
      }
    }
    // 補上遺漏（以防萬一）
    for (const [name, ids] of Object.entries(lists)) {
      if (ordered[name] === undefined) {
        ordered[name] = ids;
      }
    }
    return ordered;
  }

  /**
   * 取得當前 active 清單名稱
   * @returns {Promise<string>}
   */
  async function getActiveListName() {
    const data = await _load();
    return data.active_list;
  }

  /**
   * 取得當前 active 清單的股票代號陣列
   * @returns {Promise<string[]>}
   */
  async function getActiveIds() {
    const data = await _load();
    return [...(data.lists[data.active_list] || [])];
  }

  /**
   * 檢查特定股票是否在指定清單中
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   * @returns {Promise<boolean>}
   */
  async function isInList(listName, stockId) {
    const data = await _load();
    const arr = data.lists[listName];
    if (!arr) return false;
    return arr.includes(String(stockId));
  }

  /**
   * 檢查特定股票是否在任何清單中
   * @param {string} stockId - 股票代號
   * @returns {Promise<boolean>}
   */
  async function isStockInAnyList(stockId) {
    const data = await _load();
    const sid = String(stockId);
    return Object.values(data.lists).some(arr => arr.includes(sid));
  }

  /**
   * 切換當前 active 清單
   * @param {string} name - 清單名稱（必須存在於 lists 中）
   * @returns {Promise<void>}
   */
  async function setActiveList(name) {
    const data = await _load();
    if (!data.lists[name]) return;
    if (data.active_list === name) return;
    data.active_list = name;
    await _save(data);
  }

  /**
   * 建立新清單
   * @param {string} name - 清單名稱
   * @returns {Promise<boolean>} 成功回傳 true，失敗回傳 false
   */
  async function createList(name) {
    if (!name || typeof name !== 'string' || !name.trim()) return false;
    const trimmed = name.trim();

    if (trimmed.length > 20) return false;

    const data = await _load();
    if (data.lists[trimmed]) return false;

    data.lists[trimmed] = [];
    data.list_order.push(trimmed);
    await _save(data);
    return true;
  }

  /**
   * 刪除指定清單
   * @param {string} name - 清單名稱
   * @returns {Promise<void>}
   */
  async function deleteList(name) {
    const data = await _load();
    if (!data.lists[name]) return;

    const listNames = Object.keys(data.lists);
    if (listNames.length <= 1) return;

    delete data.lists[name];
    // 從 list_order 移除
    const idx = data.list_order.indexOf(name);
    if (idx !== -1) data.list_order.splice(idx, 1);

    if (data.active_list === name) {
      data.active_list = data.list_order[0];
    }

    await _save(data);
  }

  /**
   * 將股票代號加入指定清單
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   * @returns {Promise<void>}
   */
  async function addToList(listName, stockId) {
    const data = await _load();
    if (!data.lists[listName]) return;
    const sid = String(stockId);
    const arr = data.lists[listName];
    if (arr.includes(sid)) return;
    arr.push(sid);
    await _save(data);
  }

  /**
   * 將股票代號自指定清單移除
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   * @returns {Promise<void>}
   */
  async function removeFromList(listName, stockId) {
    const data = await _load();
    if (!data.lists[listName]) return;
    const sid = String(stockId);
    const arr = data.lists[listName];
    const idx = arr.indexOf(sid);
    if (idx === -1) return;
    arr.splice(idx, 1);
    await _save(data);
  }

  /**
   * 移動清單的顯示順序
   * @param {number} fromIndex - 目前索引
   * @param {number} toIndex - 目標索引
   * @returns {Promise<void>}
   */
  async function moveList(fromIndex, toIndex) {
    const data = await _load();
    const order = data.list_order;
    if (fromIndex < 0 || fromIndex >= order.length) return;
    if (toIndex < 0 || toIndex >= order.length) return;
    if (fromIndex === toIndex) return;

    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    await _save(data);
  }

  /**
   * 重新命名清單
   * @param {string} oldName - 原始清單名稱
   * @param {string} newName - 新清單名稱
   * @returns {Promise<boolean>} 成功回傳 true，失敗回傳 false
   */
  async function renameList(oldName, newName) {
    if (!newName || typeof newName !== 'string' || !newName.trim()) return false;
    const trimmed = newName.trim();

    if (trimmed.length > 20) return false;

    const data = await _load();
    if (!data.lists[oldName]) return false;
    if (oldName === trimmed) return false;
    if (data.lists[trimmed]) return false; // 新名稱已存在

    // 搬移 lists key
    data.lists[trimmed] = data.lists[oldName];
    delete data.lists[oldName];

    // 更新 list_order 中的名稱
    const idx = data.list_order.indexOf(oldName);
    if (idx !== -1) data.list_order[idx] = trimmed;

    // 更新 active_list（如果需要）
    if (data.active_list === oldName) {
      data.active_list = trimmed;
    }

    await _save(data);
    return true;
  }

  /**
   * 移動指定清單內個股的順序
   * @param {string} listName - 清單名稱
   * @param {number} fromIndex - 目前索引
   * @param {number} toIndex - 目標索引
   * @returns {Promise<void>}
   */
  async function moveInList(listName, fromIndex, toIndex) {
    const data = await _load();
    const arr = data.lists[listName];
    if (!arr) return;
    if (fromIndex < 0 || fromIndex >= arr.length) return;
    if (toIndex < 0 || toIndex >= arr.length) return;
    if (fromIndex === toIndex) return;

    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    await _save(data);
  }

  // ──────────────────────────────────────────────
  // Public interface
  // ──────────────────────────────────────────────
  return {
    isReadOnly,
    init,
    getAllLists,
    getActiveListName,
    getActiveIds,
    isInList,
    isStockInAnyList,
    setActiveList,
    createList,
    deleteList,
    addToList,
    removeFromList,
    moveList,
    renameList,
    moveInList
  };
})();