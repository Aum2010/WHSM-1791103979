// เอกสารรายใบ (เฟส 1): ใบโอน + คิวขนส่ง · หน้าจอยังอ่าน / เขียน localStorage ผ่าน whrm-bridge.js (startDocs)
//   PUT ส่ง baseVersion · ไม่ตรง = 409 + ใบปัจจุบัน ให้เครื่องนั้นรวมแล้วส่งใหม่ (ไม่ทับงานเครื่องอื่น)
import { withTx } from '../db.js'
import { audit } from '../weighing.js'
import { accessOf, atLeast } from '../access.js'

export const DOC_KINDS = {
  dc_transfer: { key: 'whrm_dc_transfer_v1', idField: 'trfNo', read: ['WH13', 'LOGISTICS', 'V4'], write: ['WH13', 'LOGISTICS'] },
  logistic_queue: { key: 'whrm_logistic_queue_v1', idField: 'lgNo', read: ['WH13', 'LOGISTICS', 'QA'], write: ['WH13', 'LOGISTICS'] },
}
export const DOC_KEYS = new Set(Object.values(DOC_KINDS).map((k) => k.key))
const HISTORY_KEEP = 30
const ID_RE = /^[\w.\-/]{1,80}$/
const can = (access, mods, min) => mods.some((m) => atLeast(access[m], min))
export const canReadKind = (access, kind) => !!DOC_KINDS[kind] && can(access, DOC_KINDS[kind].read, 'VIEW')

export default async function docRoutes(app, { pool, bus }) {
  // ตาราง docid_map มีหลัง migration 012 · ยังไม่เคยแปลง = ไม่มีเลขที่เลิกใช้
  async function retiredIds() {
    try { return (await pool.query('SELECT old_id FROM docid_map ORDER BY old_id LIMIT 50000')).rows.map((r) => r.old_id) } catch { return [] }
  }
  async function retiredTo(id) {
    try { return (await pool.query('SELECT new_id FROM docid_map WHERE old_id = $1', [id])).rows[0]?.new_id || null } catch { return null }
  }
  app.get('/docs/snapshot', async (req) => {
    const access = await accessOf(pool, req.user)
    const kinds = String(req.query.kinds || '').split(',').filter((k) => DOC_KINDS[k])
    const out = { docs: {}, denied: [] }
    for (const kind of kinds) {
      if (!canReadKind(access, kind)) { out.denied.push(kind); continue }
      const { rows } = await pool.query('SELECT id, data, version FROM doc_store WHERE kind = $1 ORDER BY created_at DESC, id DESC', [kind])
      out.docs[kind] = rows
    }
    // เลขใบที่ถูกแปลงเป็นรูปแบบมาตรฐานแล้ว (scripts/migrate-docids.mjs) → หน้าเว็บทิ้งใบเลขเก่าในเครื่อง ไม่ส่งขึ้นใหม่
    out.retired = await retiredIds()
    return out
  })

  app.get('/docs/:kind/:id/history', async (req, reply) => {
    const { kind, id } = req.params
    if (!canReadKind(await accessOf(pool, req.user), kind)) return reply.code(403).send({ error: 'FORBIDDEN_MODULE', message: 'ไม่มีสิทธิ์ดูเอกสารนี้' })
    const { rows } = await pool.query('SELECT version, data, updated_by, at FROM doc_history WHERE kind = $1 AND id = $2 ORDER BY version DESC', [kind, id])
    return rows
  })

  // body: { data, baseVersion }  (baseVersion 0 = สร้างใหม่)
  app.put('/docs/:kind/:id', async (req, reply) => {
    const { kind, id } = req.params, def = DOC_KINDS[kind]
    const data = req.body?.data, baseVersion = Number(req.body?.baseVersion || 0)
    if (!def || !ID_RE.test(id) || !data || typeof data !== 'object' || Array.isArray(data) || String(data[def.idField] || '') !== id) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ข้อมูลเอกสารไม่ถูกต้อง' })
    }
    const gone = await retiredTo(id)
    if (gone) return reply.code(410).send({ error: 'RETIRED_ID', message: 'เลข ' + id + ' เปลี่ยนเป็น ' + gone + ' แล้ว', newId: gone })
    const access = await accessOf(pool, req.user)
    if (!can(access, def.write, 'USE')) {
      await audit(pool, { actor: req.user.username, action: 'DENIED', entityType: kind, entityId: id })
      return reply.code(403).send({ error: 'FORBIDDEN_MODULE', message: 'ไม่มีสิทธิ์แก้เอกสารนี้' })
    }
    const who = req.user.username, device = req.headers['x-device-id'] || null
    const res = await withTx(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [kind + '|' + id])
      const { rows: [cur] } = await c.query('SELECT data, version FROM doc_store WHERE kind = $1 AND id = $2', [kind, id])
      if ((cur ? cur.version : 0) !== baseVersion) return { conflict: true, current: cur ? { data: cur.data, version: cur.version } : { data: null, version: 0 } }
      const version = baseVersion + 1
      await c.query(
        `INSERT INTO doc_store (kind, id, data, version, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [kind, id, JSON.stringify(data), version, who])
      await c.query('INSERT INTO doc_history (kind, id, version, data, updated_by) VALUES ($1, $2, $3, $4, $5)', [kind, id, version, JSON.stringify(data), who])
      await c.query('DELETE FROM doc_history WHERE kind = $1 AND id = $2 AND version <= $3', [kind, id, version - HISTORY_KEEP])
      if (!cur || cur.data?.status !== data.status) {
        await audit(c, { deviceId: device, actor: who, action: cur ? 'DOC_STATUS' : 'DOC_CREATE', entityType: kind, entityId: id, detail: { from: cur?.data?.status || null, to: data.status || null } })
      }
      return { version }
    })
    if (res.conflict) return reply.code(409).send({ error: 'VERSION_CONFLICT', message: 'เอกสารถูกแก้จากเครื่องอื่น', current: res.current })
    bus.broadcast({ kind: 'doc', doc: kind, id, data, version: res.version, connId: req.body?.connId || null }, req.body?.connId || null,
      (access) => canReadKind(access, kind))
    return { id, version: res.version }
  })
}
