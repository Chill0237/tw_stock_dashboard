/**
 * watchlist-store.js — 自選股純資料層
 *
 * 零 DOM、零 HTML、零 fetch。僅操作 localStorage 與 memory cache。
 * 掛載於 window.WatchlistStore。
 *
 * localStorage key: "quant_watchlists"
 * 結構: { lists: { "清單名": ["代號", ...] }, active_list: "清單名" }
 */

window.WatchlistStore = (() => {
  'use strict';

  const STORAGE_KEY = 'quant_watchlists';

  const DEFAULT_DATA = {
    lists: {
      "預設自選": [],
      "長線觀察": []
    },
    active_list: "預設自選"
  };

  /** @type {null|{lists:Object<string,string[]>, active_list:string}} */
  let _cache = null;

  // ──────────────────────────────────────────────
  // 私有 helpers
  // ──────────────────────────────────────────────

  /**
   * 驗證並修復從 localStorage 讀出的資料結構
   * @param {any} rawData JSON.parse 後的原始物件
   * @returns {{lists:Object, active_list:string}} 合法結構
   */
  function _validate(rawData) {
    if (!rawData || typeof rawData !== 'object') {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists } };
    }

    const lists = rawData.lists;
    if (!lists || typeof lists !== 'object' || Array.isArray(lists)) {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists } };
    }

    // 確保每個 list 的值都是 array
    const sanitizedLists = {};
    for (const [name, ids] of Object.entries(lists)) {
      sanitizedLists[name] = Array.isArray(ids) ? ids.map(String) : [];
    }

    // 確保至少有一個 list
    const listNames = Object.keys(sanitizedLists);
    if (listNames.length === 0) {
      return { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists } };
    }

    // 確保 active_list 在 lists 中存在
    let activeList = rawData.active_list;
    if (typeof activeList !== 'string' || !sanitizedLists[activeList]) {
      activeList = listNames[0];
    }

    return { lists: sanitizedLists, active_list: activeList };
  }

  /**
   * 讀取資料（快取優先）
   * @returns {{lists:Object, active_list:string}}
   */
  function _load() {
    if (_cache !== null) return _cache;

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      _cache = { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists } };
      // 首次使用，寫入預設資料至 localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
      return _cache;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // parse 失敗 → 使用預設
      _cache = { ...DEFAULT_DATA, lists: { ...DEFAULT_DATA.lists } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
      return _cache;
    }

    _cache = _validate(parsed);
    // 若校驗後與原始 raw 不同，回寫修正版本
    const normalized = JSON.stringify(_cache);
    if (normalized !== raw) {
      localStorage.setItem(STORAGE_KEY, normalized);
    }
    return _cache;
  }

  /**
   * 雙寫：記憶體快取 + localStorage
   * @param {{lists:Object, active_list:string}} data
   */
  function _save(data) {
    _cache = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    _notify();
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
   * 取得所有清單
   * @returns {Object<string, string[]>} { 清單名: [股票代號, ...] }
   */
  function getAllLists() {
    return _deepCloneLists(_load().lists);
  }

  /**
   * 取得當前 active 清單名稱
   * @returns {string}
   */
  function getActiveListName() {
    return _load().active_list;
  }

  /**
   * 取得當前 active 清單的股票代號陣列
   * @returns {string[]}
   */
  function getActiveIds() {
    const data = _load();
    return [...(data.lists[data.active_list] || [])];
  }

  /**
   * 檢查特定股票是否在指定清單中
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   * @returns {boolean}
   */
  function isInList(listName, stockId) {
    const data = _load();
    const arr = data.lists[listName];
    if (!arr) return false;
    return arr.includes(String(stockId));
  }

  /**
   * 檢查特定股票是否在任何清單中
   * @param {string} stockId - 股票代號
   * @returns {boolean}
   */
  function isStockInAnyList(stockId) {
    const data = _load();
    const sid = String(stockId);
    return Object.values(data.lists).some(arr => arr.includes(sid));
  }

  /**
   * 切換當前 active 清單
   * @param {string} name - 清單名稱（必須存在於 lists 中）
   */
  function setActiveList(name) {
    const data = _load();
    if (!data.lists[name]) return; // 不存在則不動作
    if (data.active_list === name) return;
    data.active_list = name;
    _save(data);
  }

  /**
   * 建立新清單
   * @param {string} name - 清單名稱
   * @returns {boolean} 成功回傳 true，失敗回傳 false
   */
  function createList(name) {
    // 防呆 1: 空字串或僅空白
    if (!name || typeof name !== 'string' || !name.trim()) return false;
    const trimmed = name.trim();

    // 防呆 2: 純數字
    if (/^\d+$/.test(trimmed)) return false;

    // 防呆 3: 長度上限 20 字
    if (trimmed.length > 20) return false;

    // 防呆 4: 重複名稱
    const data = _load();
    if (data.lists[trimmed]) return false;

    data.lists[trimmed] = [];
    _save(data);
    return true;
  }

  /**
   * 刪除指定清單
   * @param {string} name - 清單名稱
   */
  function deleteList(name) {
    const data = _load();
    if (!data.lists[name]) return;

    const listNames = Object.keys(data.lists);
    // 防呆: 至少保留一個清單
    if (listNames.length <= 1) return;

    delete data.lists[name];

    // 若刪除的是當前 active，自動切換至剩餘的第一個
    if (data.active_list === name) {
      data.active_list = Object.keys(data.lists)[0];
    }

    _save(data);
  }

  /**
   * 將股票代號加入指定清單
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   */
  function addToList(listName, stockId) {
    const data = _load();
    if (!data.lists[listName]) return;
    const sid = String(stockId);
    const arr = data.lists[listName];
    if (arr.includes(sid)) return; // 防重複
    arr.push(sid);
    _save(data);
  }

  /**
   * 將股票代號自指定清單移除
   * @param {string} listName - 清單名稱
   * @param {string} stockId - 股票代號
   */
  function removeFromList(listName, stockId) {
    const data = _load();
    if (!data.lists[listName]) return;
    const sid = String(stockId);
    const arr = data.lists[listName];
    const idx = arr.indexOf(sid);
    if (idx === -1) return;
    arr.splice(idx, 1);
    _save(data);
  }

  // ──────────────────────────────────────────────
  // 初始化：觸發首次 _load() 以建立 cache
  // ──────────────────────────────────────────────
  _load();

  // ──────────────────────────────────────────────
  // Public interface
  // ──────────────────────────────────────────────
  return {
    getAllLists,
    getActiveListName,
    getActiveIds,
    isInList,
    isStockInAnyList,
    setActiveList,
    createList,
    deleteList,
    addToList,
    removeFromList
  };
})();