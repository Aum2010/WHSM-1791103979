// Sync ค่า localStorage whrm_* ระหว่างเครื่อง (optimistic lock ด้วย version)
import { withTx } from '../db.js'

// whrm* ทั้งหมด + master สินค้า / ลูกค้าของ DBV2.0 (ต้องตรงกับ SHARED_KEYS ใน whrm-bridge.js)
const KEY_RE = /^whrm[\w.-]{0,200}$/
const SHARED_KEYS = new Set(['pmp_master_v66', 'pmp_categories_v66', 'pmp_main_categories_v66', 'pmp_mapping_v66',
  'pmp_suppliers_v1', 'pmp_audit_v66', 'pmp.crm.customers.v4'])
const keyAllowed = (key) => KEY_RE.test(key) || SHARED_KEYS.has(key)
const HISTORY_KEEP = 20

export async function loadSnapshot(pool) {
  const [{ rows }, { rows: [{ max }] }] = await Promise.all([
    pool.query('SELECT key, value, version FROM kv_store'),
    pool.query('SELECT COALESCE(MAX(seq), 0)::bigint AS max FROM bus_message'),
  ])
  const kv = {}
  for (const r of rows) kv[r.key] = { value: r.value, version: r.version }
  return { kv, busSeq: Number(max) }
}

export default async function syncRoutes(app, { pool, bus, ruCancel }) {
  app.get('/sync/snapshot', async () => loadSnapshot(pool))

  app.get('/sync/keys', async () => {
    const { rows } = await pool.query(
      `SELECT key, version, length(value) AS size, value IS NULL AS deleted, updated_by, updated_at
       FROM kv_store ORDER BY key`,
    )
    return rows
  })

  app.get('/sync/kv/:key', async (req, reply) => {
    const { rows } = await pool.query('SELECT key, value, version, updated_by, updated_at FROM kv_store WHERE key = $1', [req.params.key])
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบ key ${req.params.key}` })
    return rows[0]
  })

  app.get('/sync/kv/:key/history', async (req) => {
    const { rows } = await pool.query(
      `SELECT version, length(value) AS size, updated_by, at FROM kv_history WHERE key = $1 ORDER BY version DESC`,
      [req.params.key],
    )
    return rows
  })

  // body: { value: string | null, baseVersion: number, deviceId?, connId? }
  app.put('/sync/kv/:key', async (req, reply) => {
    const key = req.params.key
    if (!keyAllowed(key)) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `key ไม่ถูกต้อง: ${key}` })
    }
    const { value = null, baseVersion = 0, deviceId = null, connId = null } = req.body || {}
    if (value !== null && typeof value !== 'string') {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'value ต้องเป็น string หรือ null' })
    }

    const result = await withTx(pool, async (c) => {
      // lock ราย key — FOR UPDATE อย่างเดียวไม่พอตอน key ยังไม่มีแถว (2 เครื่องสร้างพร้อมกันจะทับกัน)
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      const { rows } = await c.query('SELECT value, version FROM kv_store WHERE key = $1', [key])
      const current = rows[0]
      const currentVersion = current ? current.version : 0
      if (currentVersion !== Number(baseVersion)) {
        return { conflict: true, current: { value: current ? current.value : null, version: currentVersion } }
      }
      const version = currentVersion + 1
      await c.query(
        `INSERT INTO kv_store (key, value, version, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, value, version, deviceId],
      )
      await c.query('INSERT INTO kv_history (key, version, value, updated_by) VALUES ($1,$2,$3,$4)', [key, version, value, deviceId])
      await c.query(
        `DELETE FROM kv_history WHERE key = $1 AND version <= $2`,
        [key, version - HISTORY_KEEP],
      )
      return { conflict: false, version, oldValue: current ? current.value : null }
    })

    if (result.conflict) {
      return reply.code(409).send({
        error: 'VERSION_CONFLICT',
        message: 'ข้อมูลถูกแก้จากเครื่องอื่น — กำลังรวมข้อมูล',
        current: result.current,
      })
    }
    bus.broadcast({ kind: 'kv', key, value, version: result.version, deviceId, connId }, connId)
    if (ruCancel) {
      ruCancel.onKvWrite(key, result.oldValue, value, deviceId).catch((err) => req.log.error({ err }, 'ru cancel hook failed'))
    }
    return { key, version: result.version }
  })

  // กู้ค่าเก่าจาก history (ใช้เมื่อข้อมูลถูกเขียนทับผิด)
  app.post('/sync/kv/:key/restore', async (req, reply) => {
    const key = req.params.key
    const target = Number(req.body?.version)
    const res = await withTx(pool, async (c) => {
      const { rows: h } = await c.query('SELECT value FROM kv_history WHERE key = $1 AND version = $2', [key, target])
      if (!h.length) return null
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      const { rows } = await c.query('SELECT version FROM kv_store WHERE key = $1', [key])
      const version = (rows[0]?.version || 0) + 1
      await c.query(
        `UPDATE kv_store SET value = $2, version = $3, updated_by = 'restore', updated_at = now() WHERE key = $1`,
        [key, h[0].value, version],
      )
      await c.query('INSERT INTO kv_history (key, version, value, updated_by) VALUES ($1,$2,$3,$4)', [key, version, h[0].value, 'restore'])
      return { value: h[0].value, version }
    })
    if (!res) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบ version ${target} ของ ${key}` })
    bus.broadcast({ kind: 'kv', key, value: res.value, version: res.version, deviceId: 'restore' })
    return { key, version: res.version }
  })
}
