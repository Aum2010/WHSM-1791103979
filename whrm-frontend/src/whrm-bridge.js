/* ═══════════════════════════════════════════════════════════════════
   WH-RM Bridge (Phase A) — ต่อ V4.html / WH13.html เข้ากับ WH-RM server
   โดยไม่แก้โค้ดของแอป:

   1. Hydrate  : เขียน snapshot จาก server ลง localStorage ก่อนแอปเริ่มทำงาน
   2. KV sync  : hook localStorage.setItem/removeItem ของ key whrm_* → PUT /api/v1/sync/kv/:key
                 ชน version (409) → merge 3 ทาง (base / local / server) แล้วส่งใหม่
                 ค่าจากเครื่องอื่น → เขียน localStorage + เรียก load/render ของแอป + ยิง storage event
   3. Bus      : ครอบ BroadcastChannel('whrm-*') ให้ส่งต่อผ่าน WebSocket /bus ข้ามเครื่อง
   4. V4 API   : ตั้ง Settings ของ V4 ให้ apiCall() ยิงเข้า backend (ถ้ายังไม่ได้ตั้ง)

   โหลดจาก frontend (whrm-frontend) ต่อจาก config.js ที่ต้น <head>:
     window.WHRM_CONFIG = { apiBase: 'http://localhost:3000' }   ← backend อยู่คนละ origin ได้
   snapshot โหลดแบบ synchronous ก่อนแอปเริ่ม (ถ้า backend ล่ม → ใช้ข้อมูลในเครื่องไปก่อน)
   ถ้ามี window.__WHRM_BOOT (backend แทรกให้เอง) ใช้ค่านั้นแทน
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__whrmBridge) return;

  var CFG = window.WHRM_CONFIG || {};
  var BASE = String(CFG.apiBase || location.origin).replace(/\/+$/, '');
  var API = BASE + '/api/v1';
  var WS_URL = BASE.replace(/^http/i, 'ws') + '/bus';   // http → ws, https → wss
  var APP = CFG.app || (window.__WHRM_BOOT && window.__WHRM_BOOT.app) ||
    (/v4/i.test(location.pathname) ? 'V4' : /wh13/i.test(location.pathname) ? 'WH13' : /bd02/i.test(location.pathname) ? 'BD02' :
      /dbv2/i.test(location.pathname) ? 'DBV2' : /qa_?deviation/i.test(location.pathname) ? 'QA-DEV' : /qaincoming/i.test(location.pathname) ? 'QA-IN' :
      /planning/i.test(location.pathname) ? 'PLANNING' : /production/i.test(location.pathname) ? 'PRODUCTION' : 'unknown');

  // backend คนละ origin (เช่น Vercel → Railway): cookie ข้ามโดเมนถูก browser บล็อก
  // → ใช้ token จากหน้า login (localStorage '__whrm_auth_token' — ไม่ขึ้นต้น whrm จึงไม่ sync และไม่โดนล้างตอน V4 purge) แนบเป็น Bearer
  // same origin (proxy ของ frontend) → ใช้ cookie HttpOnly ตามเดิม
  var CROSS = BASE !== location.origin;
  var TOKEN_KEY = '__whrm_auth_token';
  // จับ localStorage ตัวจริงไว้ตั้งแต่ต้น — WH13 (ต.ค. 2026) แทน window.localStorage ด้วย Proxy ตอนท้ายหน้า
  // Storage.prototype.getItem.call(Proxy) → Illegal invocation → อ่าน token ไม่ได้ → 401 → เด้งไปหน้า login
  var NATIVE_LS = null;
  try { NATIVE_LS = window.localStorage; } catch (e) {}
  function authToken() {
    if (!CROSS) return null;
    try { return Storage.prototype.getItem.call(NATIVE_LS, TOKEN_KEY); } catch (e) { return null; }
  }
  function authHeaders(h) {
    h = h || {};
    var t = authToken();
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  // ยังไม่ login / session หมดอายุ → ไปหน้า login แล้วกลับมาหน้านี้
  var leaving = false;
  function goLogin() {
    if (leaving) return;
    leaving = true;
    try { Storage.prototype.removeItem.call(NATIVE_LS, TOKEN_KEY); } catch (e) {}
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
  }
  // ผู้ดูแลตั้งรหัสเริ่มต้นให้ → ต้องตั้งรหัสใหม่ที่หน้ารวมก่อนใช้งาน
  function goChangePassword() {
    if (leaving) return;
    leaving = true;
    location.replace('/?next=' + encodeURIComponent(location.pathname + location.search));
  }
  if (CROSS && !authToken()) { goLogin(); return; }   // ข้ามโดเมนแต่ยังไม่มี token → ไม่ต้องลองเรียก API

  // snapshot ต้องอยู่ใน localStorage ก่อน script ของแอปทำงาน → โหลดแบบรอผล (sync XHR)
  function loadSnapshotSync() {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', API + '/sync/snapshot?app=' + encodeURIComponent(APP), false);
      if (CROSS) { x.withCredentials = true; var tk = authToken(); if (tk) x.setRequestHeader('Authorization', 'Bearer ' + tk); }
      x.send(null);
      if (x.status === 200) { var b = JSON.parse(x.responseText); b.app = APP; return b; }
      if (x.status === 401) { goLogin(); return { kv: {}, busSeq: 0, app: APP, offline: true, unauth: true }; }
      if (x.status === 403 && /PASSWORD_CHANGE_REQUIRED/.test(x.responseText)) { goChangePassword(); return { kv: {}, busSeq: 0, app: APP, offline: true, unauth: true }; }
    } catch (e) {}
    console.warn('[Bridge] โหลดข้อมูลจาก backend ไม่ได้ (' + API + ') — ใช้ข้อมูลในเครื่องไปก่อน จะ sync เมื่อต่อได้');
    return { kv: {}, busSeq: 0, app: APP, offline: true };
  }
  var BOOT = window.__WHRM_BOOT || loadSnapshotSync();
  if (BOOT.unauth) return;   // กำลังไปหน้า login — ไม่ต้องติดตั้งอะไร

  // V4 apiCall() ใช้ fetch ปกติ → ข้าม origin ต้องแนบ cookie ให้
  if (CROSS && window.fetch) {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf(BASE) === 0) {
        init = Object.assign({}, init || {});
        if (!init.credentials) init.credentials = 'include';
        var hd = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
        if (!hd.has('Authorization') && authToken()) hd.set('Authorization', 'Bearer ' + authToken());
        init.headers = hd;
      }
      return nativeFetch(input, init);
    };
  }
  var ls;
  ls = NATIVE_LS;
  if (!ls) { console.warn('[Bridge] localStorage unavailable — bridge off'); return; }

  /* ── raw storage (ไม่ผ่าน hook) ── */
  var SP = Storage.prototype;
  var _get = SP.getItem, _set = SP.setItem, _remove = SP.removeItem, _key = SP.key;
  function rawGet(k) { return _get.call(ls, k); }
  function rawSet(k, v) { _set.call(ls, k, v); }
  function rawRemove(k) { _remove.call(ls, k); }
  function rawKeys() { var out = []; for (var i = 0; i < ls.length; i++) out.push(_key.call(ls, i)); return out; }

  /* ── timer ที่ไม่โดนกวาด ──
     WH13 มี patch ที่เรียก clearInterval(1..100000) ล้าง timer ทั้งหน้า (รวม setTimeout)
     bridge จึงจับเวลาใน Web Worker แทน (ID ของ worker ไม่อยู่ในหน้า) */
  var timerWorker = null, timerCbs = {}, timerSeq = 0;
  try {
    var timerSrc = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}';
    timerWorker = new Worker(URL.createObjectURL(new Blob([timerSrc], { type: 'text/javascript' })));
    timerWorker.onmessage = function (e) { var cb = timerCbs[e.data]; delete timerCbs[e.data]; if (cb) cb(); };
  } catch (e) { timerWorker = null; }
  function later(fn, ms) {
    if (!timerWorker) return setTimeout(fn, ms);
    var id = ++timerSeq;
    timerCbs[id] = fn;
    timerWorker.postMessage({ id: id, ms: ms });
    return id;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  /* ── key ที่ไม่ sync: ค่าเฉพาะเครื่อง / ช่องทาง transport ของ bus เดิม ── */
  var LOCAL_KEYS = {
    'whrm-bus': 1,                       // storage fallback ของ bus
    'whrm_shared_trips_v1': 1,           // storage fallback ของ WHBus (V4) — relay ผ่าน WebSocket แทน
    'whrm_shared_trips_v1_log': 1,
    'whrm_bus_offline_queue_v1': 1,
    'whrm_sync_audit_v1': 1,
    'whrm_bus_rma_last': 1,
    'whrm_device_id': 1,
    'whrm_cfg_v3': 1,                    // Settings ของ V4 (API base, mode)
    'whrm_filter_presets_v4': 1,
    'whrm_v4_active_mode': 1,
    'whrm_v4_rma_mode': 1,               // V4 สถานีที่รับงาน RMA เท่านั้นที่เข้าโหมดนี้
    'whrm_current_user_v1': 1,           // ผู้ใช้ที่ login อยู่บนเครื่องนี้
    'whrm_rma_dev_flags_v1': 1,
    'whrm_printq_v4': 1,                 // คิวพิมพ์ผูกกับเครื่องพิมพ์ของสถานี
    // WH13 (ต.ค. 2026): login / session ในแอป — ใครเข้าเครื่องไหนอยู่เครื่องนั้น
    'whrm_wh13_session_v1': 1,
    'whrm_trf_login_v1': 1,
    'whrm_ic_dev_session_v1': 1,
    // ค่า dev / ปลดล็อกชั่วคราว — ไม่ให้เครื่องหนึ่งไปเปลี่ยนการทำงานของทุกสถานี
    'whrm_ic_dev_mode_v1': 1,
    'whrm_i7_dev_flags_v1': 1,
    'whrm_rma_dev_ai_config_v1': 1,      // Dev Panel: เปิด/ปิด AI check, force pass
    'whrm_fgt_dev_unlock_v1': 1,
    'whrm_transfer_dest_unlock_v1': 1,
    'whrm_subunit_unlock_v1': 1,
    // ค่าหน้าจอของผู้ใช้เครื่องนี้
    'whrm_trf_last_src': 1,
    'whrm_ew_alerts_seen_v1': 1,
    // ร่างเอกสารแนบ (base64 ก้อนใหญ่) ก่อนกดส่ง
    'whrm_fgt_docs_draft_v1': 1,
    'whrm_issue_docs_draft_v1': 1,
    'whrm_return_docs_draft_v1': 1,
    'whrm_req_return_docs_draft_v1': 1,
    'whrm_si_return_docs_draft_v1': 1
  };
  var LOCAL_PREFIXES = ['whrm_backup_', 'whrm_override_daily_', 'whrm_bridge_'];
  // ข้อมูลกลางที่ไม่ขึ้นต้น whrm — master สินค้าของ DBV2.0 (WH13 / V4 อ่านไปใช้) · ลูกค้า (BD02 ↔ DBV2.0)
  // pmp_role_v66 (บทบาทที่เลือกบนหน้าจอ DBV2.0) เป็นค่าเฉพาะเครื่อง จึงไม่อยู่ในรายการ
  var SHARED_KEYS = {
    'pmp_master_v66': 1, 'pmp_categories_v66': 1, 'pmp_main_categories_v66': 1, 'pmp_mapping_v66': 1,
    'pmp_suppliers_v1': 1, 'pmp_audit_v66': 1, 'pmp.crm.customers.v4': 1
  };
  function isSynced(k) {
    if (typeof k !== 'string') return false;
    if (SHARED_KEYS[k]) return true;
    if (k.indexOf('whrm') !== 0) return false;
    if (LOCAL_KEYS[k]) return false;
    for (var i = 0; i < LOCAL_PREFIXES.length; i++) if (k.indexOf(LOCAL_PREFIXES[i]) === 0) return false;
    return true;
  }

  var DEVICE_ID = rawGet('whrm_bridge_device') || (function () { var id = 'dev-' + uid(); rawSet('whrm_bridge_device', id); return id; })();

  /* ── state ── */
  var base = {};      // key → ค่าที่ตรงกับ server ล่าสุด (string | null)
  var ver = {};       // key → version ล่าสุดที่รู้
  var dirty = {};     // key → true (มีการแก้ที่ยังไม่ส่ง)
  var pushing = {};   // key → true (กำลังส่ง)
  var applying = false;
  var stats = { pushed: 0, conflicts: 0, remote: 0, errors: 0, suppressedDeletes: 0 };

  function saveDirtyList() {
    try { rawSet('whrm_bridge_dirty', JSON.stringify(Object.keys(dirty))); } catch (e) {}
  }

  /* ═══ 3-way merge ═══════════════════════════════════════════ */
  var ID_FIELDS = ['id', '_id', 'roNo', 'ruNo', 'reportId', 'rmaNo', 'logId', 'key', 'code', 'c'];   // c = รหัสสินค้าใน master ของ DBV2.0
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // field ที่น่าจะเป็นเลขเอกสาร (fgtNo, fgaNo, trfNo, plRef, soNo, sbo_number …) — แอปตั้งชื่อไม่เหมือนกันทุกคิว
  var ID_LIKE = /(No|Ref|Id|_id|_no|_number)$/;

  function idFieldOf(arrays) {
    var all = [];
    arrays.forEach(function (a) { if (Array.isArray(a)) all = all.concat(a); });
    if (!all.length || !all.every(isObj)) return null;
    function unique(f) {
      return arrays.every(function (a) {
        if (!Array.isArray(a)) return true;
        var seen = {};
        for (var j = 0; j < a.length; j++) {
          var v = a[j][f];
          if (v === undefined || v === null || v === '' || seen[v]) return false;
          seen[v] = 1;
        }
        return true;
      });
    }
    for (var i = 0; i < ID_FIELDS.length; i++) if (unique(ID_FIELDS[i])) return ID_FIELDS[i];
    var guess = Object.keys(all[0]).filter(function (f) { return ID_LIKE.test(f) && typeof all[0][f] === 'string'; }).sort();
    for (var g = 0; g < guess.length; g++) if (unique(guess[g])) return guess[g];
    return null;
  }

  function mergeKeyed(b, l, s, f) {
    var bm = {}, lm = {}, sm = {};
    (b || []).forEach(function (x) { bm[x[f]] = x; });
    l.forEach(function (x) { lm[x[f]] = x; });
    s.forEach(function (x) { sm[x[f]] = x; });
    var out = [];
    // ลำดับของ server เป็นหลัก
    s.forEach(function (x) {
      var id = x[f], inB = id in bm;
      if (id in lm) out.push(merge3(inB ? bm[id] : undefined, lm[id], x));
      else if (!inB || !same(bm[id], x)) out.push(x);          // local ลบ แต่ server แก้ → เก็บไว้
    });
    // รายการที่มีแค่ฝั่ง local: แทรกที่ตำแหน่งเดิมของ local (unshift = หน้าสุด, push = ท้าย)
    l.forEach(function (x, i) {
      var id = x[f];
      if (id in sm) return;
      if (id in bm && same(bm[id], x)) return;                  // server ลบ และ local ไม่ได้แก้ → ลบ
      out.splice(Math.min(i, out.length), 0, x);
    });
    return out;
  }

  function mergeList(b, l, s) {
    // array ไม่มี id: เริ่มจาก server + เพิ่มรายการใหม่ของ local − รายการที่ local ลบ
    var bs = (b || []).map(function (x) { return JSON.stringify(x); });
    var ls_ = l.map(function (x) { return JSON.stringify(x); });
    var ss = s.map(function (x) { return JSON.stringify(x); });
    var removed = bs.filter(function (x) { return ls_.indexOf(x) < 0; });
    var out = s.filter(function (x, i) { return removed.indexOf(ss[i]) < 0; });
    l.forEach(function (x, i) { if (bs.indexOf(ls_[i]) < 0 && ss.indexOf(ls_[i]) < 0) out.push(x); });
    return out;
  }

  function merge3(b, l, s) {
    if (same(l, s)) return l;
    if (b !== undefined && same(b, l)) return s;   // local ไม่ได้แก้
    if (b !== undefined && same(b, s)) return l;   // server ไม่ได้แก้
    if (Array.isArray(l) && Array.isArray(s)) {
      var bArr = Array.isArray(b) ? b : [];
      var f = idFieldOf([bArr, l, s]);
      return f ? mergeKeyed(bArr, l, s, f) : mergeList(bArr, l, s);
    }
    if (isObj(l) && isObj(s)) {
      var bo = isObj(b) ? b : {};
      var out = {}, keys = {};
      Object.keys(s).forEach(function (k) { keys[k] = 1; });
      Object.keys(l).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var inL = k in l, inS = k in s, inB = k in bo;
        if (inL && inS) out[k] = merge3(inB ? bo[k] : undefined, l[k], s[k]);
        else if (inL) { if (!inB || !same(bo[k], l[k])) out[k] = l[k]; }
        else if (inS) { if (!inB || !same(bo[k], s[k])) out[k] = s[k]; }
      });
      return out;
    }
    return l; // ค่าเดี่ยวที่แก้ทั้งสองฝั่ง → ยึดเครื่องนี้ (เพิ่งแก้ล่าสุด)
  }

  /* เลขลำดับเอกสาร (FGT / IO / TRF / PL / TXN / logId ของ V4): แอปอ่านค่า +1 แล้วเขียนกลับ
     ชนกัน → ใช้ค่าที่มากกว่า (merge ปกติยึดค่าเครื่องนี้ → เลขถอยหลัง → ออกเลขซ้ำ) */
  var SEQ_KEYS = /^whrm_(fgt_seq_|io_seq_|trf_seq_v1$|pl_ref_seq_v1$|txn_seq_v1$|logid_counter_v4$)/;
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(v)); }
  function mergeSeq(b, l, s) {
    if (isNum(l) && isNum(s)) return Number(l) >= Number(s) ? l : s;
    if (isObj(l) && isObj(s)) {
      var bo = isObj(b) ? b : {}, out = {}, keys = {};
      Object.keys(s).concat(Object.keys(l)).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var inL = k in l, inS = k in s;
        if (inL && inS) out[k] = mergeSeq(bo[k], l[k], s[k]);
        else if (inL) { if (!(k in bo)) out[k] = l[k]; }   // อีกฝั่งลบวันเก่าทิ้งแล้ว → ไม่เอากลับมา
        else if (!(k in bo)) out[k] = s[k];
      });
      return out;
    }
    return merge3(b, l, s);
  }

  function parse(v) { if (v === null || v === undefined) return undefined; try { return JSON.parse(v); } catch (e) { return { __raw: v }; } }
  function mergeStrings(bStr, lStr, sStr, key) {
    if (lStr === null) return sStr;                 // local ถูกลบ/ไม่มี → ใช้ server
    if (sStr === null) return bStr === null ? lStr : (lStr === bStr ? null : lStr);
    var b = parse(bStr), l = parse(lStr), s = parse(sStr);
    if ((l && l.__raw !== undefined) || (s && s.__raw !== undefined)) return lStr;   // ไม่ใช่ JSON
    if (key && SEQ_KEYS.test(key)) return JSON.stringify(mergeSeq(b, l, s));   // "3" → 3 → "3" รูปแบบเดิม
    return JSON.stringify(merge3(b, l, s));
  }

  /* ═══ Refresh แอปหลังข้อมูลเปลี่ยนจากเครื่องอื่น ═══════════════
     ชื่อฟังก์ชัน/ตัวแปรอ้างแบบ global ของแอป (let/const ระดับบนสุดใช้ร่วมกันข้าม <script>)
     ทุกตัวอยู่ใน try — ถ้าแอปไม่มีฟังก์ชันนั้นก็ข้าม */
  var REFRESH = {
    whrm_ro_status_v6: function () {
      var expanded = {}, selected = [];
      try { roStatusStore.forEach(function (r) { if (r._expanded) expanded[r.id] = 1; }); } catch (e) {}
      try { selected = Array.from(selectedROIds); } catch (e) {}
      loadROStatusStore();
      roStatusStore.forEach(function (r) { if (expanded[r.id]) r._expanded = true; });
      selected.forEach(function (id) { if (roStatusStore.some(function (r) { return r.id === id; })) selectedROIds.add(id); });
      renderROStatusTable();
    },
    whrm_warehouse_data_v1: function () {
      loadWarehouseData();
      try { renderStockCardTable(); } catch (e) {}
      try { renderWhTransactions(); } catch (e) {}
      try { renderDashboardWarehouses(); } catch (e) {}
    },
    whrm_inspection_rules_v1: function () {
      loadInspectionRules();
      try { renderInspectionRulesTable(); } catch (e) {}
    },
    whrm_incoming_weighing_v1: function (value) {
      if (typeof weighingModalRecords === 'undefined') return;   // มีเฉพาะ WH13
      var list = JSON.parse(value || '[]');
      var have = {};
      weighingModalRecords.forEach(function (r) { have[r.reportId] = 1; });
      list.forEach(function (r) { if (!have[r.reportId]) weighingModalRecords.unshift(r); });
      var m = document.getElementById('modal-weighing');
      if (m && !m.classList.contains('hidden')) renderWeighingModalTable();
    },
    whrm_return_requests_v1: function () {
      if (typeof window.retRenderStatusTable === 'function') window.retRenderStatusTable();
    },
    whrm_users_v4: function () {
      loadUsers();
      try { renderUsersTable(); } catch (e) {}
    }
  };

  function applyLocal(key, value, reason) {
    var old = rawGet(key);
    if (old === value) return;
    applying = true;
    try {
      if (value === null) rawRemove(key); else rawSet(key, value);
    } finally { applying = false; }
    if (document.readyState !== 'loading' && REFRESH[key]) {
      try { REFRESH[key](value); } catch (e) { console.warn('[Bridge] refresh ' + key + ' failed:', e.message); }
    }
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: key, oldValue: old, newValue: value, url: location.href, storageArea: ls }));
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('whrm-bridge:change', { detail: { key: key, reason: reason } })); } catch (e) {}
  }

  /* ═══ 1. Hydrate ═══════════════════════════════════════════ */
  (function hydrate() {
    var seeded = rawGet('whrm_bridge_seeded') === '1';
    var carried = {};
    try { JSON.parse(rawGet('whrm_bridge_dirty') || '[]').forEach(function (k) { carried[k] = 1; }); } catch (e) {}
    var serverKv = BOOT.kv || {};

    Object.keys(serverKv).forEach(function (k) {
      if (!isSynced(k)) return;
      var s = serverKv[k];
      ver[k] = s.version; base[k] = s.value;
      var local = rawGet(k);
      if (local === s.value) return;
      if (local !== null && s.value !== null && (!seeded || carried[k])) {
        // เครื่องนี้มีข้อมูลที่ยังไม่เคยส่ง (ครั้งแรก หรือค้างจากตอน offline) → รวม แล้วส่งขึ้น
        var merged = mergeStrings(null, local, s.value, k);
        applying = true; rawSet(k, merged); applying = false;
        if (merged !== s.value) dirty[k] = true;
      } else {
        applying = true;
        if (s.value === null) rawRemove(k); else rawSet(k, s.value);
        applying = false;
      }
    });
    // backend ล่มตอนเปิดหน้า: ไม่รู้ว่า server มีอะไร → ไม่ส่งข้อมูลเก่าทั้งหมดขึ้นไป ส่งเฉพาะที่แก้ระหว่างนี้ (merge ตอนชน)
    if (!BOOT.offline) {
      rawKeys().forEach(function (k) {
        if (isSynced(k) && !(k in ver)) { ver[k] = 0; base[k] = null; dirty[k] = true; }
      });
      rawSet('whrm_bridge_seeded', '1');
    }
    saveDirtyList();

    // V4: ให้ apiCall() ยิงเข้า server นี้ ถ้ายังไม่ได้ตั้งค่า
    if (APP === 'V4') {
      try {
        var cfg = JSON.parse(rawGet('whrm_cfg_v3') || '{}');
        if (!cfg.apiBase || (cfg.__bridgeSet && cfg.apiBase !== API)) {
          cfg.apiBase = API; cfg.mode = 'live'; cfg.__bridgeSet = true; if (cfg.apiToken === undefined) cfg.apiToken = '';
          rawSet('whrm_cfg_v3', JSON.stringify(cfg));
        }
      } catch (e) {}
    }
  })();

  /* ═══ 2. Hook localStorage ═════════════════════════════════ */
  // removeItem จำนวนมากในช่วงสั้น ๆ = "ล้างข้อมูลเครื่องนี้" (เช่น purgeAllData ของ V4)
  // → ไม่ลบข้อมูลกลางที่ server: หยุดส่งทั้งหน้า แล้วโหลดใหม่ให้ดึงข้อมูลจาก server กลับมา
  var removeBurst = [];
  var BURST_COUNT = 4, BURST_MS = 1000;
  var purged = false;

  function onPurgeDetected() {
    if (purged) return;
    purged = true;
    dirty = {};
    stats.suppressedDeletes += removeBurst.length;
    try { _remove.call(ls, 'whrm_bridge_dirty'); } catch (e) {}
    console.warn('[Bridge] ตรวจพบการล้างข้อมูลจำนวนมาก — ล้างเฉพาะเครื่องนี้ ข้อมูลกลางที่ server ไม่ถูกลบ · กำลังโหลดใหม่');
    updatePill();
    later(function () { location.reload(); }, 1500);
  }

  function markDirty(k) {
    if (purged) return;
    dirty[k] = true;
    saveDirtyList();
    scheduleFlush(300);
  }

  SP.setItem = function (k, v) {
    var r = _set.call(this, k, v);
    if (this === ls && !applying && isSynced(String(k))) markDirty(String(k));
    return r;
  };
  SP.removeItem = function (k) {
    var key = String(k);
    var had = this === ls && isSynced(key) && _get.call(ls, key) !== null;
    var r = _remove.call(this, k);
    // master กลาง (DBV2.0 "Hard Reset" ลบ master แล้ว reload เพื่อ seed ใหม่) → ลบเฉพาะเครื่องนี้
    // ไม่ลบที่ server: reload แล้วได้ master ล่าสุดจาก server กลับมา (กู้ค่าเก่าได้ที่ POST /sync/kv/:key/restore)
    if (had && SHARED_KEYS[key]) { delete dirty[key]; return r; }
    if (had && !applying) {
      var now = Date.now();
      removeBurst = removeBurst.filter(function (t) { return now - t.at < BURST_MS; });
      removeBurst.push({ at: now, key: key });
      if (removeBurst.length >= BURST_COUNT) onPurgeDetected();
      else markDirty(key);
    }
    return r;
  };

  /* ═══ KV push ══════════════════════════════════════════════ */
  var flushTimer = null;
  function scheduleFlush(ms) {
    if (flushTimer) return;
    flushTimer = later(function () { flushTimer = null; flush(); }, ms);
  }
  function flush() {
    if (purged) return;
    Object.keys(dirty).forEach(function (k) {
      if (pushing[k]) return;
      // ถ้าเป็นส่วนหนึ่งของ burst ที่เพิ่งลบ ให้รอจนพ้นช่วง burst ก่อน
      if (rawGet(k) === null && removeBurst.some(function (t) { return t.key === k && Date.now() - t.at < BURST_MS; })) {
        scheduleFlush(BURST_MS);
        return;
      }
      push(k, 0);
    });
  }

  function push(k, attempt) {
    var local = rawGet(k);
    if (local === (k in base ? base[k] : null) && (ver[k] || 0) > 0) { delete dirty[k]; saveDirtyList(); return; }
    if (local === null && !(ver[k] > 0)) { delete dirty[k]; saveDirtyList(); return; }
    pushing[k] = true;
    delete dirty[k];
    fetch(API + '/sync/kv/' + encodeURIComponent(k), {
      method: 'PUT',
      credentials: CROSS ? 'include' : 'same-origin',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID }),
      body: JSON.stringify({ value: local, baseVersion: ver[k] || 0, deviceId: DEVICE_ID, connId: hub.connId })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      pushing[k] = false;
      if (r.status === 401) { dirty[k] = true; saveDirtyList(); goLogin(); return; }
      if (r.status === 200) {
        ver[k] = r.body.version; base[k] = local; stats.pushed++;
        if (rawGet(k) !== local) dirty[k] = true;     // มีการแก้เพิ่มระหว่างส่ง
      } else if (r.status === 409 && r.body.current) {
        stats.conflicts++;
        var cur = r.body.current;
        var merged = mergeStrings(k in base ? base[k] : null, rawGet(k), cur.value, k);
        ver[k] = cur.version; base[k] = cur.value;
        applyLocal(k, merged, 'merge');
        if (merged !== cur.value && attempt < 5) dirty[k] = true;
      } else {
        stats.errors++; dirty[k] = true;
        console.warn('[Bridge] sync ' + k + ' failed: HTTP ' + r.status, r.body && r.body.message);
      }
      saveDirtyList(); updatePill();
      if (dirty[k]) scheduleFlush(r.status === 409 ? 50 : 3000);
    }).catch(function () {
      pushing[k] = false; dirty[k] = true; stats.errors++;
      saveDirtyList(); updatePill(); scheduleFlush(3000);
    });
  }

  function onRemoteKv(m) {
    var k = m.key;
    if (!isSynced(k) || m.version <= (ver[k] || 0)) return;
    stats.remote++;
    if (dirty[k] || pushing[k]) return;   // มีของเครื่องนี้ค้างส่ง → จะได้ 409 แล้ว merge เอง
    ver[k] = m.version; base[k] = m.value;
    applyLocal(k, m.value, 'remote');
    updatePill();
  }

  /* ═══ 3. Bus (WebSocket ↔ BroadcastChannel) ════════════════ */
  var instances = [];
  var hub = {
    ws: null, connId: null, online: false, queue: [], lastSeq: BOOT.busSeq || 0, retry: 1000, attempts: 0, closes: 0,
    connect: function () {
      var self = this;
      self.attempts++;
      var ws, ended = false;
      // ปิด socket นี้แล้วนัดต่อใหม่ (ครั้งเดียวต่อ socket)
      function retryLater() {
        if (ended) return;
        ended = true;
        self.closes++;
        self.online = false; self.connId = null; updatePill();
        later(function () { self.connect(); }, self.retry);
        self.retry = Math.min(self.retry * 2, 15000);
      }
      try { var tk = authToken(); ws = new WebSocket(tk ? WS_URL + '?token=' + encodeURIComponent(tk) : WS_URL); }
      catch (e) { later(function () { self.connect(); }, self.retry); return; }
      self.ws = ws;
      // watchdog: browser บางตัวค้างที่ CONNECTING ไม่ปิดเองเมื่อ backend ล่ม → ตัดเองแล้วลองใหม่
      later(function () {
        if (!ended && ws.readyState === 0) { try { ws.close(); } catch (e) {} retryLater(); }
      }, 8000);
      ws.onopen = function () {
        self.retry = 1000;
        ws.send(JSON.stringify({ kind: 'hello', deviceId: DEVICE_ID, app: APP, lastSeq: self.lastSeq }));
      };
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.kind === 'welcome') {
          self.connId = m.connId; self.online = true;
          var q = self.queue; self.queue = [];
          q.forEach(function (x) { self.send(x); });
          scheduleFlush(10);
          updatePill();
        } else if (m.kind === 'bus') {
          if (m.seq) self.lastSeq = Math.max(self.lastSeq, m.seq);
          deliver(m.channel, m.data);
        } else if (m.kind === 'kv') {
          onRemoteKv(m);
        }
      };
      ws.onclose = function (e) {
        if (e && e.code === 4401) { ended = true; self.online = false; updatePill(); goLogin(); return; }
        retryLater();
      };
      ws.onerror = function () {};
    },
    send: function (obj) {
      if (this.ws && this.ws.readyState === 1 && this.online) this.ws.send(JSON.stringify(obj));
      else { this.queue.push(obj); if (this.queue.length > 300) this.queue.shift(); }
    }
  };

  function remember(inst, id) {
    inst.__seen.push(id);
    if (inst.__seen.length > 500) inst.__seen.splice(0, 100);
  }

  // message จาก server ที่มาก่อนแอปโหลดเสร็จ (เช่น replay / งานยกเลิก RU ที่ค้าง) → พักไว้
  // ส่งให้แอปหลัง load + 1 วิ เมื่อ listener ของ patch ต่าง ๆ สร้าง BroadcastChannel ครบแล้ว
  var appReady = false, pendingIn = [];
  window.addEventListener('load', function () {
    later(function () {
      appReady = true;
      var q = pendingIn; pendingIn = [];
      q.forEach(function (m) { deliver(m.channel, m.data); });
    }, 1000);
  });

  function deliver(channel, data) {
    if (!appReady) { pendingIn.push({ channel: channel, data: data }); return; }
    var id = data && data.__bridgeMsgId;
    instances.forEach(function (inst) {
      if (inst.__closed || inst.__name !== channel) return;
      if (id && inst.__seen.indexOf(id) >= 0) return;
      try { inst.dispatchEvent(new MessageEvent('message', { data: data })); } catch (e) {}
    });
  }

  /* ── กันรับรายการชั่งซ้ำ (WH13) ──
     WH13 กันซ้ำเฉพาะรายการที่ "ยังไม่นำเข้า" → V4 ส่งใบเดิมซ้ำหลังนำเข้าแล้ว = รายการกลับมา นำเข้าซ้ำได้ (สต็อกเบิ้ล)
     จำรายการที่เคยรับไว้ใน whrm_trip_received_v1 { reportId: { itemKey: เวลา } } (sync ทุกเครื่อง WH13)
     ข้อความซ้ำ → ตัดรายการที่เคยรับออก · ไม่เหลือเลย = ไม่ส่งต่อให้แอป */
  var RECEIVED_KEY = 'whrm_trip_received_v1';
  function tripItemKey(it) { return it._id ? 'id:' + it._id : 'cb:' + (it.code || '') + '|' + (it.batchNo || it.batch || '') + '|' + (it.netWeight || ''); }
  // ข้อความเดียวเข้า BroadcastChannel หลายตัวในหน้าเดียวกัน (แต่ละตัวได้สำเนาของตัวเอง) → ตัดสินครั้งเดียวต่อข้อความ
  var tripDecisions = {}, tripDecisionOrder = [];
  function dedupeTrip(msg) {
    var pl = msg.payload;
    if (!pl || !pl.reportId || !Array.isArray(pl.items)) return true;
    var mkey = msg.__bridgeMsgId || (pl.reportId + '|' + (msg.timestamp || '') + '|' + (pl._via || ''));
    var dec = tripDecisions[mkey];
    if (dec) { if (dec.keep) pl.items = pl.items.filter(function (it) { return dec.keep[tripItemKey(it)]; }); return !dec.drop; }
    var rec = {}; try { rec = JSON.parse(rawGet(RECEIVED_KEY) || '{}') || {}; } catch (e) { rec = {}; }
    var seen = rec[pl.reportId] || {};
    var fresh = pl.items.filter(function (it) { return !seen[tripItemKey(it)]; });
    var dropped = pl.items.length - fresh.length;
    var keep = {}; fresh.forEach(function (it) { keep[tripItemKey(it)] = 1; });
    tripDecisions[mkey] = { drop: !fresh.length, keep: dropped ? keep : null };
    tripDecisionOrder.push(mkey);
    if (tripDecisionOrder.length > 300) delete tripDecisions[tripDecisionOrder.shift()];
    if (!fresh.length) {
      bridgeToast('ข้าม ' + pl.reportId + ' — รับครบแล้ว (V4 ส่งซ้ำ)');
      console.log('[Bridge] TRIP_SAVED ' + pl.reportId + ' ซ้ำทั้งใบ — ไม่เพิ่มเข้า Auto Weighing');
      return false;
    }
    if (dropped) {
      pl.items = fresh;
      bridgeToast(pl.reportId + ': ข้าม ' + dropped + ' รายการที่รับแล้ว');
    }
    fresh.forEach(function (it) { seen[tripItemKey(it)] = Date.now(); });
    rec[pl.reportId] = seen;
    // เก็บ 2,000 ใบล่าสุด
    var ids = Object.keys(rec);
    if (ids.length > 2000) ids.slice(0, ids.length - 2000).forEach(function (k) { delete rec[k]; });
    try { localStorage.setItem(RECEIVED_KEY, JSON.stringify(rec)); } catch (e) {}
    return true;
  }
  // ข้อความสั้น ๆ มุมขวาล่าง (เหนือป้ายสถานะ) — ไม่บังหน้าจอ
  function bridgeToast(text) {
    var go = function () {
      var t = document.createElement('div');
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;right:8px;bottom:34px;z-index:2147483001;max-width:min(420px,calc(100vw - 16px));padding:8px 12px;border-radius:10px;' +
        'background:#92400e;color:#fff;font:600 12px/1.5 system-ui,"Noto Sans Thai",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';
      t.textContent = text;
      document.body.appendChild(t);
      later(function () { t.remove(); }, 6000);
    };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  }

  var NativeBC = window.BroadcastChannel;
  if (NativeBC) {
    var BridgedBC = function (name) {
      var inst = new NativeBC(name);
      inst.__name = String(name);
      inst.__seen = [];
      inst.__closed = false;
      // listener ตัวแรก: กัน message ซ้ำ (ได้ทั้งทาง native จากแท็บอื่น และทาง WebSocket)
      inst.addEventListener('message', function (e) {
        var id = e.data && e.data.__bridgeMsgId;
        if (id) {
          if (inst.__seen.indexOf(id) >= 0) { e.stopImmediatePropagation(); return; }
          remember(inst, id);
        }
        if (APP === 'WH13' && e.data && e.data.type === 'TRIP_SAVED' && !dedupeTrip(e.data)) e.stopImmediatePropagation();
      });
      var nativePost = inst.postMessage.bind(inst);
      inst.postMessage = function (msg) {
        var out = msg, id = null;
        if (isObj(msg)) {
          id = msg.__bridgeMsgId || uid();
          out = Object.assign({}, msg, { __bridgeMsgId: id });
        }
        nativePost(out);
        if (id && inst.__name.indexOf('whrm') === 0) {
          hub.send({ kind: 'bus', channel: inst.__name, msgId: id, data: out });
        }
      };
      var nativeClose = inst.close.bind(inst);
      inst.close = function () { inst.__closed = true; nativeClose(); };
      instances.push(inst);
      return inst;
    };
    BridgedBC.prototype = NativeBC.prototype;
    window.BroadcastChannel = BridgedBC;
  }

  /* ═══ สถานะบนหน้าจอ (มุมซ้ายล่าง) ══════════════════════════ */
  var pill = null, sysUser = null;
  // ชื่อผู้ใช้ที่ login ระบบอยู่ (แสดงบนป้าย — แท็บเล็ตใช้ร่วมกันจะได้รู้ว่าเป็นบัญชีใคร)
  try {
    fetch(API + '/auth/me', { credentials: CROSS ? 'include' : 'same-origin', headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { if (b && b.user) { sysUser = b.user.username; updatePill(); applyAccess(b); } })
      .catch(function () {});
  } catch (e) {}
  // พื้นที่ localStorage (browser ให้ราว 5 ล้านตัวอักษรต่อเว็บ) — เต็มแล้วแอปบันทึกไม่ได้โดยไม่แจ้งผู้ใช้
  var LS_LIMIT = 5 * 1024 * 1024, LS_WARN = 0.8;
  var lsUsed = 0;
  function measureStorage() {
    var n = 0;
    try { rawKeys().forEach(function (k) { n += k.length + (rawGet(k) || '').length; }); } catch (e) {}
    lsUsed = n;
  }
  (function watchStorage() { measureStorage(); updatePill(); later(watchStorage, 30000); })();
  function updatePill() {
    if (!pill) return;
    var pending = Object.keys(dirty).length + Object.keys(pushing).filter(function (k) { return pushing[k]; }).length;
    var on = hub.online;
    var full = lsUsed >= LS_LIMIT * LS_WARN;
    var pct = Math.round(lsUsed / LS_LIMIT * 100);
    pill.style.background = purged ? '#1e3a8a' : full ? '#b91c1c' : on ? (pending ? '#92400e' : '#065f46') : '#991b1b';
    pill.textContent = purged ? '↻ โหลดข้อมูลจาก server ใหม่…' : (on ? '● Server' : '○ Offline') + (sysUser ? ' · ' + sysUser : '') +
      (pending ? ' · รอส่ง ' + pending : '') + (full ? ' · ⚠ พื้นที่เครื่องใกล้เต็ม ' + pct + '%' : '');
    pill.title = 'WH-RM Bridge\nDevice: ' + DEVICE_ID + '\nApp: ' + APP +
      '\nส่งแล้ว: ' + stats.pushed + ' · รวมข้อมูล (conflict): ' + stats.conflicts +
      ' · รับจากเครื่องอื่น: ' + stats.remote + ' · error: ' + stats.errors +
      '\nพื้นที่เก็บข้อมูลในเครื่อง: ' + pct + '%';
  }
  function mountPill() {
    pill = document.createElement('div');
    pill.id = 'whrm-bridge-pill';
    // มุมขวาล่าง + pointer-events:none → ไม่บังปุ่มของแอป (ดูรายละเอียดได้ที่ window.__whrmBridge)
    pill.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483000;padding:2px 9px;border-radius:999px;' +
      'font:600 11px/1.6 system-ui,sans-serif;color:#fff;opacity:.8;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)';
    document.body.appendChild(pill);
    updatePill();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPill); else mountPill();

  window.addEventListener('beforeunload', function () { saveDirtyList(); });

  // WH13: ตัว restore inbox ของแอป (setTimeout 500ms) ถูก patch กวาด timer ทิ้งตั้งแต่ไฟล์เดิม
  // → inbox จาก V4 หายทุกครั้งที่ reload / เปิดเครื่องใหม่ — bridge restore ให้หลังหน้าโหลดเสร็จ
  window.addEventListener('load', function () {
    later(function () {
      try {
        var v = rawGet('whrm_incoming_weighing_v1');
        if (v && typeof weighingModalRecords !== 'undefined') REFRESH.whrm_incoming_weighing_v1(v);
      } catch (e) {}
    }, 1000);
  });

  /* ═══ V4: ส่งไป WH13 หลัง "นำส่ง WMS" เท่านั้น (ลูกค้ายืนยัน 18 ต.ค. 2026) ═══
     V4 เดิมส่ง TRIP_SAVED ตั้งแต่กดบันทึก (saveEntireTrip) → WH13 เห็นก่อนยืนยัน ทั้งที่ป้ายบน V4 ยัง "รอส่ง Bus"
     ครอบ WHBus.publish (ไม่ใช่ BroadcastChannel) เพราะ V4 ส่ง 2 ทาง: BroadcastChannel + localStorage fallback
       saveEntireTrip                       → ไม่ส่ง
       sendToWMS / bulk-select / manual-republish (ผู้ใช้กดเองและยืนยัน) → ส่ง + จำ reportId ว่ายืนยันแล้ว
       request-response (WH13 ขอย้อนหลังอัตโนมัติ) → ส่งเฉพาะใบที่ยืนยันแล้ว
     ปิดได้: WHRM_CONFIG.v4SendOnSave = true (กลับไปแบบเดิมของ V4) */
  var CONFIRM_KEY = 'whrm_bridge_v4_confirmed';
  var skippedResend = [];   // prefix whrm_bridge_ → อยู่เฉพาะเครื่อง
  function confirmedSet() { try { return JSON.parse(rawGet(CONFIRM_KEY) || 'null'); } catch (e) { return null; } }
  function markConfirmed(ids) {
    var s = confirmedSet() || {};
    ids.forEach(function (id) { if (id) s[id] = Date.now(); });
    var keys = Object.keys(s);
    if (keys.length > 2000) keys.sort(function (a, b) { return s[a] - s[b]; }).slice(0, keys.length - 2000).forEach(function (k) { delete s[k]; });
    rawSet(CONFIRM_KEY, JSON.stringify(s));
  }
  function guardV4Publish() {
    var bus = null;
    try { bus = typeof WHBus !== 'undefined' ? WHBus : window.WHBus; } catch (e) { bus = window.WHBus; }   // const ระดับบนสุดของ V4
    if (!bus || typeof bus.publish !== 'function' || bus.publish.__whrmGuard) return !!(bus && bus.publish && bus.publish.__whrmGuard);
    // ติดตั้งครั้งแรก: ใบที่มีอยู่แล้วถูกส่งไป WH13 ตอนบันทึกตามแบบเดิมไปแล้ว → ถือว่ายืนยัน (ไม่ให้ WH13 ขอย้อนหลังแล้วหาย)
    if (!confirmedSet()) {
      var old = [];
      try { savedLogRecords.forEach(function (r) { old.push(r.reportId); }); } catch (e) {}
      markConfirmed(old);
    }
    var orig = bus.publish;
    var guarded = function (type, payload) {
      if (type === 'TRIP_SAVED' && payload) {
        var via = payload._via;
        if (via === 'saveEntireTrip') {
          console.log('[Bridge] V4 บันทึก ' + payload.reportId + ' — ยังไม่ส่ง WH13 (รอกด "นำส่ง WMS")');
          return { type: type, payload: payload, held: true };
        }
        var sent = confirmedSet() || {};
        if (via === 'request-response') {
          if (!sent[payload.reportId]) return { type: type, payload: payload, held: true };
        } else if (sent[payload.reportId] && !CFG.v4AllowResend) {
          skippedResend.push(payload.reportId);
          if (skippedResend.length === 1) later(function () {
            var list = skippedResend.splice(0);
            bridgeToast('ข้าม ' + list.length + ' ใบที่ส่งไป WH13 แล้ว: ' + list.slice(0, 4).join(', ') + (list.length > 4 ? ' …' : '') + ' (ไม่ส่งซ้ำ)');
          }, 50);
          return { type: type, payload: payload, held: true, duplicate: true };
        } else {
          markConfirmed([payload.reportId]);
        }
      }
      return orig.apply(this, arguments);
    };
    guarded.__whrmGuard = true;
    bus.publish = guarded;
    console.log('[Bridge] V4: ส่งรายการชั่งไป WH13 เมื่อกด "นำส่ง WMS" เท่านั้น');
    return true;
  }
  if (APP === 'V4' && !CFG.v4SendOnSave) {
    (function tryGuard(n) { if (!guardV4Publish() && n < 60) later(function () { tryGuard(n + 1); }, 250); })(0);
  }

  /* ═══ สิทธิ์รายส่วน: ไม่มีสิทธิ์ส่วนของหน้านี้ = เปิดไม่ได้ (ผู้ดูแลตั้งที่ /users.html) ═══ */
  var MODULE_OF_APP = { V4: 'V4', WH13: 'WH13', BD02: 'BD02', DBV2: 'DBV2', 'QA-DEV': 'QA', 'QA-IN': 'QA', PRODUCTION: 'PRODUCTION', PLANNING: 'PRODUCTION' };
  var MODULE_NAME = { V4: 'ชั่ง (V4)', WH13: 'คลัง (WH13)', BD02: 'ขาย (BD02)', DBV2: 'Master (DBV2.0)', QA: 'QA', PRODUCTION: 'ผลิต + วางแผน' };
  var myAccess = null;
  function applyAccess(me) {
    myAccess = me.access || {};
    var mod = MODULE_OF_APP[APP];
    if (!mod || !me.modules) return;
    var level = (myAccess[mod] || {}).level || 'NONE';
    if (level !== 'NONE') return;
    var show = function () {
      if (document.getElementById('whrm-noaccess')) return;
      var d = document.createElement('div');
      d.id = 'whrm-noaccess';
      d.setAttribute('role', 'alertdialog');
      d.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.6 system-ui,"Noto Sans Thai",sans-serif';
      d.innerHTML = '<div style="max-width:440px;text-align:center;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px">' +
        '<div style="font-size:40px">🔒</div><h2 style="margin:6px 0 8px;font-size:20px">ไม่มีสิทธิ์ใช้หน้านี้</h2>' +
        '<p style="margin:0 0 16px;color:#94a3b8">บัญชี <b style="color:#e2e8f0">' + String(me.user.username).replace(/[<>&"]/g, '') + '</b> ยังไม่ได้รับสิทธิ์ส่วน <b style="color:#e2e8f0">' + (MODULE_NAME[mod] || mod) + '</b><br>ขอสิทธิ์จากผู้ดูแลระบบ</p>' +
        '<a href="/" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#38bdf8;color:#04263a;font-weight:600;text-decoration:none">กลับหน้ารวม</a></div>';
      document.body.appendChild(d);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  /* ═══ WH13: login ในหน้าจอด้วยบัญชีของตัวเอง ═══
     หน้าจอ WH13 ตรวจรหัสที่ browser กับบัญชีฝังในโค้ด (QA-001 / WH-002 / Tom) และผูกสิทธิ์กับชื่อเหล่านั้น
     → ชื่อที่ไม่อยู่ในบัญชีเดิม: ส่งไปตรวจที่ server (POST /auth/verify) ผ่านแล้วได้ "ชื่อในหน้าจอ" (alias)
       แล้วให้หน้าจอทำงานในนาม alias นั้น (ใส่รหัสใช้ครั้งเดียวชั่วคราวแล้วเรียกตัวตรวจเดิม) · server บันทึกว่าใครทำจริง
     บัญชีเดิม (Tom/8888 ฯลฯ) ยังใช้ได้ระหว่างเปลี่ยนผ่าน — ปิดได้ด้วย WHRM_CONFIG.legacyAppLogin = false */
  function verifySync(username, password, module, minLevel) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', API + '/auth/verify', false);
      x.setRequestHeader('Content-Type', 'application/json');
      if (CROSS) { x.withCredentials = true; var tk = authToken(); if (tk) x.setRequestHeader('Authorization', 'Bearer ' + tk); }
      x.send(JSON.stringify({ username: username, password: password, module: module, minLevel: minLevel || 'USE' }));
      var b = {}; try { b = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 200 && b.ok) return b;
      return { ok: false, message: b.message || ('ตรวจรหัสไม่ได้ (HTTP ' + x.status + ')') };
    } catch (e) { return { ok: false, message: 'ติดต่อ server ไม่ได้ — ลองใหม่อีกครั้ง' }; }
  }
  function appUsers() {
    var list = [];
    try { if (typeof systemUsers !== 'undefined' && systemUsers) list.push(systemUsers); } catch (e) {}
    try { if (window.systemUsers && list.indexOf(window.systemUsers) < 0) list.push(window.systemUsers); } catch (e) {}
    return list;
  }
  var LEGACY = CFG.legacyAppLogin !== false;
  function isLegacy(id) { return LEGACY && appUsers().some(function (o) { return Object.prototype.hasOwnProperty.call(o, id); }); }
  // ให้ตัวตรวจเดิมของหน้าจอผ่านในนาม alias: ใส่รหัสใช้ครั้งเดียวชั่วคราว แล้วคืนค่าเดิมทันที
  function asAlias(v, run) {
    lastAppLogin = { alias: v.alias, name: (v.user.fullName || v.user.username) + ' (' + v.user.username + ')', at: Date.now() };
    var token = 'whrm-' + uid(), saved = [];
    appUsers().forEach(function (o) {
      saved.push([o, Object.prototype.hasOwnProperty.call(o, v.alias), o[v.alias]]);
      var base = o[v.alias] || {}, copy = {};
      for (var k in base) copy[k] = base[k];
      copy.password = token;
      copy.name = (v.user.fullName || v.user.username) + ' (' + v.user.username + ')';
      o[v.alias] = copy;
    });
    try { return run(v.alias, token); }
    finally { saved.forEach(function (it) { if (it[1]) it[0][v.alias] = it[2]; else delete it[0][v.alias]; }); }
  }
  function denyMsg(v) { return '❌ ' + (v.ok ? 'ยังไม่ได้กำหนดชื่อในหน้าจอ WH13 — แจ้งผู้ดูแลระบบ' : v.message); }
  function guardWh13Login() {
    var done = 0;
    if (typeof window.__rmaGatePwdVerify === 'function') {
      if (!window.__rmaGatePwdVerify.__whrm) {
        var origGate = window.__rmaGatePwdVerify;
        var gate = function () {
          var uEl = document.getElementById('rmaGateUsername'), pEl = document.getElementById('rmaGatePassword');
          var idv = uEl ? uEl.value.trim() : '', pwd = pEl ? pEl.value : '';
          if (!idv || !pwd || isLegacy(idv)) return origGate.apply(this, arguments);
          var v = verifySync(idv, pwd, 'WH13', 'USE');
          if (!v.ok || !v.alias) {
            var st = document.getElementById('rmaGateStatus');
            if (st) {
              st.className = 'rounded-xl p-3 text-xs border border-rose-500/30 bg-rose-500/10 text-rose-300';
              st.textContent = denyMsg(v);
              st.classList.remove('hidden');
            }
            return;
          }
          var self = this, args = arguments;
          return asAlias(v, function (alias, token) {
            uEl.value = alias; pEl.value = token;
            try { return origGate.apply(self, args); } finally { uEl.value = idv; pEl.value = ''; }
          });
        };
        gate.__whrm = true;
        window.__rmaGatePwdVerify = gate;
      }
      done++;
    }
    if (typeof window.tryLogin === 'function') {
      if (!window.tryLogin.__whrm) {
        var origTry = window.tryLogin;
        var tl = function (userId, pass) {
          userId = String(userId || '').trim();
          if (!userId || !pass || isLegacy(userId)) return origTry.apply(this, arguments);
          var v = verifySync(userId, pass, 'WH13', 'VIEW');
          if (!v.ok || !v.alias) {
            var err = document.getElementById('loginErrorMsg');
            if (err) { err.innerText = denyMsg(v); err.classList.remove('hidden'); }
            return;
          }
          var self = this;
          return asAlias(v, function (alias, token) { return origTry.call(self, alias, token); });
        };
        tl.__whrm = true;
        window.tryLogin = tl;
      }
      done++;
    }
    return done === 2;
  }
  // Info Center (Dev Gate): ผ่านเฉพาะคนที่มีสิทธิ์ WH13 ระดับผู้ดูแล → ทำงานในนาม DEV_USER (Tom)
  function onIcLogin(e) {
    var m = document.getElementById('icLoginModalFix');
    if (!m || !m.contains(e.target)) return;
    if (e.type === 'click' && !(e.target.closest && e.target.closest('#icFixOk'))) return;
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    var ic = window.IC_CONFIG || {};
    var uEl = m.querySelector('#icFixUser'), pEl = m.querySelector('#icFixPass');
    if (!uEl || !pEl) return;
    var u = uEl.value.trim(), p = pEl.value;
    if (!u || !p || (LEGACY && u === (ic.DEV_USER || 'Tom'))) return;
    var v = verifySync(u, p, 'WH13', 'ADMIN');
    if (!v.ok) {
      e.preventDefault(); e.stopImmediatePropagation();
      var box = m.querySelector('[id*="Err"], [id*="err"]');
      if (box) { box.textContent = '❌ ' + v.message; box.style.display = ''; box.classList.remove('hidden'); } else alert(v.message);
      return;
    }
    var token = 'whrm-' + uid(), oldPass = ic.DEV_PASS;
    ic.DEV_PASS = token; uEl.value = ic.DEV_USER || 'Tom'; pEl.value = token;
    later(function () { ic.DEV_PASS = oldPass; }, 0);
  }
  /* ทุกหน้าต่างที่มีช่องรหัสผ่านใน WH13 (login sidebar · อนุมัติ · Override · ยกเลิก · ปฏิเสธ · ปลดล็อก …)
     WH13 มีตัวตรวจรหัสหลายชุดจากหลาย patch (attemptManualLogin, rmaGatePwdVerify, verifyOverridePassword …)
     ทุกชุดเทียบกับ systemUsers → ดักก่อนตัวตรวจทำงาน (capture): ชื่อที่ไม่ใช่บัญชีเดิม → ตรวจที่ server
     ผ่าน → เปลี่ยนช่องชื่อเป็น alias + ช่องรหัสเป็นรหัสใช้ครั้งเดียว + ใส่รหัสนั้นใน systemUsers ชั่วคราว แล้วปล่อยให้ตัวตรวจเดิมทำงาน */
  var CLOSE_RE = /ปิด|ยกเลิก|cancel|close|✕|×|กลับ/i;
  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  function credBox(target) {
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      var pw = [].filter.call(el.querySelectorAll('input[type=password]'), visible);
      if (pw.length === 1) {
        var all = [].filter.call(el.querySelectorAll('input'), visible), user = null;
        for (var i = 0; i < all.length && all[i] !== pw[0]; i++) if (/^(text|email|search|)$/.test(all[i].type || '')) user = all[i];
        if (user) return { box: el, user: user, pass: pw[0] };   // กล่องเล็กที่มีแต่ช่องรหัส (กด Enter ในช่องรหัส) → หาขึ้นไปต่อ
      }
      if (pw.length > 1) return null;
    }
    return null;
  }
  function onAppCredSubmit(e) {
    if (document.getElementById('icLoginModalFix') && document.getElementById('icLoginModalFix').contains(e.target)) return;   // Info Center มีตัวจัดการเอง
    var btn = null;
    if (e.type === 'click') {
      btn = e.target.closest && e.target.closest('button, [role=button], input[type=submit], a');
      if (!btn || CLOSE_RE.test((btn.textContent || btn.value || '') + ' ' + (btn.getAttribute('aria-label') || ''))) return;
    } else if (e.key !== 'Enter' || !/^INPUT$/.test(e.target.tagName)) return;
    var c = credBox(btn || e.target);
    if (!c) return;
    var u = c.user.value.trim(), pw = c.pass.value;
    if (!u || !pw || isLegacy(u) || pw.indexOf('whrm-') === 0) return;
    var v = verifySync(u, pw, 'WH13', 'USE');
    if (!v.ok || !v.alias) {
      // ให้ตัวตรวจเดิมแสดง "ไม่ถูกต้อง" ของมันเอง + บอกเหตุผลจริงใต้ช่อง
      c.pass.value = 'whrm-denied-' + uid();
      later(function () { c.pass.value = ''; }, 0);
      var note = c.box.querySelector('.whrm-cred-note');
      if (!note) { note = document.createElement('div'); note.className = 'whrm-cred-note'; note.style.cssText = 'margin-top:6px;font-size:12px;color:#fca5a5'; c.pass.insertAdjacentElement('afterend', note); }
      note.textContent = denyMsg(v);
      return;
    }
    var token = 'whrm-' + uid(), saved = [];
    appUsers().forEach(function (o) {
      saved.push([o, Object.prototype.hasOwnProperty.call(o, v.alias), o[v.alias]]);
      var base = o[v.alias] || {}, copy = {};
      for (var k in base) copy[k] = base[k];
      copy.password = token; copy.pin = token;
      copy.name = (v.user.fullName || v.user.username) + ' (' + v.user.username + ')';
      o[v.alias] = copy;
    });
    lastAppLogin = { alias: v.alias, name: (v.user.fullName || v.user.username) + ' (' + v.user.username + ')', at: Date.now() };
    c.user.value = v.alias; c.pass.value = token;
    var oldNote = c.box.querySelector('.whrm-cred-note'); if (oldNote) oldNote.remove();
    // คืนค่าหลังตัวตรวจเดิมทำงานเสร็จ (รอบเหตุการณ์นี้)
    // timer ใน Worker (WH13 กวาด setTimeout ทั้งหน้า) — ห้ามพลาด ไม่งั้นรหัสใช้ครั้งเดียวค้างใน systemUsers
    later(function () {
      saved.forEach(function (it) { if (it[1]) it[0][v.alias] = it[2]; else delete it[0][v.alias]; });
      if (c.pass.value === token) c.pass.value = '';
      if (c.user.value === v.alias && document.contains(c.user)) c.user.value = v.user.username;
    }, 300);
  }

  /* ชื่อบัญชีทดสอบของทีม UI (Tom / QA-001 / WH-002) → แสดงเป็นชื่อบทบาท ทุกข้อความบนหน้าจอ WH13
     ข้างในยังเป็นชื่อเดิม (WH13 ตรวจสิทธิ์จากชื่อ) — แปลงเฉพาะตัวหนังสือที่แสดง ไม่แตะช่องกรอก / โค้ด / ข้อมูลที่บันทึก
     แปลงเฉพาะ node ที่เพิ่งเพิ่ม/เปลี่ยน (WH13 render บ่อย) · ปิดได้: WHRM_CONFIG.relabelAliases = false */
  var ALIAS_LABEL = { Tom: 'ผู้ดูแล', 'QA-001': 'QA', 'WH-002': 'พนักงานคลัง' };
  var ALIAS_RE = /(^|[^A-Za-z0-9_-])(Tom|QA-001|WH-002)(?![A-Za-z0-9_-])/g;
  var SKIP_TAG = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1, CODE: 1, PRE: 1 };
  var lastAppLogin = null;
  function relabelText(n) {
    var t = n.nodeValue;
    if (!t || t.indexOf('Tom') < 0 && t.indexOf('QA-001') < 0 && t.indexOf('WH-002') < 0) return;
    var parent = n.parentNode;
    if (!parent || SKIP_TAG[parent.nodeName] || (parent.closest && parent.closest('[contenteditable=true], #whrm-bridge-pill'))) return;
    // ป้าย login: "Tom - ชื่อ (user)" → "ชื่อ (user) · ผู้ดูแล"
    var m = /^\s*(Tom|QA-001|WH-002) - (.+)$/.exec(t);
    var out = m ? m[2] + ' · ' + ALIAS_LABEL[m[1]] : t.replace(ALIAS_RE, function (all, pre, a) { return pre + ALIAS_LABEL[a]; });
    if (out !== t) n.nodeValue = out;
  }
  function relabelTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { relabelText(root); return; }
    if (root.nodeType !== 1 || SKIP_TAG[root.nodeName]) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) relabelText(n);
  }
  if (APP === 'WH13' && CFG.relabelAliases !== false) {
    var pending = [], queued = false;
    var flushRelabel = function () {
      queued = false;
      var list = pending; pending = [];
      for (var i = 0; i < list.length; i++) { try { relabelTree(list[i]); } catch (e) {} }
    };
    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r.type === 'characterData') pending.push(r.target);
        else for (var j = 0; j < r.addedNodes.length; j++) pending.push(r.addedNodes[j]);
      }
      if (!queued && pending.length) { queued = true; Promise.resolve().then(flushRelabel); }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener('DOMContentLoaded', function () { relabelTree(document.body); });
  }

  if (APP === 'WH13') {
    document.addEventListener('click', onAppCredSubmit, true);
    document.addEventListener('keydown', onAppCredSubmit, true);
    document.addEventListener('click', onIcLogin, true);
    document.addEventListener('keydown', onIcLogin, true);
    var gateTries = 0;
    (function waitWh13() { if (!guardWh13Login() && ++gateTries < 120) later(waitWh13, 500); })();
    window.addEventListener('load', function () { later(guardWh13Login, 1500); later(guardWh13Login, 5000); });
  }

  hub.connect();
  scheduleFlush(1500);

  window.__whrmBridge = {
    deviceId: DEVICE_ID,
    app: APP,
    apiBase: BASE,
    stats: stats,
    state: function () { return { online: hub.online, connId: hub.connId, lastSeq: hub.lastSeq, wsAttempts: hub.attempts, wsCloses: hub.closes, retryMs: hub.retry, timer: timerWorker ? 'worker' : 'setTimeout', dirty: Object.keys(dirty), versions: Object.assign({}, ver), storageUsed: lsUsed, storageLimit: LS_LIMIT }; },
    flush: flush,
    // ออกจากระบบ (ทั้งแบบ cookie และ token) แล้วไปหน้า login
    access: function () { return myAccess; },
    verify: verifySync,
    logout: function () {
      return fetch(API + '/auth/logout', { method: 'POST', credentials: CROSS ? 'include' : 'same-origin', headers: authHeaders() })
        .catch(function () {}).then(function () { goLogin(); });
    },
    merge3: merge3,
    mergeStrings: mergeStrings,
    isSynced: isSynced
  };
  console.log('[Bridge] ready — app=' + APP + ' device=' + DEVICE_ID + ' keys=' + Object.keys(ver).length);
})();
