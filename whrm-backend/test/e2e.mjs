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
