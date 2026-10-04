// Endpoint ที่ V4.html เรียกผ่าน apiCall() อยู่แล้ว (Settings → mode "live")
// body ตรงตามที่ V4 ส่งจริง — ดู V4.html: addItemToTripList, saveEntireTrip, sendToWMS, verifyOverridePin, saveUser
import { withTx } from '../db.js'
import { upsertReport, upsertItem, audit } from '../weighing.js'
import { hashPassword } from '../auth.js'

const deviceOf = (req) => req.headers['x-device-id'] || null

export default async function v4Routes(app, { pool, auth }) {
  // basket item (ยังไม่บันทึก trip)
  app.post('/weighing/items', async (req, reply) => {
    const it = req.body || {}
    if (!it._id || !it.reportId) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ต้องมี _id และ reportId' })
    }
    await withTx(pool, async (c) => {
      await upsertReport(c, { reportId: it.reportId, weighingType: it.weighingType, customer: it.customer, deviceId: deviceOf(req) })
      await upsertItem(c, it.reportId, it, 'BASKET')
    })
    return { ok: true, id: it._id }
  })

  // body: { reportId, tripNo, items, user }
  app.post('/weighing/save-trip', async (req, reply) => {
    const { reportId, tripNo, items = [], user } = req.body || {}
    if (!reportId || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ต้องมี reportId และ items อย่างน้อย 1 รายการ' })
    }
    await withTx(pool, async (c) => {
      // item ใน trip เดียวอาจมี reportId ต่างกัน (ค้างจากตะกร้าก่อนหน้า) — ยึด reportId ของแต่ละ item
      const byReport = new Map()
      for (const it of items) {
        const rid = it.reportId || reportId
        if (!byReport.has(rid)) byReport.set(rid, [])
        byReport.get(rid).push(it)
      }
      for (const [rid, list] of byReport) {
        const first = list[0]
        await upsertReport(c, {
          reportId: rid, weighingType: first.weighingType, tripNo, customer: first.customer,
          vehiclePlate: first.vehiclePlate, vehicleType: first.vehicleType, supplierTransport: first.supplierTransport,
          weighedBy: user, deviceId: deviceOf(req), weighedAt: new Date().toISOString(),
        })
        for (const it of list) await upsertItem(c, rid, it, 'SENT')
      }
      await audit(c, { deviceId: deviceOf(req), app: 'V4', actor: user, action: 'SAVE_TRIP',
        entityType: 'weighing_report', entityId: reportId, detail: { tripNo, items: items.length } })
    })
    return { ok: true, reportId, count: items.length }
  })

  // body: { reportId, itemCode }
  app.post('/wms/send', async (req, reply) => {
    const { reportId, itemCode } = req.body || {}
    if (!reportId || !itemCode) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ต้องมี reportId และ itemCode' })
    }
    const { rowCount } = await pool.query(
      `UPDATE weighing_item SET wms_status = 'SENT', updated_at = now()
       WHERE report_id = $1 AND product_code = $2 AND wms_status IN ('BASKET','SENT')`,
      [reportId, itemCode],
    )
    await audit(pool, { deviceId: deviceOf(req), app: 'V4', action: 'WMS_SEND',
      entityType: 'weighing_report', entityId: reportId, detail: { itemCode } })
    return { ok: true, updated: rowCount }
  })

  // body: { timestamp, user, role, itemCode, netWeight, reason, reportId }
  app.post('/audit/override', async (req, reply) => {
    const e = req.body || {}
    if (!e.reason) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ต้องระบุเหตุผลการ override' })
    await withTx(pool, async (c) => {
      await c.query(
        `INSERT INTO override_log (report_id, item_code, net_weight, reason, username, role, device_id, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))`,
        [e.reportId || null, e.itemCode || null, Number.isFinite(+e.netWeight) ? +e.netWeight : null,
          e.reason, e.user || null, e.role || null, deviceOf(req), e.timestamp || null],
      )
      await audit(c, { deviceId: deviceOf(req), app: 'V4', actor: e.user, action: 'WEIGHT_OVERRIDE',
        entityType: 'weighing_item', entityId: e.itemCode, detail: e })
    })
    return { ok: true }
  })

  // body: { username, password, fullName, role, dept, status, updatedAt }
  // หน้า Users ของ V4 — บันทึกเข้าระบบ login ได้เฉพาะ ADMIN (คนอื่นแก้ได้แค่ในเครื่องตัวเองตามเดิม)
  app.post('/users/save', { preHandler: auth.requireRole('ADMIN') }, async (req, reply) => {
    const u = req.body || {}
    if (!u.username) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ต้องมี username' })
    const hash = u.password ? await hashPassword(u.password) : null
    // role ของ V4 → role ของระบบ
    const role = { admin: 'ADMIN', supervisor: 'WH_SUPERVISOR', operator: 'WEIGH_OPERATOR' }[String(u.role || '').toLowerCase()] || u.role || null
    await withTx(pool, async (c) => {
      await c.query(
        `INSERT INTO app_user (username, password_hash, full_name, role, dept, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (username) DO UPDATE SET
           password_hash = COALESCE(EXCLUDED.password_hash, app_user.password_hash),
           full_name = EXCLUDED.full_name, role = EXCLUDED.role, dept = EXCLUDED.dept,
           status = EXCLUDED.status, updated_at = now()`,
        [u.username, hash, u.fullName || null, role, u.dept || null, u.status || null],
      )
      await audit(c, { deviceId: deviceOf(req), app: 'V4', actor: req.user.username, action: 'USER_SAVE', entityType: 'app_user',
        entityId: u.username, detail: { role, status: u.status } })
    })
    return { ok: true, username: u.username }
  })
}
