// UI 1795227104 (21 พ.ย.): server สร้างข้อมูลพนักงานที่หน้าของลูกค้าอ่าน จากบัญชีกลาง (app_user) — ไม่ให้เครื่องใดเขียนเอง
//   whrm_hrd_employees_v1      { v:1, source:'server', updatedAt, employees:[{ empid, loginId, name, dept, deptCode, position, status, isDeptHead }] }
//                              → WH13 [HRD-ADAPTER] ใช้หาหัวหน้าแผนกของ IO / RU / FGT · BD02 / V4 / QA ใช้ชื่อ / แผนก
//   whrm_hrd_account_status_v1 { v:1, rev, updatedAt, accounts:{ <username>:{ status:'ACTIVE'|'INACTIVE', reason, by, at } } } → WHAUTH 1.2.0 (WH13 / V4)
//   แผนก: แปลงเป็นข้อความเดียวกับทะเบียนหน่วยงาน "Warehouse · ฝ่ายคลังสินค้า (WHS)" เมื่อจับคู่ได้ (รหัส / รหัสเดิม / ชื่อไทย / ชื่ออังกฤษ)
import { serverPutKv } from './routes/sync.js'

export const EMP_KEY = 'whrm_hrd_employees_v1'
export const STATUS_KEY = 'whrm_hrd_account_status_v1'
export const DEPT_KEY = 'hrd_dept_master_v1'

// ค่าเริ่มต้นชุดเดียวกับ HRD01 [HRD-DEPT-MASTER] (ใช้เมื่อยังไม่มีทะเบียนใน server)
const DEFAULT_DEPTS = [
  ['MAN', 'Management', 'ฝ่ายบริหาร', ['EXEC']], ['QUA', 'Quality assurance', 'ฝ่ายประกันคุณภาพ', ['QA', 'QC']],
  ['PRO', 'Production', 'ฝ่ายผลิต', ['PD', 'PROD']], ['WHS', 'Warehouse', 'ฝ่ายคลังสินค้า', ['WH']],
  ['BDS', 'Business development', 'ฝ่ายพัฒนาธุรกิจ', ['BD']], ['FAA', 'Finance and accounting', 'ฝ่ายบัญชีและการเงิน', ['FI', 'FA']],
  ['ENG', 'Maintenance', 'ฝ่ายซ่อมบำรุง', []], ['HRD', 'Human resource', 'ฝ่ายทรัพยากรบุคคล', ['HR']], ['PUR', 'Purchase', 'ฝ่ายจัดซื้อ', []],
].map(([code, nameEn, nameTh, legacy]) => ({ code, nameEn, nameTh, legacy, active: true }))

export function deptList(raw) {
  try { const x = JSON.parse(raw || 'null'); if (x && Array.isArray(x.depts) && x.depts.length) return x.depts } catch { /* ค่าเสีย → ค่าเริ่มต้น */ }
  return DEFAULT_DEPTS
}
const deptString = (d) => `${d.nameEn} · ${d.nameTh} (${d.code})`

// ข้อความแผนกในบัญชี → หน่วยงานในทะเบียน (ไม่เจอ = null)
export function resolveDept(text, depts) {
  const t = String(text || '').trim()
  if (!t) return null
  const up = t.toUpperCase(), paren = /\(([^)]+)\)\s*$/.exec(t)
  const code = paren ? paren[1].trim().toUpperCase() : up
  return depts.find((d) => d.code === code) || depts.find((d) => (d.legacy || []).includes(code)) ||
    depts.find((d) => d.nameTh === t || d.nameTh.replace(/^ฝ่าย/, '') === t || d.nameEn.toUpperCase() === up) || null
}

export async function buildProjection(pool) {
  const [{ rows: users }, { rows: [dm] }] = await Promise.all([
    pool.query(`SELECT username, full_name, dept, position, card_id, COALESCE(status, 'active') AS status, is_dept_head, updated_at
                FROM app_user ORDER BY username`),
    pool.query('SELECT value FROM kv_store WHERE key = $1', [DEPT_KEY]),
  ])
  const depts = deptList(dm && dm.value)
  const employees = users.map((u) => {
    const d = resolveDept(u.dept, depts)
    return { empid: u.card_id || u.username, loginId: u.username, name: u.full_name || u.username,
      dept: d ? deptString(d) : (u.dept || ''), deptCode: d ? d.code : '', position: u.position || '',
      status: u.status === 'active' ? 'Active' : 'Suspended', isDeptHead: !!u.is_dept_head && u.status === 'active' }
  })
  const accounts = {}
  for (const u of users) {
    accounts[u.username] = { status: u.status === 'active' ? 'ACTIVE' : 'INACTIVE', reason: u.status === 'active' ? '' : 'ปิดบัญชีที่ server',
      by: 'server', at: u.updated_at ? new Date(u.updated_at).toISOString() : '' }
  }
  return { employees, accounts }
}

// เทียบเฉพาะเนื้อหา (ไม่นับเวลา) — ไม่เปลี่ยน = ไม่เขียน ไม่ให้ทุกเครื่องโหลดซ้ำ
async function current(pool, key) {
  const { rows: [r] } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key])
  try { return r && r.value ? JSON.parse(r.value) : null } catch { return null }
}

export async function publishHrd(pool, bus) {
  const { employees, accounts } = await buildProjection(pool)
  const now = new Date().toISOString(), out = { employees: false, accounts: false }
  const e = await current(pool, EMP_KEY)
  if (!e || e.source !== 'server' || JSON.stringify(e.employees) !== JSON.stringify(employees)) {
    await serverPutKv(pool, bus, EMP_KEY, JSON.stringify({ v: 1, source: 'server', updatedAt: now, employees }), 'server:hrd')
    out.employees = true
  }
  const s = await current(pool, STATUS_KEY)
  if (!s || s.source !== 'server' || JSON.stringify(s.accounts) !== JSON.stringify(accounts)) {
    await serverPutKv(pool, bus, STATUS_KEY, JSON.stringify({ v: 1, source: 'server', rev: ((s && s.rev) || 0) + 1, updatedAt: now, accounts }), 'server:hrd')
    out.accounts = true
  }
  return out
}

// เรียกหลังแก้บัญชี / ทะเบียนหน่วยงาน — รวมหลายครั้งติดกันเป็นครั้งเดียว
export function hrdPublisher(pool, bus, log) {
  let timer = null, running = Promise.resolve()
  const run = () => { running = running.then(() => publishHrd(pool, bus)).catch((err) => log && log.error({ err }, 'hrd projection failed')); return running }
  return {
    now: run,
    schedule(ms = 200) { clearTimeout(timer); timer = setTimeout(run, ms) },
  }
}
