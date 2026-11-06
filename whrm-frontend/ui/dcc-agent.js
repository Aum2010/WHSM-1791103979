/* ═══════════════════════════════════════════════════════════════════════════
   DCC-AGENT.1.1.0 — ตัวเชื่อมกลางที่ server-dcc.js ฉีดให้ทุกหน้า HTML อัตโนมัติ
   (ไม่ต้องแก้ไฟล์โมดูล · ไม่แตะข้อมูลของโมดูล · ถ้าพังจะเงียบและไม่กระทบหน้า)

   ทำอย่างเดียว: ลงทะเบียน "การมีอยู่" ของหน้านี้ให้ DCC เห็น
     key  : whrm_dcc_mod_v1:<path>      เช่น  whrm_dcc_mod_v1:BD02.html
     ค่า  : { path, id, title, agent, forms, intake, openedAt, lastSeen, closedAt, tabs }
   · Single-writer: เขียนเฉพาะ key ของหน้าตัวเอง (DCC อ่านอย่างเดียว)
   · heartbeat ทุก 30 วินาที · ปิดแท็บ/เปลี่ยนหน้า → pagehide เคลียร์แท็บนั้น
   · ออนไลน์ = มีแท็บใดแท็บหนึ่งส่งสัญญาณภายใน 3 นาที

   v1.1.0 (ระยะ 2): ยืนยันรับสำเนาฟอร์มที่ DCC จ่ายให้หน้านี้ (อัตโนมัติ)
     อ่าน  whrm_dcc_copies_v1      (DCC เขียน — อ่านอย่างเดียว) เฉพาะสำเนาที่ module = path ของหน้านี้และ state = ISSUED
     เขียน whrm_dcc_ack_v1:<path>  { v:1, path, at, copies:{ <cid>:{ at, level, seenRev, forms } } }
       level = READY    หน้านี้มี DccForms และเห็นฟอร์มที่ Rev. ตรงกับสำเนา (พร้อมพิมพ์)
               MISMATCH หน้านี้เห็นฟอร์มแต่ Rev. ไม่ตรง
               NOFORMS  หน้านี้ไม่มีบล็อกฟอร์ม DccForms หรือไม่รู้จักฟอร์มนี้ (ยังพิมพ์ไม่ได้)
     เขียนเฉพาะเมื่อค่าเปลี่ยน · ไม่สร้าง key ถ้าหน้านี้ไม่มีสำเนา
   ═══════════════════════════════════════════════════════════════════════════ */
(function DCC_AGENT() {
  'use strict';
  try {
    if (window.DccAgent) return;
    if (window.top !== window.self) return;                       // ไม่ทำงานใน iframe
    var VER = 'DCC-AGENT.1.1.0', PREFIX = 'whrm_dcc_mod_v1:', BEAT_MS = 30000, ONLINE_MS = 180000;
    var COPIES = 'whrm_dcc_copies_v1', ACKP = 'whrm_dcc_ack_v1:', FORMS_KEY = 'whrm_dcc_forms_v1', CH = 'whrm-bus';
    var path;
    try { path = decodeURIComponent(location.pathname).replace(/^\/+/, ''); } catch (e) { path = location.pathname.replace(/^\/+/, ''); }
    if (!path || !/\.html?$/i.test(path) || /^index\.html?$/i.test(path)) return;   // หน้าเมนูไม่ต้องลงทะเบียน
    var key = PREFIX + path;
    var id = path.split('/').pop().replace(/\.html?$/i, '');
    var tab = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    var timer = null;

    function rd() { try { var s = localStorage.getItem(key); var o = s ? JSON.parse(s) : null; return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
    function wr(o) { try { localStorage.setItem(key, JSON.stringify(o)); return true; } catch (e) { return false; } }

    function beat(opening) {
      var now = Date.now(), o = rd() || { v: 1, path: path, id: id, firstSeen: new Date(now).toISOString(), tabs: {} };
      var tabs = o.tabs && typeof o.tabs === 'object' ? o.tabs : {}, k;
      for (k in tabs) { if (now - tabs[k] > ONLINE_MS) delete tabs[k]; }
      tabs[tab] = now;
      o.tabs = tabs; o.path = path; o.id = id; o.agent = VER;
      o.title = String(document.title || '').slice(0, 160);
      o.forms = (window.DccForms && window.DccForms.version) ? String(window.DccForms.version) : '';
      o.intake = (window.DccIntake && window.DccIntake.VERSION) ? String(window.DccIntake.VERSION) : '';
      o.lastSeen = new Date(now).toISOString();
      if (opening || !o.openedAt) o.openedAt = o.lastSeen;
      o.closedAt = '';
      wr(o);
    }

    /* ── ยืนยันรับสำเนา (v1.1.0) ── */
    function mine() {
      try {
        var s = localStorage.getItem(COPIES), L = s ? JSON.parse(s) : null;
        return L && Array.isArray(L.items) ? L.items.filter(function (c) { return c && c.module === path && c.state === 'ISSUED'; }) : [];
      } catch (e) { return []; }
    }
    function ackSync() {
      try {
        var held = mine(), prev = null, ak = ACKP + path;
        try { prev = JSON.parse(localStorage.getItem(ak) || 'null'); } catch (e) { prev = null; }
        if (!held.length && !prev) return;
        var now = new Date().toISOString(), out = {}, forms = window.DccForms;
        held.forEach(function (c) {
          var seen = '', level = 'NOFORMS', f = null;
          if (forms && typeof forms.get === 'function') { try { f = forms.get(c.formKey); } catch (e) { f = null; } }
          if (f) { seen = String(f.rev || ''); level = seen === String(c.rev) ? 'READY' : 'MISMATCH'; }
          var p = prev && prev.copies && prev.copies[c.cid];
          out[c.cid] = { at: p && p.level === level && p.seenRev === seen ? p.at : now, level: level, seenRev: seen, forms: forms && forms.version ? String(forms.version) : '' };
        });
        if (JSON.stringify(out) === JSON.stringify(prev && prev.copies || {})) return;
        localStorage.setItem(ak, JSON.stringify({ v: 1, path: path, at: now, copies: out }));
      } catch (e) { }
    }
    var ackTimer = null;
    function ackSoon() { clearTimeout(ackTimer); ackTimer = setTimeout(ackSync, 200); }

    function leave() {
      try {
        var o = rd(); if (!o) return;
        var tabs = o.tabs || {}; delete tabs[tab]; o.tabs = tabs;
        if (!Object.keys(tabs).length) o.closedAt = new Date().toISOString();
        wr(o);
      } catch (e) { }
    }

    function start() {
      beat(true); ackSync();
      timer = setInterval(function () { beat(false); ackSync(); }, BEAT_MS);
      window.addEventListener('storage', function (e) { if (!e.key || e.key === COPIES || e.key === FORMS_KEY) ackSoon(); });
      try { var bc = new BroadcastChannel(CH); bc.onmessage = function (ev) { var m = ev && ev.data; if (m && (m.type === 'DCC_COPY' || m.type === 'DCC_FORM_UPDATED')) ackSoon(); }; } catch (e) { }
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') beat(false); });
      window.addEventListener('pagehide', leave);
      window.addEventListener('beforeunload', leave);
    }

    /* รอให้สคริปต์ของหน้าโหลดจบก่อน เพื่ออ่านเวอร์ชัน DccForms/DccIntake ได้ถูก */
    if (document.readyState === 'complete') setTimeout(start, 50);
    else window.addEventListener('load', function () { setTimeout(start, 50); });

    window.DccAgent = { version: VER, path: path, id: id, key: key, beat: function () { beat(false); }, ack: ackSync, copies: mine,
      holds: function (formKey) { var l = mine().filter(function (c) { return c.formKey === formKey; }); return l.length ? l[l.length - 1] : null; }, stop: function () { if (timer) clearInterval(timer); timer = null; } };
  } catch (e) { /* เงียบ — ห้ามกระทบหน้าระบบ */ }
})();
