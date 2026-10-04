// ยกเลิก RU ข้ามเครื่อง (ตาม return-system-erd ของลูกค้า)
//
// WH13 (1790951454) ยกเลิกด้วย rmaCancelSession(): ลบออกจากคิว + เขียน audit RMA_CANCELLED ลง whrm_rma_audit_v1
// แต่ยังไม่ส่งข้อความให้ V4 — server จึงส่ง RMA_CANCEL_RU แทน
// V4 (__v4CancelListenerV2) ล้างข้อมูล RU + blacklist → ตอบ RMA_CANCEL_RU_DONE → WH13 แสดงป้าย "V4 ล้างแล้ว"
// ถ้าตอนยกเลิกไม่มี V4 ออนไลน์ ส่งซ้ำให้ V4 ที่ต่อเข้ามาภายหลัง (ภายใน 24 ชม. จนกว่าจะได้ DONE)

import { audit } from './weighing.js'

export const RMA_AUDIT_KEY = 'whrm_rma_audit_v1'
const FRESH_MS = 60 * 60 * 1000 // ยกเลิกที่เก่ากว่า 1 ชม. = ประวัติเดิมที่ sync ขึ้นมาครั้งแรก ไม่ส่ง

function parseList(v) {
  try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : [] } catch { return [] }
}
const entryKey = (e) => `${e.at}|${e.ruNo}|${e.action}`

export function createRuCancel({ pool, log }) {
  let bus = null

  function cancelMessage(row) {
    return {
      type: 'RMA_CANCEL_RU', version: 1, source: 'WH-RM-SERVER', timestamp: new Date().toISOString(),
      payload: { ruNo: row.ru_no, rmaNo: row.rma_no || null, cancelledBy: row.cancelled_by || '?', items: [] },
    }
  }

  async function send(row) {
    const data = cancelMessage(row)
    const msgId = `rucancel:${row.ru_no}:${row.send_count + 1}`
    const { rows } = await pool.query(
      `INSERT INTO bus_message (msg_id, channel, type, source, device_id, payload)
       VALUES ($1,'whrm-bus',$2,$3,NULL,$4) ON CONFLICT (msg_id) DO NOTHING RETURNING seq`,
      [msgId, data.type, data.source, JSON.stringify(data)],
    )
    await pool.query('UPDATE ru_cancel SET sent_at = now(), send_count = send_count + 1 WHERE ru_no = $1', [row.ru_no])
    bus.broadcast({ kind: 'bus', channel: 'whrm-bus', msgId, seq: rows[0] ? Number(rows[0].seq) : undefined, data })
    log.info({ ruNo: row.ru_no }, 'RMA_CANCEL_RU sent')
  }

  // เรียกหลัง PUT /sync/kv/:key commit แล้ว
  async function onKvWrite(key, oldValue, newValue, deviceId) {
    if (key !== RMA_AUDIT_KEY || newValue == null) return
    const before = new Set(parseList(oldValue).map(entryKey))
    const now = Date.now()
    const fresh = parseList(newValue).filter((e) =>
      e && e.action === 'RMA_CANCELLED' && e.ruNo && !before.has(entryKey(e)) &&
      now - Date.parse(e.at || 0) < FRESH_MS)
    for (const e of fresh) {
      const { rows } = await pool.query(
        `INSERT INTO ru_cancel (ru_no, cancelled_by, cancelled_at, source_device)
         VALUES ($1,$2,$3,$4) ON CONFLICT (ru_no) DO NOTHING RETURNING *`,
        [String(e.ruNo), e.by || null, e.at, deviceId],
      )
      if (!rows.length) continue // ยกเลิกไปแล้วก่อนหน้า
      await audit(pool, { deviceId, app: 'WH13', actor: e.by, action: 'RU_CANCELLED', entityType: 'return_request', entityId: String(e.ruNo) })
      await send(rows[0])
    }
  }

  // V4 ตอบกลับ
  async function onDone(data, deviceId) {
    const p = data?.payload || {}
    if (!p.ruNo) return
    const { rowCount } = await pool.query(
      `UPDATE ru_cancel SET done_at = COALESCE(done_at, now()), done_device = COALESCE(done_device, $2), rma_no = COALESCE(rma_no, $3)
       WHERE ru_no = $1`,
      [String(p.ruNo), deviceId, p.rmaNo || null],
    )
    await audit(pool, { deviceId, app: 'V4', action: 'RU_CANCEL_DONE', entityType: 'return_request', entityId: String(p.ruNo), detail: { known: rowCount > 0 } })
  }

  // V4 เพิ่งต่อเข้ามา → ส่งงานยกเลิกที่ยังไม่มีใครตอบ (V4 ข้ามเองถ้า blacklist แล้ว)
  async function resendPending(sendToConn) {
    const { rows } = await pool.query(
      `SELECT * FROM ru_cancel WHERE done_at IS NULL AND cancelled_at > now() - interval '24 hours' ORDER BY cancelled_at`,
    )
    for (const row of rows) {
      await pool.query('UPDATE ru_cancel SET sent_at = now(), send_count = send_count + 1 WHERE ru_no = $1', [row.ru_no])
      sendToConn({ kind: 'bus', channel: 'whrm-bus', msgId: `rucancel:${row.ru_no}:resend:${Date.now()}`, data: cancelMessage(row), replay: true })
    }
    return rows.length
  }

  return { attachBus: (b) => { bus = b }, onKvWrite, onDone, resendPending }
}
