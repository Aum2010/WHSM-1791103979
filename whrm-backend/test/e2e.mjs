// E2E: V4 + WH13 ผ่าน WH-RM server — แต่ละ browser context = เครื่องคนละเครื่อง (localStorage แยกกัน)
// รัน: docker compose up -d (backend :3000 + frontend :8080) แล้ว npm run test:e2e  (ข้อมูลทดสอบจะถูกเขียนลง DB จริง)
import puppeteer from 'puppeteer-core'

// FRONT = whrm-frontend (หน้าเว็บ) · API = whrm-backend
const FRONT = process.env.FRONT || 'http://localhost:8080'
const API = process.env.API || 'http://localhost:3000'
// browser: BROWSER_PATH หรือ Edge/Chrome ที่ติดตั้งใน Windows
const EDGE = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const results = []
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// บัญชีที่ใช้ทดสอบ (ผู้ดูแลคนแรกจาก docker-compose)
const ADMIN_USER = process.env.E2E_USER || 'admin'
const ADMIN_PASS = process.env.E2E_PASS || 'admin1234'
let TOKEN = null
const api = async (p, opt = {}) => (await fetch(API + '/api/v1' + p, { ...opt, headers: { ...(opt.headers || {}), ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) } })).json()
const login = async (username, password) => fetch(API + '/api/v1/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, returnToken: true }) })

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run'] })
const errors = {}

async function open(ctx, file, tag) {
  const page = await ctx.newPage()
  errors[tag] = []
  page.on('pageerror', (e) => errors[tag].push(String(e.message).split('\n')[0]))
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto(`${FRONT}/${file}`, { waitUntil: 'load', timeout: 60000 })
  // ยังไม่ login (context ใหม่) → bridge พามาหน้า login → login แล้วระบบพากลับหน้าเดิมเอง
  if (page.url().includes('/login.html')) {
    await page.waitForSelector('#u')
    await page.type('#u', ADMIN_USER); await page.type('#p', ADMIN_PASS)
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#btn')])
  }
  await sleep(2500) // ให้ patch ต่าง ๆ ของแอป boot เสร็จ
  return page
}
const waitOnline = (page) => page.waitForFunction(() => window.__whrmBridge && window.__whrmBridge.state().online, { timeout: 15000 })

try {
  // ── 0. Login / สิทธิ์ ──
  const noAuth = await fetch(API + '/api/v1/status')
  ok('Auth: เรียก API โดยไม่ login → 401', noAuth.status === 401)
  ok('Auth: /health เปิดสาธารณะ (health check)', (await fetch(API + '/api/v1/health')).status === 200)
  ok('Auth: รหัสผิด → 401', (await login(ADMIN_USER, 'wrong-password')).status === 401)
  const lr = await login(ADMIN_USER, ADMIN_PASS)
  const loginBody = await lr.json()
  TOKEN = loginBody.token
  ok('Auth: login ผู้ดูแลสำเร็จ + cookie HttpOnly', lr.status === 200 && /HttpOnly/i.test(lr.headers.get('set-cookie') || ''), loginBody.user && loginBody.user.role)
  const wsDenied = await new Promise((resolve) => {
    const ws = new WebSocket(API.replace(/^http/, 'ws') + '/bus')
    ws.onclose = (e) => resolve(e.code)
    setTimeout(() => resolve('timeout'), 5000)
  })
  ok('Auth: WebSocket /bus โดยไม่ login → ปิด 4401', wsDenied === 4401, String(wsDenied))
  const opName = 'e2e_op_' + Date.now()
  await api('/auth/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: opName, role: 'WEIGH_OPERATOR', password: 'op-pass-123' }) })
  const opTok = (await (await login(opName, 'op-pass-123')).json()).token
  const opUsers = await fetch(API + '/api/v1/auth/users', { headers: { authorization: 'Bearer ' + opTok } })
  ok('Auth: พนักงานชั่งเปิดหน้าจัดการผู้ใช้ไม่ได้ (403)', opUsers.status === 403)
  {
    const ctxA = await browser.createBrowserContext(); const pa = await ctxA.newPage()
    pa.on('dialog', (d) => d.accept().catch(() => {}))   // alert ค้าง (เช่น งานยกเลิก RU ที่ server ส่งให้ V4) ทำให้หน้าไม่ตอบ
    await pa.goto(`${FRONT}/V4.html`, { waitUntil: 'load', timeout: 60000 })
    ok('Auth: เปิด V4 โดยไม่ login → ไปหน้า login', pa.url().includes('/login.html?next=%2FV4.html'), pa.url())
    await pa.type('#u', ADMIN_USER); await pa.type('#p', ADMIN_PASS)
    await Promise.all([pa.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), pa.click('#btn')])
    ok('Auth: login แล้วกลับไป V4 เอง', pa.url().endsWith('/V4.html'), pa.url())
    await sleep(3000)
    const who = await pa.evaluate(() => document.getElementById('whrm-bridge-pill') && document.getElementById('whrm-bridge-pill').textContent)
    ok('Auth: ป้ายสถานะแสดงชื่อผู้ใช้', (who || '').includes(ADMIN_USER), who)
    const cross = await pa.evaluate(() => window.__whrmBridge.apiBase !== location.origin)
    if (cross) {
      const tk = await pa.evaluate(() => localStorage.getItem('__whrm_auth_token'))
      ok('Cross-origin: ใช้ Bearer token (frontend กับ backend คนละโดเมน)', !!tk && (who || '').includes(ADMIN_USER), tk ? 'token ' + tk.length + ' chars' : 'no token')
    }
    await Promise.all([pa.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), pa.evaluate(() => window.__whrmBridge.logout())])
    await pa.goto(`${FRONT}/WH13.html`, { waitUntil: 'load', timeout: 60000 })
    ok('Auth: logout แล้วเปิดหน้าอื่น → กลับไปหน้า login', pa.url().includes('/login.html'), pa.url())
    await ctxA.close()
  }

  // ── baseline: error ของไฟล์เดิม (ไม่มี bridge) ──
  const ctxRaw = await browser.createBrowserContext()
  for (const f of ['V4.html', 'WH13.html']) {
    const p = await ctxRaw.newPage(); const errs = []
    p.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]))
    p.on('dialog', (d) => d.accept().catch(() => {}))
    await p.goto(`${FRONT}/raw/${f}`, { waitUntil: 'load', timeout: 60000 }); await sleep(2500)
    errors['raw-' + f] = errs
  }
  await ctxRaw.close()

  const ctxV4 = await browser.createBrowserContext()
  const ctxWH = await browser.createBrowserContext()
  const ctxWH2 = await browser.createBrowserContext()

  let v4 = await open(ctxV4, 'V4.html', 'V4')
  const wh = await open(ctxWH, 'WH13.html', 'WH13-A')
  const wh2 = await open(ctxWH2, 'WH13.html', 'WH13-B')
  await Promise.all([waitOnline(v4), waitOnline(wh), waitOnline(wh2)])
  ok('bridge online ทั้ง 3 เครื่อง', true)

  // ── 1. V4 ตั้งค่า apiCall → live ──
  const cfg = await v4.evaluate(() => ({ mode: CONFIG.mode, apiBase: CONFIG.apiBase }))
  const bridgeBase = await v4.evaluate(() => __whrmBridge.apiBase)
  ok('V4 Settings ชี้ไปที่ backend อัตโนมัติ (ผ่าน frontend proxy หรือตรง)', cfg.mode === 'live' && cfg.apiBase === bridgeBase + '/api/v1', JSON.stringify(cfg))
  const health = await v4.evaluate(async () => apiCall('/health', { method: 'GET' }))
  ok('V4 apiCall(/health) ได้คำตอบจริง (ไม่ใช่ mock)', health.ok === true && !health.mock)

  // ── 2. Bus: V4 TRIP_SAVED → WH13 อีกเครื่อง ──
  const RID = 'ROO' + Date.now().toString().slice(-8) + '-E2E'
  await v4.evaluate((rid) => WHBus.publish('TRIP_SAVED', {
    reportId: rid, tripNo: 'T-01', weighingType: 'รับ', vehiclePlate: '1กข-1234', vehicleType: '6 ล้อ',
    supplierTransport: 'SUP-PIG01', weighingUser: 'operator_01', time: new Date().toLocaleString('th-TH'),
    date: new Date().toISOString().slice(0, 10),
    items: [{ _id: 'bi_e2e_' + rid, code: '3A000', name: 'สันนอกหมูสด', category: 'Raw Material', customer: '-',
      batchNo: 'B-E2E', netWeight: 25.5, unit: 'kg', pcsCount: 0, captureMode: 'auto' }],
  }), RID)
  const got = await wh.waitForFunction((rid) => weighingModalRecords.some((r) => r.reportId === rid), { timeout: 10000 }, RID).then(() => true).catch(() => false)
  ok('WH13 (เครื่อง A) ได้รับ TRIP_SAVED จาก V4', got, RID)
  const got2 = await wh2.waitForFunction((rid) => weighingModalRecords.some((r) => r.reportId === rid), { timeout: 10000 }, RID).then(() => true).catch(() => false)
  ok('WH13 (เครื่อง B) ได้รับ TRIP_SAVED ด้วย', got2)
  const dup = await wh.evaluate((rid) => weighingModalRecords.filter((r) => r.reportId === rid).length, RID)
  ok('ไม่มีรายการซ้ำใน inbox', dup === 1, `count=${dup}`)
  await sleep(800)
  const rep = await api('/weighing/reports/' + RID)
  ok('รายงานชั่งถูกบันทึกลง DB', rep.report_id === RID && rep.items?.[0]?.wms_status === 'SENT', `items=${rep.items?.length} status=${rep.items?.[0]?.wms_status}`)

  // ── 3. Bus: WH13 TRIP_IMPORTED → V4 + DB ──
  await v4.evaluate(() => { window.__e2eImported = null; WHBus.on('TRIP_IMPORTED', (m) => { window.__e2eImported = m.payload.reportId }) })
  await wh.evaluate((rid) => new BroadcastChannel('whrm-bus').postMessage({ type: 'TRIP_IMPORTED', version: 1, source: 'WH13',
    timestamp: new Date().toISOString(), payload: { reportId: rid, itemCodes: ['3A000'], importedBy: 'QA-001' } }), RID)
  const imp = await v4.waitForFunction((rid) => window.__e2eImported === rid, { timeout: 10000 }, RID).then(() => true).catch(() => false)
  ok('V4 ได้รับ TRIP_IMPORTED จาก WH13', imp)
  await sleep(800)
  const rep2 = await api('/weighing/reports/' + RID)
  ok('DB อัปเดตสถานะเป็น IMPORTED', rep2.items?.[0]?.wms_status === 'IMPORTED', rep2.items?.[0]?.wms_status)

  // ── 3b. กันส่ง/รับซ้ำ: V4 ส่งใบเดิมซ้ำ → ข้าม · WH13 ไม่เพิ่มรายการที่นำเข้าแล้วกลับมา ──
  {
    const countItems = (page) => page.evaluate((rid) => { const r = weighingModalRecords.find((x) => x.reportId === rid); return r ? r.items.length : 0 }, RID)
    const before = await countItems(wh)
    const res = await v4.evaluate((rid) => WHBus.publish('TRIP_SAVED', { reportId: rid, tripNo: 'T-01', weighingType: 'รับ', _via: 'bulk-select',
      items: [{ _id: 'bi_e2e_' + rid, code: '3A000', name: 'สันนอกหมูสด', category: 'Raw Material', batchNo: 'B-E2E', netWeight: 25.5, unit: 'kg' }] }), RID)
    await sleep(2500)
    ok('ซ้ำ: V4 ส่งใบที่ส่งไปแล้วซ้ำ → ข้าม ไม่ส่ง', res && res.held && res.duplicate && (await countItems(wh)) === before, JSON.stringify(res))
    // จำลองว่านำเข้าแล้ว แล้วมีอีกเครื่องส่งใบเดิมมา (ไม่ผ่านตัวกันของ V4)
    await wh.evaluate((rid) => { const r = weighingModalRecords.find((x) => x.reportId === rid); r.items.forEach((it) => { it.imported = true }) }, RID)
    await wh2.evaluate((rid) => new BroadcastChannel('whrm-bus').postMessage({ type: 'TRIP_SAVED', version: 1, source: 'OTHER-V4', timestamp: new Date().toISOString(),
      payload: { reportId: rid, weighingType: 'รับ', items: [{ _id: 'bi_e2e_' + rid, code: '3A000', name: 'สันนอกหมูสด', category: 'Raw Material', batchNo: 'B-E2E', netWeight: 25.5, unit: 'kg' }] } }), RID)
    await sleep(2500)
    const after = await wh.evaluate((rid) => { const r = weighingModalRecords.find((x) => x.reportId === rid); return { n: r.items.length, pending: r.items.filter((it) => !it.imported).length } }, RID)
    ok('ซ้ำ: WH13 ไม่เพิ่มรายการที่นำเข้าแล้วกลับเข้า Auto Weighing', after.n === before && after.pending === 0, JSON.stringify(after))
    // รายการใหม่ในใบเดิม (ชั่งเพิ่ม) ยังเข้าได้
    await wh2.evaluate((rid) => new BroadcastChannel('whrm-bus').postMessage({ type: 'TRIP_SAVED', version: 1, source: 'OTHER-V4', timestamp: new Date().toISOString(),
      payload: { reportId: rid, weighingType: 'รับ', items: [{ _id: 'bi_e2e_' + rid, code: '3A000', batchNo: 'B-E2E', netWeight: 25.5 }, { _id: 'bi_e2e_new_' + rid, code: '3A001', name: 'มันหมูสด', category: 'Raw Material', batchNo: 'B-E2E-2', netWeight: 10, unit: 'kg' }] } }), RID)
    await sleep(2500)
    const after2 = await wh.evaluate((rid) => { const r = weighingModalRecords.find((x) => x.reportId === rid); return { n: r.items.length, pending: r.items.filter((it) => !it.imported).map((it) => it.code) } }, RID)
    ok('ซ้ำ: รายการใหม่ของใบเดิมยังเข้าได้ (เฉพาะรายการใหม่)', after2.n === before + 1 && after2.pending.join() === '3A001', JSON.stringify(after2))
  }

  // ── 4. KV sync แบบ live: กฎตรวจรับ (WH13 A → B) ──
  await wh.evaluate(() => { inspectionTypeRules['E2E-01'] = { requiredType: 'GR', reason: 'e2e test' }; saveInspectionRules() })
  const rule = await wh2.waitForFunction(() => inspectionTypeRules['E2E-01'] && inspectionTypeRules['E2E-01'].reason === 'e2e test', { timeout: 10000 }).then(() => true).catch(() => false)
  ok('กฎตรวจรับที่แก้ในเครื่อง A ขึ้นในหน่วยความจำของเครื่อง B ทันที', rule)

  // ── 5. RO store: สร้าง RO ที่ A → B เห็นในตาราง ──
  const RO = 'RO-E2E-' + Date.now()
  await wh.evaluate((roNo) => {
    roStatusStore.unshift({ id: 'ro_' + roNo, roNo, createdAt: new Date().toISOString(), createdAtDisplay: '-', destinationWh: 'WHRM',
      vendor: 'SUP-PIG01', mode: 'receive', status: 'PENDING', documents: [],
      items: [{ _id: 'roi_' + roNo, code: '3A000', name: 'สันนอกหมูสด', lot: 'B-E2E', qty: 25.5, unit: 'kg', inspectionType: 'QA', qaStatus: 'PENDING' }] })
    saveROStatusStore(); renderROStatusTable()
  }, RO)
  const ro = await wh2.waitForFunction((roNo) => roStatusStore.some((r) => r.roNo === roNo), { timeout: 10000 }, RO).then(() => true).catch(() => false)
  ok('RO ที่สร้างในเครื่อง A ขึ้นที่เครื่อง B (in-memory + render)', ro, RO)

  // ── 6. Conflict: 2 เครื่องเพิ่ม RU พร้อมกัน → ต้องอยู่ครบทั้งคู่ ──
  const ruA = 'RU-A-' + Date.now(), ruB = 'RU-B-' + Date.now()
  const addRu = (ru) => { const k = 'whrm_return_requests_v1'; const l = JSON.parse(localStorage.getItem(k) || '[]'); l.unshift({ ruNo: ru, status: 'PENDING', items: [] }); localStorage.setItem(k, JSON.stringify(l)) }
  await Promise.all([wh.evaluate(addRu, ruA), wh2.evaluate(addRu, ruB)])
  await sleep(4000)
  const readRu = () => JSON.parse(localStorage.getItem('whrm_return_requests_v1') || '[]').map((r) => r.ruNo)
  const [la, lb] = await Promise.all([wh.evaluate(readRu), wh2.evaluate(readRu)])
  const srv = JSON.parse((await api('/sync/kv/whrm_return_requests_v1')).value).map((r) => r.ruNo)
  const all = (l) => l.includes(ruA) && l.includes(ruB)
  ok('Conflict merge: เครื่อง A มี RU ทั้งสองรายการ', all(la), la.join(','))
  ok('Conflict merge: เครื่อง B มี RU ทั้งสองรายการ', all(lb), lb.join(','))
  ok('Conflict merge: server มี RU ทั้งสองรายการ', all(srv), srv.join(','))
  const conflicts = (await wh.evaluate(() => __whrmBridge.stats.conflicts)) + (await wh2.evaluate(() => __whrmBridge.stats.conflicts))
  ok('เกิด conflict จริงและถูก merge', conflicts >= 1, `conflicts=${conflicts}`)

  // ── 6b. 2 เครื่องสร้าง key ใหม่พร้อมกัน (ยังไม่มีที่ server) ──
  const NEWKEY = 'whrm_e2e_new_' + Date.now()
  const addNew = ([k, id]) => { const l = JSON.parse(localStorage.getItem(k) || '[]'); l.push({ id, by: id }); localStorage.setItem(k, JSON.stringify(l)) }
  await Promise.all([wh.evaluate(addNew, [NEWKEY, 'X1']), wh2.evaluate(addNew, [NEWKEY, 'X2'])])
  await sleep(4000)
  const srvNew = JSON.parse((await api('/sync/kv/' + NEWKEY)).value || '[]').map((x) => x.id)
  const readNew = (k) => JSON.parse(localStorage.getItem(k) || '[]').map((x) => x.id)
  const [na, nb] = await Promise.all([wh.evaluate(readNew, NEWKEY), wh2.evaluate(readNew, NEWKEY)])
  ok('สร้าง key ใหม่พร้อมกัน: server ได้ครบทั้ง 2 รายการ', srvNew.includes('X1') && srvNew.includes('X2'), srvNew.join(','))
  ok('สร้าง key ใหม่พร้อมกัน: ทั้ง 2 เครื่องตรงกัน', na.length === 2 && nb.length === 2, `${na} | ${nb}`)

  // ── 6c. PRP + BBF/EXP ผ่าน saveEntireTrip() จริงของ V4 (UI 1790951454) ──
  const hasPrp = await v4.evaluate(() => Array.from(document.querySelectorAll('#weighingType option')).some((o) => o.value === 'PRP'))
  if (hasPrp) {
    const prpId = await v4.evaluate(async () => {
      const sel = document.getElementById('weighingType'); sel.value = 'PRP'; sel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      sessionAuthorized = true; currentUser = { username: 'operator_01', role: 'operator' }
      document.getElementById('masterScaleToggle').checked = true; activateMaster(); connectScale()
      const it = document.getElementById('itemSelect'); it.value = '3A000'; it.dispatchEvent(new Event('change', { bubbles: true }))
      document.getElementById('batchNo').value = 'L-PRP-E2E'
      const bbf = document.getElementById('bbfExp'); bbf.value = '31/12/2569'; bbf.dispatchEvent(new Event('input', { bubbles: true }))
      setWeighingMode('manual'); doZero()
      const s = document.getElementById('weightSlider'); s.value = 12.5; s.dispatchEvent(new Event('input', { bubbles: true })); updateWeight(12.5)
      captureWeight('manual-button')
      await new Promise((r) => setTimeout(r, 800))
      const id = document.getElementById('reportId').value
      basketSelection.clear(); saveEntireTrip()
      return id
    })
    await sleep(2500)
    // ลูกค้ายืนยัน (18 ต.ค.): กดบันทึกยังไม่ส่ง WH13 — ต้องกด "นำส่ง WMS" ก่อน
    const early = await wh.evaluate((id) => weighingModalRecords.some((x) => x.reportId === id), prpId)
    ok('V4 กดบันทึก → WH13 ยังไม่เห็น (รอนำส่ง WMS)', !early, prpId)
    const clicked = await v4.evaluate((id) => {
      const b = document.querySelector(`.wms-status-cell[data-report-id="${id}"] .wms-send-btn`)
      if (b) b.click()
      return !!b
    }, prpId)
    await wh.waitForFunction((id) => weighingModalRecords.some((x) => x.reportId === id), { timeout: 10000 }, prpId).catch(() => {})
    const late = await wh.evaluate((id) => weighingModalRecords.some((x) => x.reportId === id), prpId)
    ok('V4 กด "นำส่ง WMS" → WH13 ได้รับ', clicked && late, `button=${clicked}`)
    const prpWh = await wh.evaluate((id) => {
      const r = weighingModalRecords.find((x) => x.reportId === id)
      return r && r.items[0] ? { prp: r.items[0]._isPRP, insp: r.items[0].inspectionType, locked: r.items[0].inspectionLocked, dest: r.items[0]._destWh } : null
    }, prpId)
    ok('PRP: WH13 รับเป็น GR ล็อก ปลายทาง WHSM07', prpWh && prpWh.prp && prpWh.insp === 'GR' && prpWh.locked && prpWh.dest === 'WHSM07', JSON.stringify(prpWh))
    const prpRep = await api('/weighing/reports/' + prpId)
    const pi = prpRep.items?.[0] || {}
    ok('PRP: DB เก็บ weighing_type=PRP และ prp_status=PENDING', prpRep.weighing_type === 'PRP' && pi.prp_status === 'PENDING', `${prpRep.weighing_type} / ${pi.prp_status}`)
    ok('BBF/EXP: "31/12/2569" (พ.ศ.) → 2026-12-31', pi.bbf_exp_text === '31/12/2569' && pi.bbf_exp === '2026-12-31', `${pi.bbf_exp_text} → ${pi.bbf_exp}`)
  } else {
    console.log('SKIP  PRP/BBF (UI เวอร์ชันนี้ไม่มี PRP)')
  }

  // ── 6d. ยกเลิก RU: WH13 เขียน audit RMA_CANCELLED → server ส่ง RMA_CANCEL_RU → V4 ตอบ DONE → WH13 บันทึก ──
  const hasCancel = await v4.evaluate(() => !!window.__v4CancelListenerV2)
  if (hasCancel) {
    // ทำแบบเดียวกับ logAudit() ใน rmaCancelSession() ของ WH13
    const cancelRu = (ru) => {
      const k = 'whrm_rma_audit_v1'; const l = JSON.parse(localStorage.getItem(k) || '[]')
      l.push({ at: new Date().toISOString(), action: 'RMA_CANCELLED', ruNo: ru, by: 'QA-001' })
      localStorage.setItem(k, JSON.stringify(l))
    }
    const RU1 = 'RU-CXL-' + Date.now()
    await wh.evaluate(cancelRu, RU1)
    const bl = await v4.waitForFunction((ru) => JSON.parse(localStorage.getItem('whrm_v4_cancel_blacklist_v1') || '[]').includes(ru), { timeout: 10000 }, RU1).then(() => true).catch(() => false)
    ok('ยกเลิก RU: V4 ได้รับและ blacklist RU', bl, RU1)
    await sleep(2500)
    const c1 = (await api('/ru-cancels')).find((r) => r.ru_no === RU1)
    ok('ยกเลิก RU: server ได้ DONE จาก V4', !!(c1 && c1.done_at), c1 ? `sent=${c1.send_count} done=${!!c1.done_at}` : 'no row')
    const doneLog = await wh2.waitForFunction((ru) => JSON.parse(localStorage.getItem('whrm_v4_cancel_done_log_v1') || '[]').some((x) => x.ruNo === ru), { timeout: 10000 }, RU1).then(() => true).catch(() => false)
    ok('ยกเลิก RU: WH13 บันทึกว่า V4 ล้างแล้ว', doneLog)
    await v4.waitForFunction(() => window.__whrmBridge && __whrmBridge.state().online, { timeout: 15000 }).catch(() => {})

    // V4 ปิดอยู่ตอนยกเลิก → เปิดทีหลังต้องได้รับ
    await v4.close()
    const RU2 = 'RU-CXL-OFF-' + Date.now()
    await wh.evaluate(cancelRu, RU2)
    await sleep(2000)
    const pend = (await api('/ru-cancels')).find((r) => r.ru_no === RU2)
    ok('ยกเลิก RU ตอน V4 ปิด: server จดไว้รอส่ง', !!(pend && !pend.done_at))
    v4 = await open(ctxV4, 'V4.html', 'V4')
    await waitOnline(v4)
    const bl2 = await v4.waitForFunction((ru) => JSON.parse(localStorage.getItem('whrm_v4_cancel_blacklist_v1') || '[]').includes(ru), { timeout: 15000 }, RU2).then(() => true).catch(() => false)
    await sleep(2500)
    const c2 = (await api('/ru-cancels')).find((r) => r.ru_no === RU2)
    ok('ยกเลิก RU ตอน V4 ปิด: เปิด V4 แล้วได้รับ + ตอบ DONE', bl2 && !!(c2 && c2.done_at), c2 ? `sent=${c2.send_count}` : 'no row')
    await v4.waitForFunction(() => window.__whrmBridge && __whrmBridge.state().online, { timeout: 15000 }).catch(() => {})

    // ประวัติยกเลิกเก่า (sync ครั้งแรก) ต้องไม่ถูกส่ง
    const RU3 = 'RU-CXL-OLD-' + Date.now()
    await wh.evaluate((ru) => {
      const k = 'whrm_rma_audit_v1'; const l = JSON.parse(localStorage.getItem(k) || '[]')
      l.push({ at: new Date(Date.now() - 3 * 3600e3).toISOString(), action: 'RMA_CANCELLED', ruNo: ru, by: 'QA-001' })
      localStorage.setItem(k, JSON.stringify(l))
    }, RU3)
    await sleep(2000)
    ok('ประวัติยกเลิกเก่ากว่า 1 ชม. ไม่ถูกส่งซ้ำ', !(await api('/ru-cancels')).some((r) => r.ru_no === RU3))
  } else {
    console.log('SKIP  ยกเลิก RU (UI เวอร์ชันนี้ไม่มี cancel listener)')
  }

  // ── 7. เครื่องใหม่ (ไม่เคยเปิด) เห็นข้อมูลทั้งหมด ──
  const ctxNew = await browser.createBrowserContext()
  const whNew = await open(ctxNew, 'WH13.html', 'WH13-new')
  const fresh = await whNew.evaluate((rid, roNo) => ({
    inbox: weighingModalRecords.some((r) => r.reportId === rid),
    ro: roStatusStore.some((r) => r.roNo === roNo),
    rule: !!inspectionTypeRules['E2E-01'],
  }), RID, RO)
  ok('เครื่องใหม่ได้ inbox / RO / กฎ จาก server', fresh.inbox && fresh.ro && fresh.rule, JSON.stringify(fresh))

  // ── 8. Write storm: ปล่อยว่าง 10 วินาที ต้องไม่ส่งซ้ำวน ──
  const before = await wh.evaluate(() => __whrmBridge.stats.pushed)
  await sleep(10000)
  const after = await wh.evaluate(() => __whrmBridge.stats.pushed)
  ok('ไม่มี write storm ตอน idle (WH13 timers)', after - before <= 2, `pushes in 10s = ${after - before}`)

  // ── 9. Purge บน V4 ต้องไม่ลบข้อมูลกลาง ──
  const keysBefore = (await api('/sync/keys')).filter((k) => !k.deleted).length
  await v4.evaluate(() => { Object.keys(localStorage).filter((k) => k.startsWith('whrm_')).forEach((k) => localStorage.removeItem(k)) })
  await sleep(4000)
  const keysAfter = (await api('/sync/keys')).filter((k) => !k.deleted).length
  ok('Purge บน V4 ไม่ลบข้อมูลที่ server', keysAfter >= keysBefore, `${keysBefore} → ${keysAfter}`)
  await v4.waitForFunction(() => window.__whrmBridge && __whrmBridge.state().online, { timeout: 15000 }).catch(() => {})
  const restored = await v4.evaluate(() => localStorage.getItem('whrm_inspection_rules_v1') !== null)
  ok('V4 โหลดใหม่และดึงข้อมูลกลางกลับมา', restored)

  // ── 11. ชุด UI 14–16 ต.ค. 2026: FGT/FGA, BD02, ฝ่ายผลิต ──
  // 11a. เลขลำดับชนกัน → ใช้ค่ามากสุด (เดิมยึดค่าเครื่องตัวเอง → เลขถอยหลัง)
  const seqKey = 'whrm_fgt_seq_E2E' + Date.now()
  await wh.evaluate((k) => localStorage.setItem(k, '2'), seqKey)
  await wh2.waitForFunction((k) => localStorage.getItem(k) === '2', { timeout: 15000 }, seqKey).catch(() => {})
  await Promise.all([wh.evaluate((k) => localStorage.setItem(k, '3'), seqKey), wh2.evaluate((k) => localStorage.setItem(k, '5'), seqKey)])
  await sleep(5000)
  const seqA = await wh.evaluate((k) => localStorage.getItem(k), seqKey)
  const seqB = await wh2.evaluate((k) => localStorage.getItem(k), seqKey)
  const seqS = (await api('/sync/kv/' + seqKey)).value
  ok('เลขลำดับ FGT ชนกัน 2 เครื่อง → ทุกที่ใช้ค่ามากสุด', seqA === '5' && seqB === '5' && seqS === '5', `A=${seqA} B=${seqB} server=${seqS}`)

  // 11b. คิว FGT: 2 เครื่องอนุมัติ/ปฏิเสธคนละใบพร้อมกัน → ไม่มีใบซ้ำ ผลอยู่ครบ (merge ตาม fgtNo)
  const fgtNo = (n) => `FGT${Date.now() % 100000}E2E-000${n}`
  const q0 = [1, 2].map((n) => ({ fgtNo: fgtNo(n), srcWh: 'WHA', destWh: 'WHC', status: 'PENDING', items: [{ code: 'E2E', qty: n }] }))
  await wh.evaluate((v) => localStorage.setItem('whrm_fgt_queue_v1', JSON.stringify(v)), q0)
  await wh2.waitForFunction((n) => (JSON.parse(localStorage.getItem('whrm_fgt_queue_v1') || '[]')[0] || {}).fgtNo === n, { timeout: 15000 }, q0[0].fgtNo).catch(() => {})
  await Promise.all([
    wh.evaluate((st) => { const q = JSON.parse(localStorage.getItem('whrm_fgt_queue_v1')); q[0].status = st; localStorage.setItem('whrm_fgt_queue_v1', JSON.stringify(q)) }, 'APPROVED'),
    wh2.evaluate((st) => { const q = JSON.parse(localStorage.getItem('whrm_fgt_queue_v1')); q[1].status = st; localStorage.setItem('whrm_fgt_queue_v1', JSON.stringify(q)) }, 'REJECTED'),
  ])
  await sleep(6000)
  const fgt = await api('/fgt')
  const st = Object.fromEntries((fgt.items || []).map((x) => [x.fgtNo, x.status]))
  ok('คิว FGT แก้พร้อมกัน 2 เครื่อง → ไม่ซ้ำ ผลครบ (API /fgt)', fgt.total === 2 && fgt.duplicates.length === 0 && st[q0[0].fgtNo] === 'APPROVED' && st[q0[1].fgtNo] === 'REJECTED', JSON.stringify(fgt.byStatus))
  const qB = await wh2.evaluate(() => JSON.parse(localStorage.getItem('whrm_fgt_queue_v1')).map((x) => x.status).join(','))
  ok('เครื่อง B เห็นผลอนุมัติของเครื่อง A', qB === 'APPROVED,REJECTED', qB)

  // 11c. ค่า dev / ร่างเอกสาร อยู่เฉพาะเครื่อง
  await wh.evaluate(() => { localStorage.setItem('whrm_rma_dev_ai_config_v1', '{"rules":{"forcePassCodes":["E2E"]}}'); localStorage.setItem('whrm_fgt_docs_draft_v1', '[{"name":"e2e.pdf"}]') })
  await sleep(3000)
  const devKv = await fetch(API + '/api/v1/sync/kv/whrm_rma_dev_ai_config_v1', { headers: { authorization: 'Bearer ' + TOKEN } })
  const draftKv = await fetch(API + '/api/v1/sync/kv/whrm_fgt_docs_draft_v1', { headers: { authorization: 'Bearer ' + TOKEN } })
  const devB = await wh2.evaluate(() => localStorage.getItem('whrm_rma_dev_ai_config_v1'))
  ok('Dev AI config / ร่างเอกสาร ไม่ขึ้น server ไม่ไปเครื่องอื่น', devKv.status === 404 && draftKv.status === 404 && devB === null, `dev=${devKv.status} draft=${draftKv.status}`)

  // 11d. หน้าใหม่: BD02 + ฝ่ายผลิต (โฟลเดอร์ย่อย) เปิดผ่าน bridge ได้ ไม่มี error ใหม่
  const pagesJson = await (await fetch(FRONT + '/pages.json')).json().catch(() => [])
  const qr = await fetch(FRONT + '/qrcode.min.js')
  ok('build: pages.json ครบ + ไฟล์ .js ของ WH13 ถูก copy', pagesJson.length >= 10 && qr.status === 200, pagesJson.map((p) => p.path).join(', '))
  const ctxPg = await browser.createBrowserContext(); const ctxRawPg = await browser.createBrowserContext()
  for (const [file, app] of [['BD02.html', 'BD02'], ['Production-module/Preparing.html', 'PRODUCTION'], ['Production-module/Processing-and-packing12.html', 'PRODUCTION'], ['Production-module/production-stockcard.html', 'PRODUCTION'],
    ['DBV2.0.html', 'DBV2'], ['QA_Deviation_06.html', 'QA-DEV'], ['QAincoming03.html', 'QA-IN'], ['Production-planning301.html', 'PLANNING']]) {
    const rawPg = await ctxRawPg.newPage(); const rawErr = []
    rawPg.on('pageerror', (e) => rawErr.push(String(e.message).split('\n')[0])); rawPg.on('dialog', (d) => d.accept().catch(() => {}))
    await rawPg.goto(`${FRONT}/raw/${file}`, { waitUntil: 'load', timeout: 60000 }); await sleep(2000); await rawPg.close()
    const pg = await open(ctxPg, file, file)
    await waitOnline(pg).catch(() => {})
    const s = await pg.evaluate(() => ({ app: __whrmBridge.app, online: __whrmBridge.state().online, pill: !!document.getElementById('whrm-bridge-pill') }))
    const extraErr = errors[file].filter((e) => !rawErr.includes(e))
    ok(`หน้าใหม่ ${file}: bridge online + ไม่มี error ใหม่`, s.app === app && s.online && s.pill && extraErr.length === 0, extraErr.slice(0, 2).join(' | ') || `app=${s.app}`)
    await pg.close()
  }
  await ctxPg.close(); await ctxRawPg.close()

  // ── 12. ชุด UI 22 ต.ค. 2026: master สินค้ากลาง (DBV2.0) + QA ──
  // 12a. เปิด DBV2.0 ที่เครื่องหนึ่ง → master 400+ รายการขึ้น server → WH13 เครื่องที่ไม่เคยเปิด DBV2.0 ได้ครบ
  const ctxDb = await browser.createBrowserContext()
  const db = await open(ctxDb, 'DBV2.0.html', 'DBV2')
  await waitOnline(db).catch(() => {})
  await sleep(4000)
  const srvMaster = await api('/sync/kv/pmp_master_v66')
  const srvCount = (() => { try { return JSON.parse(srvMaster.value).length } catch { return 0 } })()
  ok('Master: DBV2.0 ส่ง master สินค้าขึ้น server', srvCount > 400, `items=${srvCount}`)
  const ctxFresh = await browser.createBrowserContext()
  const whFresh = await open(ctxFresh, 'WH13.html', 'WH13-fresh')
  await sleep(3000)
  const freshCache = await whFresh.evaluate(() => { const c = window.__wh13MasterCache; return c ? (Array.isArray(c) ? c.length : Object.keys(c).length) : 0 })
  ok('Master: WH13 เครื่องใหม่ (ไม่เคยเปิด DBV2.0) ได้สินค้าครบ', freshCache > 400, `WH13 master=${freshCache} (เดิมได้ 13)`)
  // 12b. แก้ชื่อสินค้าที่ DBV2.0 → เครื่อง WH13 อื่นเห็น
  const newName = 'สันนอกหมูสด E2E ' + Date.now() % 10000
  await db.evaluate((n) => { const m = JSON.parse(localStorage.getItem('pmp_master_v66')); const it = m.find((x) => x.c === '3A000'); it.n = n; localStorage.setItem('pmp_master_v66', JSON.stringify(m)) }, newName)
  const nameSeen = await whFresh.waitForFunction((n) => (localStorage.getItem('pmp_master_v66') || '').includes(n), { timeout: 15000 }, newName).then(() => true).catch(() => false)
  ok('Master: แก้ชื่อสินค้าที่ DBV2.0 → WH13 อีกเครื่องได้รับ', nameSeen, newName)
  // 12c. Hard Reset ที่เครื่องเดียว (ลบ 5 key) ต้องไม่ล้าง master กลาง
  await db.evaluate(() => { ['pmp_master_v66', 'pmp_main_categories_v66', 'pmp_categories_v66', 'pmp_audit_v66', 'pmp_mapping_v66'].forEach((k) => localStorage.removeItem(k)) })
  await sleep(4000)
  const afterReset = await api('/sync/kv/pmp_master_v66')
  ok('Master: Hard Reset ที่เครื่องเดียวไม่ล้าง master ของทุกเครื่อง', afterReset.value && afterReset.value.includes(newName))
  // 12d. QA Deviation ↔ WH13: channel whrm-qa-deviation-v1 ข้ามเครื่อง
  const qa = await open(ctxDb, 'QA_Deviation_06.html', 'QA-DEV')
  await waitOnline(qa).catch(() => {})
  await whFresh.evaluate(() => { window.__e2eQa = null; const c = new BroadcastChannel('whrm-qa-deviation-v1'); c.onmessage = (e) => { if (e.data && e.data.e2e) window.__e2eQa = e.data.e2e } })
  const tag = 'QA-' + Date.now()
  await qa.evaluate((t) => new BroadcastChannel('whrm-qa-deviation-v1').postMessage({ type: 'E2E_PING', e2e: t }), tag)
  const qaGot = await whFresh.waitForFunction((t) => window.__e2eQa === t, { timeout: 10000 }, tag).then(() => true).catch(() => false)
  ok('QA Deviation → WH13 อีกเครื่อง (channel whrm-qa-deviation-v1)', qaGot)
  await ctxDb.close(); await ctxFresh.close()

  // ── 13. จัดการผู้ใช้รายส่วน (CRUD · template · บังคับเปลี่ยนรหัส · import/export) ──
  {
    const J = (method, body) => (body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const raw = async (p, opt = {}, tok = TOKEN) => { const r = await fetch(API + '/api/v1' + p, { ...opt, headers: { ...(opt.headers || {}), authorization: 'Bearer ' + tok } }); return { s: r.status, j: await r.json().catch(() => null) } }
    const sfx = String(Date.now() % 100000)
    const un = 'e2e_qa_' + sfx
    const legacy = await raw('/users/Tom')
    ok('Users: บัญชีเดิม (Tom) ย้ายเข้า DB แบบปิด ไม่มีรหัส + alias WH13', legacy.s === 200 && legacy.j.status === 'inactive' && !legacy.j.has_password && legacy.j.access.WH13?.alias === 'Tom', JSON.stringify(legacy.j?.access?.WH13))
    const c = await raw('/users', J('POST', { username: un, fullName: 'E2E QA', dept: 'QA', cardId: 'E2E-' + sfx, template: 'QA', password: 'start123' }))
    ok('Users: สร้างจาก template QA → WH13 อนุมัติ (QA-001)', c.s === 201 && c.j.access.WH13?.level === 'APPROVE' && c.j.access.WH13?.alias === 'QA-001' && c.j.must_change_password, `${c.s} ${JSON.stringify(c.j?.access?.WH13)}`)
    ok('Users: รหัสบัตรซ้ำ → 409', (await raw('/users', J('POST', { username: un + 'x', cardId: 'E2E-' + sfx, password: 'start123' }))).s === 409)
    const lg = await (await login(un, 'start123')).json()
    ok('Users: ผู้ใช้ใหม่ต้องตั้งรหัสก่อน (API อื่น 403)', lg.user?.mustChangePassword && (await raw('/status', {}, lg.token)).s === 403)
    await raw('/auth/password', J('POST', { currentPassword: 'start123', newPassword: 'mine1234' }), lg.token)
    ok('Users: ตั้งรหัสใหม่แล้วใช้งานได้', (await raw('/status', {}, lg.token)).s === 200)
    ok('Users: ไม่ใช่ผู้ดูแล → /users 403', (await raw('/users', {}, lg.token)).s === 403)
    const me = await raw('/auth/me', {}, lg.token)
    ok('Users: /auth/me บอกสิทธิ์รายส่วน', me.j?.access?.QA?.level === 'APPROVE', JSON.stringify(me.j?.access))
    const ac = await raw(`/users/${un}/access`, J('PUT', { BD02: 'VIEW', V4: 'NONE' }))
    ok('Users: แก้สิทธิ์ช่องเดียว (BD02=ดู, V4=ไม่มี)', ac.s === 200 && ac.j.access.BD02?.level === 'VIEW' && !ac.j.access.V4)
    const del1 = await raw(`/users/${un}`, J('DELETE', { confirm: un }))
    ok('Users: ลบคนที่เคยใช้งาน → 409 (ให้ปิดบัญชีแทน)', del1.s === 409 && del1.j.error === 'HAS_ACTIVITY')
    await raw(`/users/${un}`, J('PUT', { status: 'inactive' }))
    ok('Users: ปิดบัญชี → session เดิมหลุดทันที', (await raw('/auth/me', {}, lg.token)).s === 401)
    const tmp = 'e2e_tmp_' + sfx
    await raw('/users', J('POST', { username: tmp, template: 'พนักงานชั่ง' }))
    ok('Users: ลบบัญชีที่ไม่เคยใช้ (ต้องยืนยันชื่อ)', (await raw(`/users/${tmp}`, J('DELETE', {}))).s === 400 && (await raw(`/users/${tmp}`, J('DELETE', { confirm: tmp }))).s === 200)
    ok('Users: ลดสิทธิ์ผู้ดูแลตัวเองไม่ได้', (await raw(`/users/${ADMIN_USER}`, J('PUT', { role: 'QA' }))).s === 409)
    const tn = 'e2e_tpl_' + sfx
    const tc = await raw('/role-templates', J('POST', { name: tn, role: 'QA', access: { QA: 'USE', WH13: 'VIEW' } }))
    await raw(`/role-templates/${encodeURIComponent(tn)}/apply`, J('POST', { usernames: [un] }))
    const tu = await raw(`/role-templates/${encodeURIComponent(tn)}`, J('PUT', { role: 'QA', access: { QA: 'APPROVE' }, applyToUsers: true }))
    const afterTpl = await raw(`/users/${un}`)
    ok('Users: template สร้าง / ใช้ / แก้แล้วใช้กับคนเดิม', tc.s === 201 && tu.j?.applied === 1 && afterTpl.j.access.QA?.level === 'APPROVE' && !afterTpl.j.access.WH13, JSON.stringify(afterTpl.j?.access))
    ok('Users: ลบ template ที่มีคนใช้ → 409', (await raw(`/role-templates/${encodeURIComponent(tn)}`, J('DELETE'))).s === 409)
    const imp = await raw('/users/import', J('POST', { csv: `username,full_name,dept,template,WH13,password\ne2e_imp_${sfx},นำเข้า,คลังสินค้า,พนักงานคลัง,,pass1234\nbad name!,x,,,,` }))
    ok('Users: นำเข้า CSV (สร้าง 1 + แถวผิดแจ้งรายแถว)', imp.s === 200 && imp.j.results[0].ok && !imp.j.results[1].ok, JSON.stringify(imp.j?.results?.map((r) => r.ok)))
    const exp = await fetch(API + '/api/v1/users/export.csv', { headers: { authorization: 'Bearer ' + TOKEN } }).then((r) => r.text())
    ok('Users: ส่งออก CSV ไม่มีรหัสผ่าน', exp.includes('username,full_name') && exp.includes(un) && !/password|scrypt/i.test(exp))
    for (let i = 0; i < 5; i++) await login('e2e_imp_' + sfx, 'wrong')
    const locked = (await login('e2e_imp_' + sfx, 'pass1234')).status
    await raw(`/users/e2e_imp_${sfx}/unlock`, J('POST'))
    ok('Users: ผิด 5 ครั้งโดนล็อก → ผู้ดูแลปลดล็อกได้', locked === 423 && (await login('e2e_imp_' + sfx, 'pass1234')).status === 200)
    const hist = await raw(`/users/audit?username=${un}`)
    ok('Users: ประวัติการแก้ผู้ใช้', hist.s === 200 && hist.j.some((x) => x.action === 'USER_CREATE') && hist.j.some((x) => x.action === 'USER_UPDATE'))
    const ctxU = await browser.createBrowserContext()
    // users.html ไม่มี bridge → login ผ่านหน้า login เอง (next=/users.html)
    const pu = await ctxU.newPage(); errors['users-page'] = []
    pu.on('pageerror', (e) => errors['users-page'].push(String(e.message).split('\n')[0])); pu.on('dialog', (d) => d.accept().catch(() => {}))
    await pu.goto(`${FRONT}/login.html?next=%2Fusers.html`, { waitUntil: 'load' })
    await pu.waitForSelector('#u'); await pu.type('#u', ADMIN_USER); await pu.type('#p', ADMIN_PASS)
    await Promise.all([pu.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), pu.click('#btn')])
    await pu.waitForSelector('#people tr', { timeout: 15000 }).catch(() => {})
    await sleep(800)
    const rowsN = await pu.evaluate(() => document.querySelectorAll('#people tr').length)
    const cellN = await pu.evaluate(() => document.querySelectorAll('select.lv[data-user]').length)
    ok('Users: หน้า /users.html แสดงรายชื่อ + ตารางสิทธิ์ ไม่มี error', rowsN > 5 && cellN > 10 && errors['users-page'].length === 0, `rows=${rowsN} cells=${cellN} ${errors['users-page'].slice(0, 2).join(' | ')}`)
    await ctxU.close()
  }

  // ── 14. login ในหน้าจอ WH13 ด้วยบัญชีของตัวเอง + กันเปิดหน้าตามสิทธิ์ ──
  {
    const J = (method, body) => (body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const raw = async (p, opt = {}, tok = TOKEN) => { const r = await fetch(API + '/api/v1' + p, { ...opt, headers: { ...(opt.headers || {}), authorization: 'Bearer ' + tok } }); return { s: r.status, j: await r.json().catch(() => null) } }
    const sfx = String(Date.now() % 100000)
    const boss = 'e2e_boss_' + sfx, viewer = 'e2e_view_' + sfx
    await raw('/users', J('POST', { username: boss, fullName: 'หัวหน้า E2E', password: 'boss1234', mustChangePassword: false, access: { WH13: 'ADMIN', V4: 'NONE' } }))
    await raw('/users', J('POST', { username: viewer, fullName: 'ดูอย่างเดียว', password: 'view1234', mustChangePassword: false, access: { WH13: 'VIEW' } }))
    const v1 = await raw('/auth/verify', J('POST', { username: boss, password: 'boss1234', module: 'WH13', minLevel: 'USE' }))
    ok('AppLogin: verify ผู้ดูแล WH13 ไม่ได้ตั้งชื่อในหน้าจอ → Tom', v1.s === 200 && v1.j.alias === 'Tom', JSON.stringify(v1.j))
    ok('AppLogin: verify สิทธิ์ดูอย่างเดียว → ทำรายการไม่ได้ (403)', (await raw('/auth/verify', J('POST', { username: viewer, password: 'view1234', module: 'WH13', minLevel: 'USE' }))).s === 403)
    ok('AppLogin: verify รหัสผิด → 401', (await raw('/auth/verify', J('POST', { username: boss, password: 'nope', module: 'WH13' }))).s === 401)
    // หน้าต่าง login ของ WH13 (__rmaGate) — ใส่บัญชีตัวเอง → หน้าจอทำงานในนาม Tom
    const ctxG = await browser.createBrowserContext()
    const wg = await open(ctxG, 'WH13.html', 'WH13-gate')
    await wg.waitForFunction(() => window.__rmaGatePwdVerify && window.__rmaGatePwdVerify.__whrm, { timeout: 20000 }).catch(() => {})
    const gateRes = async (u, pw) => {
      await wg.evaluate(() => { window.__e2eGate = null; window.__rmaGate('E2E_TEST', (user) => { window.__e2eGate = user }) })
      await wg.waitForSelector('#rmaGateUsername', { timeout: 5000 })
      await wg.evaluate((u, pw) => { document.getElementById('rmaGateUsername').value = u; document.getElementById('rmaGatePassword').value = pw; window.__rmaGatePwdVerify() }, u, pw)
      await sleep(900)
      return wg.evaluate(() => ({ user: window.__e2eGate, status: (document.getElementById('rmaGateStatus') || {}).textContent || '' }))
    }
    const g1 = await gateRes(boss, 'boss1234')
    ok('AppLogin: หน้าต่าง login WH13 ใช้บัญชีตัวเอง → ทำงานในนาม Tom', g1.user && g1.user.id === 'Tom' && String(g1.user.name).includes(boss), JSON.stringify(g1.user))
    const g2 = await gateRes(boss, 'wrong')
    ok('AppLogin: รหัสผิดในหน้าต่าง WH13 → แจ้ง ไม่ผ่าน', !g2.user && /ไม่ถูกต้อง/.test(g2.status), g2.status)
    await wg.evaluate(() => window.__rmaGateClose && window.__rmaGateClose())
    const g3 = await gateRes('Tom', '8888')
    ok('AppLogin: บัญชีเดิม Tom/8888 ยังใช้ได้ (ช่วงเปลี่ยนผ่าน)', g3.user && g3.user.id === 'Tom')
    const leaked = await wg.evaluate(() => { const o = window.systemUsers || {}; return Object.values(o).some((u) => String(u.password || '').startsWith('whrm-')) })
    ok('AppLogin: ไม่มีรหัสชั่วคราวค้างในหน้าจอ', !leaked)
    const audit = await raw('/users/audit?username=' + boss)
    ok('AppLogin: server บันทึกว่าใครทำจริง (APP_LOGIN)', (audit.j || []).some((x) => x.action === 'APP_LOGIN' && x.detail?.alias === 'Tom'))
    await ctxG.close()
    // ปุ่ม login ที่ sidebar (tryLogin) + กันเปิดหน้า V4 (สิทธิ์ —)
    const ctxB = await browser.createBrowserContext()
    const pb = await ctxB.newPage(); errors['boss'] = []; pb.on('dialog', (d) => d.accept().catch(() => {}))
    await pb.goto(FRONT + '/login.html?next=%2FWH13.html', { waitUntil: 'load' }); await pb.waitForSelector('#u')
    await pb.type('#u', boss); await pb.type('#p', 'boss1234')
    await Promise.all([pb.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), pb.click('#btn')])
    await pb.waitForFunction(() => window.tryLogin && window.tryLogin.__whrm, { timeout: 20000 }).catch(() => {})
    await pb.evaluate((u) => window.tryLogin(u, 'boss1234'), boss); await sleep(600)
    const cur = await pb.evaluate(() => { try { return currentLoggedInUser } catch (e) { return window.currentLoggedInUser } })
    ok('AppLogin: ปุ่ม login sidebar WH13 ด้วยบัญชีตัวเอง', cur && cur.id === 'Tom', JSON.stringify(cur))
    await pb.goto(FRONT + '/V4.html', { waitUntil: 'load' })
    const blocked = await pb.waitForSelector('#whrm-noaccess', { timeout: 10000 }).then(() => true).catch(() => false)
    ok('Access: สิทธิ์ "—" ของ V4 → เปิดหน้า V4 ไม่ได้', blocked)
    await ctxB.close()
  }

  // ── 14b. กดปุ่มจริงในหน้าจอ WH13 (แบบที่ผู้ใช้ทำ) — ตัวตรวจรหัสทุกชุดของลูกค้า ──
  {
    const J = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const sfx = String(Date.now() % 100000), boss = 'e2e_click_' + sfx
    await fetch(API + '/api/v1/users', { ...J('POST', { username: boss, fullName: 'คลิก E2E', password: 'click1234', mustChangePassword: false, access: { WH13: 'ADMIN' } }), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN } })
    const ctxC = await browser.createBrowserContext()
    const wc = await open(ctxC, 'WH13.html', 'WH13-click')
    await sleep(1500)
    // ปุ่ม "ยังไม่ Login" ที่ sidebar → หน้าต่าง → พิมพ์ → กด "เข้าสู่ระบบ"
    const sidebar = async (u, pw, enter) => {
      await wc.evaluate(() => { try { if (currentLoggedInUser) window.openLoginModal() } catch (e) {} window.openLoginModal() })   // ถ้า login อยู่ ปุ่มนี้ = ออกจากระบบ
      await wc.click('#loginTabManual')   // แท็บ User / Password (ค่าเริ่มต้น = สแกนบัตร)
      await wc.waitForSelector('#loginUsernameInput', { visible: true, timeout: 5000 })
      await wc.evaluate(() => { document.getElementById('loginUsernameInput').value = ''; document.getElementById('loginPasswordInput').value = '' })
      await wc.type('#loginUsernameInput', u); await wc.type('#loginPasswordInput', pw)
      if (enter) await wc.keyboard.press('Enter'); else await wc.click('button[onclick="attemptManualLogin()"]')
      await sleep(800)
      return wc.evaluate(() => { let c = null; try { c = currentLoggedInUser } catch (e) {} return { cur: c || window.currentLoggedInUser || null, note: (document.querySelector('.whrm-cred-note') || {}).textContent || '' } })
    }
    const bad = await sidebar(boss, 'wrong-pass')
    ok('Click: login sidebar รหัสผิด → ไม่ผ่าน + บอกเหตุผล', !(bad.cur && bad.cur.id === 'Tom') && /ไม่ถูกต้อง/.test(bad.note), bad.note)
    const good = await sidebar(boss, 'click1234')
    ok('Click: login sidebar ด้วยบัญชีตัวเอง (กดปุ่มจริง) → ในนาม Tom', good.cur && good.cur.id === 'Tom' && String(good.cur.name).includes(boss), JSON.stringify(good.cur))
    const badgeTxt = await wc.evaluate(() => (document.querySelector('#loginBadge span.truncate') || {}).textContent || '')
    ok('Label: ป้ายแสดง "ชื่อจริง · ผู้ดูแล" ไม่ใช่ "Tom - …"', badgeTxt.includes(boss) && badgeTxt.includes('ผู้ดูแล') && !/^Tom - /.test(badgeTxt), badgeTxt)
    const viaEnter = await sidebar(boss, 'click1234', true)
    ok('Click: login sidebar กด Enter ในช่องรหัส → ในนาม Tom', viaEnter.cur && viaEnter.cur.id === 'Tom' && String(viaEnter.cur.name).includes(boss), JSON.stringify(viaEnter.cur))
    // หน้าต่างอนุมัติ (__rmaGate) → พิมพ์ → กดปุ่มยืนยัน
    await wc.evaluate(() => { window.__e2eGate2 = null; window.__rmaGate('E2E_CLICK', (u) => { window.__e2eGate2 = u }) })
    await wc.waitForSelector('#rmaGateUsername', { visible: true, timeout: 5000 })
    await wc.type('#rmaGateUsername', boss); await wc.type('#rmaGatePassword', 'click1234')
    const clicked = await wc.evaluate(() => {
      const m = document.getElementById('rmaLoginGate'); if (!m) return 'no-modal'
      const b = [...m.querySelectorAll('button')].find((x) => x.offsetParent && /เข้าสู่ระบบ|ยืนยัน|Login/i.test(x.textContent) && !/ปิด|ยกเลิก/.test(x.textContent))
      if (!b) return 'no-button'; b.click(); return b.textContent.trim()
    })
    await sleep(900)
    const g = await wc.evaluate(() => window.__e2eGate2)
    ok('Click: หน้าต่างอนุมัติ WH13 กดปุ่มจริง → ในนาม Tom', g && g.id === 'Tom', 'button=' + clicked + ' user=' + JSON.stringify(g))
    await sleep(500)
    const shown = await wc.evaluate(() => {
      const hits = (document.body.innerText.match(/(^|[^A-Za-z0-9_-])(Tom|QA-001|WH-002)(?![A-Za-z0-9_-])/g) || []).slice(0, 5)
      const uid = (document.getElementById('rmaGateUsername') || {}).value
      return { hits, uid }
    })
    ok('Label: ไม่มี Tom / QA-001 / WH-002 แสดงบนหน้าจอ WH13', shown.hits.length === 0, JSON.stringify(shown.hits))
    const leaked = await wc.evaluate(() => { const vals = []; try { vals.push(...Object.values(systemUsers)) } catch (e) {} vals.push(...Object.values(window.systemUsers || {})); return vals.some((u) => /^whrm-/.test(String(u && u.password))) })
    ok('Click: ไม่มีรหัสชั่วคราวค้างหลังกด', !leaked)
    await ctxC.close()
  }

  // ── 10. JS error ที่ bridge เพิ่มเข้ามา ──
  const extra = (tag, raw) => errors[tag].filter((e) => !errors[raw].includes(e))
  const exV4 = extra('V4', 'raw-V4.html'), exWH = [...extra('WH13-A', 'raw-WH13.html'), ...extra('WH13-B', 'raw-WH13.html')]
  ok('ไม่มี JS error ใหม่จาก bridge (V4)', exV4.length === 0, exV4.slice(0, 3).join(' | ') || `baseline errors=${errors['raw-V4.html'].length}`)
  ok('ไม่มี JS error ใหม่จาก bridge (WH13)', exWH.length === 0, exWH.slice(0, 3).join(' | ') || `baseline errors=${errors['raw-WH13.html'].length}`)
} catch (e) {
  ok('test run', false, e.stack)
} finally {
  await browser.close()
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
