// สิทธิ์รายส่วน (ช่องในหน้าจัดการผู้ใช้) · role ADMIN ได้ทุกส่วน
import { LEVELS, MODULES } from './auth.js'

export const atLeast = (level, min) => LEVELS.indexOf(level || 'NONE') >= LEVELS.indexOf(min)

export async function accessOf(pool, user) {
  if (!user) return {}
  if (user.role === 'ADMIN') return Object.fromEntries(MODULES.map((m) => [m, 'ADMIN']))
  const { rows } = await pool.query('SELECT module, level FROM user_access WHERE username = $1', [user.username])
  return Object.fromEntries(rows.map((r) => [r.module, r.level]))
}

// ข้อมูลใน kv_store ที่เปิดให้เฉพาะบางส่วน (อ่าน = ดู ขึ้นไป · เขียน = ใช้งาน ขึ้นไป ในส่วนใดส่วนหนึ่งที่ระบุ)
//   ขาย (BD02): ราคา รายการสินค้า KPI Audit · 6 พ.ย. ทะเบียนพนักงานขาย เป้ายอดขาย เขตการขาย ประวัติราคา
//   ขนส่ง: หลักฐานการส่งมอบ (POD — มีรูปถ่าย / ลายเซ็นลูกค้า) · คลังอ่านได้
// ตะกร้า / session / ร่างฟอร์ม เป็นค่าเฉพาะเครื่อง (ดู LOCAL_KEYS ใน whrm-bridge.js)
const PROTECTED = [
  { re: /^(whrm_bd_(price|product)_catalog_v1|whrm_bd_favorites_v1|whrm_bd_price_history_v1|pmp_bd_(salespeople|sales_targets|sales_zone_assignments)_v1|bd_(audit_log_v1|dashboard_kpi_v1|kpi_[a-z_]+_v1|order_summary_v1|last_submit_v1))$/,
    read: ['BD02'], write: ['BD02'] },
  { re: /^lg_pod_v1$/, read: ['LOGISTICS', 'WH13'], write: ['LOGISTICS'] },
  // UI 21 พ.ย.: ทุกส่วนอ่านได้ (read: null) · ทะเบียนหน่วยงาน / ชื่อเรียกแผนก / ธง "ลายเซ็นอยู่ที่ HRD01" แก้ได้เฉพาะส่วน HRD
  { re: /^(hrd_dept_master_v1|whrm_hrd_dept_alias_v1|whrm_identity_hrd_managed_v1)$/, read: null, write: ['HRD'] },
  // รายชื่อพนักงาน / หัวหน้าแผนก / สถานะบัญชี = server สร้างจากบัญชีกลาง (src/hrdProjection.js) · เครื่องเขียนเองไม่ได้ (รวมผู้ดูแล)
  { re: /^(whrm_hrd_employees_v1|whrm_hrd_account_status_v1)$/, read: null, write: [] },
]
export const BD_SHARED_RE = /^bd_(audit_log_v1|dashboard_kpi_v1|kpi_[a-z_]+_v1|order_summary_v1|last_submit_v1)$/
const ruleOf = (key) => PROTECTED.find((p) => p.re.test(key)) || null
export const moduleOfKey = (key) => ruleOf(key)?.read?.[0] || null
// อ่านได้แต่เขียนไม่ได้ → bridge คืนค่าเดิมของ server (ไม่หยุด sync key นี้)
export const isReadOnlyKey = (access, key) => { const r = ruleOf(key); return !!r && !r.read && !r.write.some((m) => atLeast(access[m], 'USE')) }
export const canReadKey = (access, key) => { const r = ruleOf(key); return !r || !r.read || r.read.some((m) => atLeast(access[m], 'VIEW')) }
export const canWriteKey = (access, key) => { const r = ruleOf(key); return !r || r.write.some((m) => atLeast(access[m], 'USE')) }
