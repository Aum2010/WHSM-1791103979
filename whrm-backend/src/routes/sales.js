// ขาย (BD02) ↔ คลัง (WH13): ออเดอร์ SBO · คิวส่ง · ผลตอบกลับ · ใบเสนอราคา (RC-01)
//   สิทธิ์ = ช่อง "ขาย (BD02)" / "คลัง (WH13)" ในหน้าจัดการผู้ใช้ · role ADMIN ได้ทุกส่วน
import { withTx } from '../db.js'
import { audit } from '../weighing.js'
import { LEVELS } from '../auth.js'

const SBO_RE = /^SBO\d{8}\d{4}$/
const QT_RE = /^QT-\d{6}-\d{3,}$/
const ID_RE = /^[\w.-]{1,80}$/
const pad = (n, w) => String(n).padStart(w, '0')
const bad = (reply, message) => reply.code(400).send({ error: 'VALIDATION_ERROR', message })

function bangkokDate() {
  const d = new Date(Date.now() + 7 * 3600 * 1000)
  return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ''), ym: d.toISOString().slice(0, 7).replace('-', '') }
}

async function nextSeq(db, scope) {
  const { rows } = await db.query(
    `INSERT INTO doc_seq (scope, last_value) VALUES ($1, 1)
     ON CONFLICT (scope) DO UPDATE SET last_value = doc_seq.last_value + 1 RETURNING last_value`, [scope])
  return rows[0].last_value
}
// เลขที่นำเข้าจากเครื่องเดิม → ตัวนับต้องไม่ย้อนมาชนเลขนั้น
const bumpSeq = (db, scope, value) => db.query(
  `INSERT INTO doc_seq (scope, last_value) VALUES ($1, $2)
   ON CONFLICT (scope) DO UPDATE SET last_value = GREATEST(doc_seq.last_value, $2)`, [scope, value])

async function saveOrder(db, sbo, data, actor) {
  const { rows } = await db.query(
    `INSERT INTO sbo_order (sbo_number, sale_order_id, status, data, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (sbo_number) DO UPDATE SET sale_order_id = EXCLUDED.sale_order_id, status = EXCLUDED.status, data = EXCLUDED.data,
       version = sbo_order.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING version, version = 1 AS created`,
    [sbo, data.sale_order_id || null, data.status || null, JSON.stringify(data), actor])
  if (rows[0].created) await bumpSeq(db, 'SBO' + sbo.slice(3, 11), Number(sbo.slice(11)))
  return rows[0]
}

export default async function salesRoutes(app, { pool }) {
  async function levelOf(user, module) {
    if (user.role === 'ADMIN') return 'ADMIN'
    const { rows } = await pool.query('SELECT level FROM user_access WHERE username = $1 AND module = $2', [user.username, module])
    return rows[0]?.level || 'NONE'
  }
  const atLeast = (level, min) => LEVELS.indexOf(level) >= LEVELS.indexOf(min)
  const need = (module, min) => async (req, reply) => {
    if (atLeast(await levelOf(req.user, module), min)) return
    await audit(pool, { actor: req.user.username, action: 'DENIED', entityType: 'route', entityId: req.routeOptions?.url, detail: { module, min } })
    return reply.code(403).send({ error: 'FORBIDDEN_MODULE', message: `ไม่มีสิทธิ์ ${module} ระดับ ${min}` })
  }
  const deviceOf = (req) => req.headers['x-device-id'] || null

  // ข้อมูลของหน้าจอ: want=bd02 → ออเดอร์ + ผลตอบกลับ + ใบเสนอราคา · want=wh13 → คิวส่ง
  app.get('/sales/snapshot', async (req, reply) => {
    const out = {}
    if (req.query.want === 'bd02') {
      if (!atLeast(await levelOf(req.user, 'BD02'), 'VIEW')) return reply.code(403).send({ error: 'FORBIDDEN_MODULE', message: 'ไม่มีสิทธิ์ BD02' })
      const [orders, decisions, quotations] = await Promise.all([
        pool.query('SELECT sbo_number, data, version FROM sbo_order ORDER BY created_at'),
        pool.query('SELECT id, data FROM sbo_decision WHERE consumed_at IS NULL ORDER BY created_at'),
        pool.query('SELECT id, data, version FROM quotation WHERE deleted_at IS NULL ORDER BY created_at'),
      ])
      out.orders = orders.rows.map((r) => ({ sbo: r.sbo_number, data: r.data, version: r.version }))
      out.decisions = decisions.rows.map((r) => r.data)
      out.quotations = quotations.rows.map((r) => ({ id: r.id, data: r.data, version: r.version }))
    } else if (req.query.want === 'wh13') {
      if (!atLeast(await levelOf(req.user, 'WH13'), 'VIEW')) return reply.code(403).send({ error: 'FORBIDDEN_MODULE', message: 'ไม่มีสิทธิ์ WH13' })
      const { rows } = await pool.query(
        `SELECT data FROM sbo_handoff WHERE claimed_at IS NULL OR claimed_at > now() - interval '30 days' ORDER BY pushed_at`)
      out.handoffs = rows.map((r) => r.data)
    } else return bad(reply, 'want ต้องเป็น bd02 หรือ wh13')
    return out
  })

  // ── ออเดอร์ ──
  app.post('/sales/sbo-numbers', { preHandler: need('BD02', 'USE') }, async (req, reply) => {
    const { ymd } = bangkokDate()
    const n = await nextSeq(pool, 'SBO' + ymd)
    if (n > 9999) return reply.code(409).send({ error: 'SEQ_EXHAUSTED', message: 'เลข SBO ของวันนี้เต็มแล้ว' })
    return { sboNumber: `SBO${ymd}${pad(n, 4)}`, saleOrderId: `SO-${ymd}-${pad(n, 3)}` }
  })

  app.put('/sales/orders/:sbo', { preHandler: need('BD02', 'USE') }, async (req, reply) => {
    const { sbo } = req.params, data = req.body?.data
    if (!SBO_RE.test(sbo) || !data || data.sbo_number !== sbo) return bad(reply, 'เลข SBO หรือข้อมูลออเดอร์ไม่ถูกต้อง')
    const { rows: [cur] } = await pool.query('SELECT status FROM sbo_order WHERE sbo_number = $1', [sbo])
    if (cur && (cur.status === 'PENDING_APPROVAL') !== (data.status === 'PENDING_APPROVAL')) {
      return reply.code(409).send({ error: 'APPROVAL_REQUIRED', message: 'เปลี่ยนสถานะออเดอร์ที่รออนุมัติได้ผ่านการอนุมัติเท่านั้น' })
    }
    const r = await saveOrder(pool, sbo, data, req.user.username)
    return { ok: true, version: r.version }
  })

  // ── BD02 → WH13 ──
  app.post('/sales/handoffs', { preHandler: need('BD02', 'USE') }, async (req, reply) => {
    const item = req.body?.item, sbo = item?.order?.sbo_number
    if (!item || !ID_RE.test(item.id || '') || !SBO_RE.test(sbo || '')) return bad(reply, 'ข้อมูลคิวไม่ถูกต้อง')
    if (!Array.isArray(item.order.line_items) || !item.order.line_items.length) return bad(reply, 'ออเดอร์ไม่มีรายการสินค้า')
    const { rows: [pend] } = await pool.query('SELECT status FROM sbo_order WHERE sbo_number = $1', [sbo])
    if (pend?.status === 'PENDING_APPROVAL' || item.order.status === 'PENDING_APPROVAL') {
      return reply.code(409).send({ error: 'APPROVAL_REQUIRED', message: `${sbo} ยังไม่ได้รับอนุมัติ` })
    }
    return withTx(pool, async (c) => {
      await saveOrder(c, sbo, item.order, req.user.username)
      const { rows } = await c.query(
        `INSERT INTO sbo_handoff (id, sbo_number, data, pushed_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id`, [item.id, sbo, JSON.stringify(item), req.user.username])
      if (rows.length) {
        await audit(c, { deviceId: deviceOf(req), app: 'BD02', actor: req.user.username, action: 'SBO_SUBMIT', entityType: 'sbo_order', entityId: sbo })
        return { ok: true, created: true }
      }
      const { rows: [old] } = await c.query('SELECT id FROM sbo_handoff WHERE sbo_number = $1', [sbo])
      if (old?.id === item.id) return { ok: true, created: false }   // ส่งซ้ำตอนเน็ตล่ม
      return reply.code(409).send({ error: 'SBO_DUPLICATE', message: `${sbo} ถูกส่งไปแล้ว` })
    })
  })

  // หัวหน้า BD อนุมัติ (สิทธิ์ BD02 ระดับ APPROVE) · อนุมัติแล้วส่งเข้าคิว WH13 · ไม่อนุมัติ = ยกเลิกพร้อมเหตุผล
  //   ผู้อนุมัติต้องไม่ใช่ผู้สร้างออเดอร์ (ยกเว้นผู้ดูแลระบบ)
  app.post('/sales/orders/:sbo/decision', { preHandler: need('BD02', 'APPROVE') }, async (req, reply) => {
    const { sbo } = req.params, approve = req.body?.approve === true, reason = String(req.body?.reason || '').trim()
    if (!approve && reason.length < 3) return bad(reply, 'กรุณาระบุเหตุผลที่ไม่อนุมัติ (อย่างน้อย 3 ตัวอักษร)')
    return withTx(pool, async (c) => {
      const { rows: [o] } = await c.query('SELECT data, created_by FROM sbo_order WHERE sbo_number = $1 FOR UPDATE', [sbo])
      if (!o) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบ ${sbo}` })
      if (o.data.status !== 'PENDING_APPROVAL') return reply.code(409).send({ error: 'NOT_PENDING', message: `${sbo} ไม่ได้อยู่ในสถานะรออนุมัติ` })
      if (req.user.role !== 'ADMIN' && o.created_by === req.user.username) return reply.code(403).send({ error: 'SELF_APPROVAL', message: 'อนุมัติออเดอร์ที่ตัวเองสร้างไม่ได้' })
      const at = new Date().toISOString(), who = req.user.fullName ? `${req.user.fullName} (${req.user.username})` : req.user.username
      const data = o.data
      data.approval = { result: approve ? 'APPROVED' : 'REJECTED', by: who, at, reason: reason || null }
      data.history = (data.history || []).concat(approve
        ? [{ at, event: 'APPROVED', by: who }, { at, event: 'SENT_TO_WH13' }]
        : [{ at, event: 'APPROVAL_REJECTED', by: who, note: reason }])
      data.status = approve ? 'SENT_TO_WH13' : 'CANCELLED'
      const r = await saveOrder(c, sbo, data, req.user.username)
      if (approve) {
        const item = { id: 'brg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), pushed_at: at, source: 'BD_MODULE', order: data }
        await c.query('INSERT INTO sbo_handoff (id, sbo_number, data, pushed_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [item.id, sbo, JSON.stringify(item), req.user.username])
      }
      await audit(c, { deviceId: deviceOf(req), app: 'BD02', actor: req.user.username, action: approve ? 'SBO_APPROVE' : 'SBO_REJECT', entityType: 'sbo_order', entityId: sbo, detail: { reason: reason || null } })
      return { ok: true, data, version: r.version }
    })
  })

  // WH13 หลายเครื่อง: เครื่องแรกได้ claimed=true · เครื่องอื่น false (ไม่เข้า Info Center ซ้ำ)
  app.post('/sales/handoffs/:id/claim', { preHandler: need('WH13', 'USE') }, async (req, reply) => {
    const device = deviceOf(req)
    const { rows } = await pool.query(
      `UPDATE sbo_handoff SET claimed_by = $2, claimed_device = $3, claimed_at = COALESCE(claimed_at, now())
       WHERE id = $1 AND (claimed_at IS NULL OR claimed_device = $3) RETURNING id`, [req.params.id, req.user.username, device])
    if (rows.length) return { claimed: true }
    const { rowCount } = await pool.query('SELECT 1 FROM sbo_handoff WHERE id = $1', [req.params.id])
    if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND', message: 'ไม่พบรายการในคิว' })
    return { claimed: false }
  })

  // ── WH13 → BD02 ──
  app.post('/sales/decisions', { preHandler: need('WH13', 'USE') }, async (req, reply) => {
    const d = req.body?.item
    if (!d || !ID_RE.test(d.id || '') || !d.sbo_number || !d.decision) return bad(reply, 'ข้อมูลผลตอบกลับไม่ถูกต้อง')
    const key = [d.sbo_number, d.decision, d.pl_ref || '', /^PLN_/.test(d.decision) ? d.pln_at || '' : ''].join('|')
    const { rowCount } = await pool.query(
      `INSERT INTO sbo_decision (id, sbo_number, decision, dedupe_key, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [d.id, d.sbo_number, d.decision, key, JSON.stringify(d), req.user.username])
    return { ok: true, created: rowCount > 0 }
  })

  app.post('/sales/decisions/consume', { preHandler: need('BD02', 'USE') }, async (req, reply) => {
    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.some((x) => !ID_RE.test(String(x)))) return bad(reply, 'ids ไม่ถูกต้อง')
    await pool.query(
      `UPDATE sbo_decision SET consumed_by = $2, consumed_at = now() WHERE id = ANY($1) AND consumed_at IS NULL`, [ids, req.user.username])
    return { ok: true }
  })

  // ── ใบเสนอราคา ──
  app.post('/sales/quotation-numbers', { preHandler: need('BD02', 'USE') }, async () => {
    const { ym } = bangkokDate()
    return { id: `QT-${ym}-${pad(await nextSeq(pool, 'QT' + ym), 3)}` }
  })

  app.put('/sales/quotations/:id', { preHandler: need('BD02', 'USE') }, async (req, reply) => {
    const { id } = req.params, data = req.body?.data
    if (!QT_RE.test(id) || !data || data.id !== id) return bad(reply, 'เลขหรือข้อมูลใบเสนอราคาไม่ถูกต้อง')
    const { rows } = await pool.query(
      `INSERT INTO quotation (id, customer_name, status, total, data, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE SET customer_name = EXCLUDED.customer_name, status = EXCLUDED.status, total = EXCLUDED.total,
         data = EXCLUDED.data, version = quotation.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now(), deleted_at = NULL
       RETURNING version`,
      [id, data.customerName || null, data.status || null, Number(data.total) || 0, JSON.stringify(data), req.user.username])
    const [, ym, n] = id.match(/^QT-(\d{6})-(\d+)$/)
    await bumpSeq(pool, 'QT' + ym, Number(n))
    return { ok: true, version: rows[0].version }
  })

  app.delete('/sales/quotations/:id', { preHandler: need('BD02', 'USE') }, async (req) => {
    await pool.query(
      `UPDATE quotation SET deleted_at = now(), updated_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id, req.user.username])
    await audit(pool, { deviceId: deviceOf(req), app: 'BD02', actor: req.user.username, action: 'QUOTATION_DELETE', entityType: 'quotation', entityId: req.params.id })
    return { ok: true }
  })
}
