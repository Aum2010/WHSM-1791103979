// สิทธิ์รายส่วน (ช่องในหน้าจัดการผู้ใช้) · role ADMIN ได้ทุกส่วน
import { LEVELS, MODULES } from './auth.js'

export const atLeast = (level, min) => LEVELS.indexOf(level || 'NONE') >= LEVELS.indexOf(min)

export async function accessOf(pool, user) {
  if (!user) return {}
  if (user.role === 'ADMIN') return Object.fromEntries(MODULES.map((m) => [m, 'ADMIN']))
  const { rows } = await pool.query('SELECT module, level FROM user_access WHERE username = $1', [user.username])
  return Object.fromEntries(rows.map((r) => [r.module, r.level]))
}

// ข้อมูลขายใน kv_store (ราคา รายการสินค้า KPI Audit ของ BD02) → เฉพาะผู้มีสิทธิ์ BD02
// ตะกร้า / session / ร่างฟอร์ม เป็นค่าเฉพาะเครื่อง (ดู LOCAL_KEYS ใน whrm-bridge.js)
const BD_PROTECTED = /^(whrm_bd_(price|product)_catalog_v1|whrm_bd_favorites_v1|bd_(audit_log_v1|dashboard_kpi_v1|kpi_[a-z_]+_v1|order_summary_v1|last_submit_v1))$/
export const BD_SHARED_RE = /^bd_(audit_log_v1|dashboard_kpi_v1|kpi_[a-z_]+_v1|order_summary_v1|last_submit_v1)$/
export const moduleOfKey = (key) => (BD_PROTECTED.test(key) ? 'BD02' : null)
export const canReadKey = (access, key) => { const m = moduleOfKey(key); return !m || atLeast(access[m], 'VIEW') }
export const canWriteKey = (access, key) => { const m = moduleOfKey(key); return !m || atLeast(access[m], 'USE') }
