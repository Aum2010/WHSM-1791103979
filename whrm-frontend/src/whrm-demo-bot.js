/* ═══════════════════════════════════════════════════════════════
   WH-RM Demo Bot (V4) — ปุ่มกรอก/ชั่งแทนคน สำหรับ demo
   - แสดงเมื่อ window.WHRM_CONFIG.demoBot = true (env DEMO_BOT=1 ตอน build / container เริ่ม)
   - ไม่แก้ไฟล์ V4.html ของลูกค้า — build แทรก <script> นี้ให้เฉพาะ V4.html
   - ทำงานผ่านฟังก์ชันเดิมของ V4 (submitSessionAuth, connectScale, doTare, captureWeight, saveEntireTrip …)
     ผลจึงเหมือนพนักงานกดเอง: บันทึกแล้ว WH13 ได้ TRIP_SAVED + toast "รับจาก V4" ตามปกติ
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict'
  if (window.__whrmDemoBot) return
  window.__whrmDemoBot = true
  var cfg = window.WHRM_CONFIG || {}
  if (!cfg.demoBot) return

  var USER = { username: 'operator_01', password: 'op123' }
  var CODES = { 'รับ': ['3A000', '3A001', '3H000'], 'PRP': ['3A000', '3A001', '3H000'] }
  var SUPPLIERS = ['ฟาร์มหมูสุขใจ', 'บจก. เบทาโกร', 'ไทยซีซันนิ่ง', 'ฟาร์มหมูบ้านนา']
  var PLATES = ['กข 1234', '3ฒ 5521', '70-1188', 'บพ 902', '2กท 7744']
  var running = false
  var stopReq = false

  var $ = function (id) { return document.getElementById(id) }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  var pick = function (a) { return a[Math.floor(Math.random() * a.length)] }
  var pad = function (n, w) { return String(n).padStart(w || 2, '0') }
  // ตัวแปร let / function ระดับบนของ V4 อ่านได้จาก script อื่น (global lexical scope เดียวกัน)
  var g = function (name) { try { return (0, eval)(name) } catch (e) { return undefined } }

  function say(msg) {
    var s = $('whrm-bot-status')
    if (s) s.textContent = msg
  }
  function check() { if (stopReq) throw new Error('หยุดแล้ว') }

  // ไฮไลต์ช่องที่บอทกำลังทำ (ให้คนดู demo ตามทัน)
  async function focusEl(el) {
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    var old = el.style.boxShadow
    el.style.transition = 'box-shadow .2s'
    el.style.boxShadow = '0 0 0 3px #f59e0b'
    await sleep(320)
    setTimeout(function () { el.style.boxShadow = old }, 700)
  }
  async function type(id, text) {
    check()
    var el = $(id)
    if (!el) return
    await focusEl(el)
    el.value = ''
    for (var i = 0; i < text.length; i++) {
      el.value += text[i]
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(18)
    }
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  async function choose(id, value) {
    check()
    var el = $(id)
    if (!el) return
    await focusEl(el)
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(250)
  }
  async function press(id, fn) {
    check()
    var el = id && $(id)
    if (el) await focusEl(el)
    fn()
    await sleep(300)
  }

  function lotOf(code) {
    var d = new Date()
    return 'LOT-' + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + code + '-' + pad(Math.floor(Math.random() * 999), 3)
  }
  // BBF/EXP แบบที่พนักงานพิมพ์ (วว/ดด/ปปปป พ.ศ.)
  function bbfOf(code) {
    var days = { '3A000': 5, '3A001': 5, '3H000': 365 }[code] || 30
    var d = new Date(Date.now() + days * 864e5)
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + (d.getFullYear() + 543)
  }

  // ---------- ขั้นตอน ----------
  async function fillTrip(kind) {
    say('กรอกข้อมูลเที่ยวรถ…')
    var basket = g('currentTripBasket') || []
    if (!basket.length && typeof window.createNewReportTransaction === 'function') window.createNewReportTransaction()
    await choose('weighingType', kind)
    await type('tripNo', 'TRIP-DEMO-' + pad(Math.floor(Math.random() * 999), 3))
    await type('vehiclePlate', pick(PLATES))
    await choose('vehicleType', pick(['4_wheels', '6_wheels', '10_wheels']))
    await type('supplierTransport', pick(SUPPLIERS))
  }

  async function ensureSession() {
    if (g('sessionAuthorized') && $('masterScaleToggle') && $('masterScaleToggle').checked) return
    say('ยืนยันตัวตน ' + USER.username + '…')
    await focusEl($('masterScaleToggle'))
    $('sessUsername').value = USER.username
    $('sessPassword').value = USER.password
    window.submitSessionAuth()
    await sleep(500)
    if (!g('sessionAuthorized')) throw new Error('ยืนยันตัวตนไม่ผ่าน (' + USER.username + ')')
  }

  async function ensureScale() {
    if (!g('scaleConnected')) await press('scaleConnectBtn', function () { window.connectScale() })
    await press(null, function () { window.setWeighingMode('manual') })
  }

  async function weighOne(kind, i, n) {
    var code = pick(CODES[kind] || CODES['รับ'])
    say('รายการ ' + (i + 1) + '/' + n + ': เลือก ' + code + '…')
    if ($('categoryFilter')) await choose('categoryFilter', 'Raw Material')
    await choose('itemSelect', code)
    if ($('itemCode').value !== code) throw new Error('เลือกสินค้า ' + code + ' ไม่ได้')
    var lot = lotOf(code)
    await type('batchNo', lot)
    if ($('bbfExp')) await type('bbfExp', bbfOf(code))
    if ($('supplierLot')) await type('supplierLot', 'SPL-' + pad(Math.floor(Math.random() * 9999), 4))
    if ($('externalBarcode')) await type('externalBarcode', code) // บาร์โค้ด = รหัสสินค้า → "ตรงกับรหัส"
    // หักภาชนะ (ตะกร้าเปล่า 0 kg) → วางของ
    var slider = $('weightSlider')
    slider.value = 0
    window.updateWeight(0)
    await press('tareBtn', function () { window.doTare() })
    var w = (Math.round((12 + Math.random() * 14) * 2) / 2).toFixed(1)
    say('รายการ ' + (i + 1) + '/' + n + ': วาง ' + w + ' kg…')
    await focusEl(slider)
    for (var v = 0; v <= Number(w); v += Math.max(0.5, Number(w) / 8)) { slider.value = v; window.updateWeight(v); await sleep(60) }
    slider.value = w
    window.updateWeight(w)
    await sleep(500)
    var before = (g('currentTripBasket') || []).length
    await press('manualCaptureBtn', function () { window.captureWeight('manual') })
    for (var t = 0; t < 20 && (g('currentTripBasket') || []).length === before; t++) await sleep(150)
    if ((g('currentTripBasket') || []).length === before) throw new Error('ชั่งแล้วไม่เข้าตะกร้า')
    slider.value = 0
    window.updateWeight(0)
  }

  async function saveTrip() {
    say('บันทึกเที่ยวรถ → WH13…')
    var tb = $('tripBasketTableBody')
    if (tb) await focusEl(tb.closest('.card') || tb)
    window.saveEntireTrip()
    await sleep(1200)
    // ปิดหน้าต่างตัวอย่างฉลากที่เด้งหลังบันทึก
    document.querySelectorAll('.modal.show').forEach(function (m) {
      try { window.bootstrap.Modal.getInstance(m).hide() } catch (e) {}
    })
  }

  async function run(opts) {
    if (running) return
    running = true
    stopReq = false
    setBusy(true)
    var rid = $('reportId') && $('reportId').value
    try {
      await fillTrip(opts.kind)
      await ensureSession()
      await ensureScale()
      for (var i = 0; i < opts.n; i++) await weighOne(opts.kind, i, opts.n)
      if (opts.save) {
        rid = $('reportId').value
        await saveTrip()
        say('✅ บันทึก ' + rid + ' แล้ว — WH13 ได้รับใน Auto Weighing')
      } else {
        say('✅ ชั่งเข้าตะกร้า ' + opts.n + ' รายการ — ตรวจแล้วกด "บันทึก" เอง')
      }
    } catch (e) {
      say('⚠ ' + e.message)
    } finally {
      running = false
      setBusy(false)
    }
  }

  // ---------- UI ----------
  function setBusy(b) {
    ;['whrm-bot-go', 'whrm-bot-fill'].forEach(function (id) { var el = $(id); if (el) el.disabled = b })
    var st = $('whrm-bot-stop')
    if (st) st.style.display = b ? '' : 'none'
  }

  function mount() {
    if ($('whrm-bot')) return
    var box = document.createElement('div')
    box.id = 'whrm-bot'
    box.innerHTML =
      '<style>' +
      '#whrm-bot{position:fixed;left:14px;bottom:14px;z-index:99990;font:13px/1.4 "Noto Sans Thai",system-ui,sans-serif}' +
      '#whrm-bot .fab{width:46px;height:46px;border-radius:50%;border:0;background:#f59e0b;color:#fff;font-size:22px;box-shadow:0 6px 18px #0003;cursor:pointer}' +
      '#whrm-bot .pnl{display:none;position:absolute;left:0;bottom:56px;width:270px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:12px;box-shadow:0 10px 30px #0002}' +
      '#whrm-bot.open .pnl{display:block}' +
      '#whrm-bot .pnl b{display:block;margin-bottom:6px}' +
      '#whrm-bot .brow{display:flex;gap:6px;align-items:center;margin:6px 0}' +
      '#whrm-bot select,#whrm-bot input{border:1px solid #d1d5db;border-radius:8px;padding:4px 6px;font:inherit}' +
      '#whrm-bot button.b{flex:1;border:0;border-radius:9px;padding:7px 8px;font:inherit;font-weight:600;cursor:pointer;color:#fff;background:#16a34a}' +
      '#whrm-bot button.b.alt{background:#2563eb}#whrm-bot button.b.stop{background:#dc2626}' +
      '#whrm-bot button:disabled{opacity:.5;cursor:not-allowed}' +
      '#whrm-bot-status{margin-top:6px;color:#4b5563;font-size:12px;min-height:16px}' +
      '#whrm-bot small{color:#9ca3af}' +
      '</style>' +
      '<div class="pnl">' +
      '<b>🤖 Demo Bot · ชั่งแทนคน</b>' +
      '<div class="brow">ประเภท <select id="whrm-bot-kind"><option value="รับ">รับ (Receive)</option><option value="PRP">PRP</option></select>' +
      ' จำนวน <input id="whrm-bot-n" type="number" min="1" max="10" value="3" style="width:52px"></div>' +
      '<div class="brow"><button class="b" id="whrm-bot-go">ชั่ง + บันทึก</button><button class="b alt" id="whrm-bot-fill">ชั่งเข้าตะกร้า</button></div>' +
      '<div class="brow"><button class="b stop" id="whrm-bot-stop" style="display:none">หยุด</button></div>' +
      '<div id="whrm-bot-status">พร้อม</div>' +
      '<small>ใช้ ' + USER.username + ' · Simulator · demo เท่านั้น</small>' +
      '</div>' +
      '<button class="fab" title="Demo Bot">🤖</button>'
    document.body.appendChild(box)
    box.querySelector('.fab').onclick = function () { box.classList.toggle('open') }
    var opts = function (save) { return { kind: $('whrm-bot-kind').value, n: Math.min(10, Math.max(1, parseInt($('whrm-bot-n').value, 10) || 3)), save: save } }
    $('whrm-bot-go').onclick = function () { run(opts(true)) }
    $('whrm-bot-fill').onclick = function () { run(opts(false)) }
    $('whrm-bot-stop').onclick = function () { stopReq = true; say('กำลังหยุด…') }
  }

  function boot(n) {
    if (typeof window.saveEntireTrip === 'function' && $('itemSelect') && document.body) return mount()
    if (n < 60) setTimeout(function () { boot(n + 1) }, 500)
  }
  if (document.readyState === 'complete') boot(0)
  else window.addEventListener('load', function () { setTimeout(function () { boot(0) }, 800) })
  window.__whrmDemoBotRun = run
})()
