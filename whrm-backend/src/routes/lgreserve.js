// งานจ่ายผ่านขนส่ง: กันยอด + ตัดสต็อกครั้งเดียว (ตัดสินใจ 14 พ.ย. แบบ ก)
//   WH13 (ผ่าน bridge) แจ้งยอดที่กันไว้ของแต่ละใบงาน LG · ตอน LG02 รับงาน เครื่องที่ "ขอสิทธิ์ตัด" ได้เท่านั้นที่ตัด
//   ตัวคำนวณ / ตัวตัดสต็อกยังเป็นของ WH13 (ไม่เขียนซ้ำที่ server)
import { withTx } from '../db.js'
import { audit } from '../weighing.js'

const LG_RE = /^[\w.\-/]{3,60}$/
const STALE_MS = 3 * 60 * 1000   // เครื่องที่ขอสิทธิ์ตัดแล้วหายไป (ปิดหน้า / เน็ตหลุด) → เครื่องอื่นขอใหม่ได้หลัง 3 นาที
const bad = (reply, message) => reply.code(400).send({ error: 'VALIDATION_ERROR', message })
const view = (r) => r && { lgNo: r.lg_no, raNo: r.ra_no, ioNo: r.io_no, lines: r.lines, status: r.status, createdBy: r.created_by, createdAt: r.created_at,
  claimedBy: r.claimed_by, claimedAt: r.claimed_at, doneAt: r.done_at, note: r.note }

function cleanLines(lines) {
  if (!Array.isArray(lines)) return null
  const out = []
  for (const l of lines) {
    const qty = Number(l && l.qty)
    const wh = String(l?.wh || '').trim(), code = String(l?.code || '').trim(), lot = String(l?.lot || '').trim()
    if (!wh || !code || !Number.isFinite(qty) || qty <= 0) continue
    out.push({ wh, code, lot, qty, name: String(l?.name || '').slice(0, 200) })
  }
  return out
}

export default async function lgReserveRoutes(app, { pool }) {
  const who = (req) => (req.user && req.user.username) || 'unknown'

  // ยอดที่กันอยู่ (RESERVED) + ที่กำลังตัด (CUTTING) — หน้า WH13 อ่านไปหักจากยอดคงเหลือตอนตรวจจ่าย · ?all=1 = ทั้งหมด (ดูย้อนหลัง)
  app.get('/lg-reservations', async (req) => {
    const all = String(req.query?.all || '') === '1'
    const { rows } = await pool.query(`SELECT * FROM lg_reservation ${all ? '' : "WHERE status IN ('RESERVED', 'CUTTING')"} ORDER BY created_at DESC LIMIT 2000`)
    return { reservations: rows.map(view) }
  })

  // คลังอนุมัติส่งขนส่ง → กันยอด (ส่งซ้ำได้ · แก้รายการได้เฉพาะตอนยังกันอยู่ · ใบที่จบแล้วไม่ถูกเปิดใหม่)
  app.put('/lg-reservations/:lgNo', async (req, reply) => {
    const lgNo = String(req.params.lgNo || '')
    if (!LG_RE.test(lgNo)) return bad(reply, 'เลขใบงาน LG ไม่ถูกต้อง')
    const raNo = String(req.body?.raNo || '').trim()
    if (!raNo) return bad(reply, 'ต้องมีเลข RA')
    const lines = cleanLines(req.body?.lines)
    if (!lines) return bad(reply, 'lines ต้องเป็น array')
    const ioNo = String(req.body?.ioNo || '').trim() || null
    const row = await withTx(pool, async (c) => {
      const { rows: [cur] } = await c.query('SELECT * FROM lg_reservation WHERE lg_no = $1 FOR UPDATE', [lgNo])
      if (cur && cur.status !== 'RESERVED') return cur
      if (cur && cur.ra_no === raNo && JSON.stringify(cur.lines) === JSON.stringify(lines)) return cur
      const { rows: [r] } = await c.query(
        `INSERT INTO lg_reservation (lg_no, ra_no, io_no, lines, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lg_no) DO UPDATE SET ra_no = EXCLUDED.ra_no, io_no = COALESCE(EXCLUDED.io_no, lg_reservation.io_no), lines = EXCLUDED.lines, updated_at = now()
         RETURNING *`, [lgNo, raNo, ioNo, JSON.stringify(lines), who(req)])
      await audit(c, { actor: who(req), action: cur ? 'LG_RESERVE_UPDATE' : 'LG_RESERVE', entityType: 'lg_reservation', entityId: lgNo, detail: { raNo, ioNo, lines } })
      return r
    })
    return view(row)
  })

  // LG02 รับงาน → ขอสิทธิ์ตัด · ได้ = ตัดได้ (เครื่องเดียว) · ไม่ได้ = มีเครื่องอื่นกำลังตัด / ตัดไปแล้ว / ปล่อยยอดแล้ว
  app.post('/lg-reservations/:lgNo/claim', async (req, reply) => {
    const lgNo = String(req.params.lgNo || '')
    if (!LG_RE.test(lgNo)) return bad(reply, 'เลขใบงาน LG ไม่ถูกต้อง')
    const raNo = String(req.body?.raNo || '').trim() || '-'
    const by = who(req) + ' · ' + String(req.body?.device || '-').slice(0, 60)
    return withTx(pool, async (c) => {
      // ใบที่ค้างตั้งแต่ก่อนอัปเดต (ยังไม่มีแถว) → สร้างแถวแล้วขอสิทธิ์เลย
      await c.query(`INSERT INTO lg_reservation (lg_no, ra_no, status, created_by, note) VALUES ($1, $2, 'RESERVED', $3, $4)
        ON CONFLICT (lg_no) DO NOTHING`, [lgNo, raNo, who(req), 'สร้างตอนขอสิทธิ์ตัด (ใบค้างก่อนอัปเดต)'])
      const { rows: [cur] } = await c.query('SELECT * FROM lg_reservation WHERE lg_no = $1 FOR UPDATE', [lgNo])
      const stale = cur.status === 'CUTTING' && (!cur.claimed_at || Date.now() - new Date(cur.claimed_at).getTime() > STALE_MS)
      const mine = cur.status === 'CUTTING' && cur.claimed_by === by
      if (cur.status === 'RESERVED' || stale || mine) {
        const { rows: [r] } = await c.query(`UPDATE lg_reservation SET status = 'CUTTING', claimed_by = $2, claimed_at = now(), updated_at = now() WHERE lg_no = $1 RETURNING *`, [lgNo, by])
        if (!mine) await audit(c, { actor: who(req), action: 'LG_CUT_CLAIM', entityType: 'lg_reservation', entityId: lgNo, detail: { by, takeoverFrom: stale ? cur.claimed_by : undefined } })
        return { granted: true, reservation: view(r) }
      }
      return { granted: false, state: cur.status, by: cur.claimed_by, reservation: view(cur) }
    })
  })

  // ผลการตัด: CUT = ตัดเสร็จ · RELEASED = ไม่ตัด ปล่อยยอด (LG02 ปฏิเสธ / สต็อกไม่พอ / คลังยกเลิก) · RETRY = ตัดไม่สำเร็จ กลับไปกันยอดรอตัดใหม่
  app.post('/lg-reservations/:lgNo/finish', async (req, reply) => {
    const lgNo = String(req.params.lgNo || '')
    if (!LG_RE.test(lgNo)) return bad(reply, 'เลขใบงาน LG ไม่ถูกต้อง')
    const result = String(req.body?.result || '').toUpperCase()
    if (!['CUT', 'RELEASED', 'RETRY'].includes(result)) return bad(reply, 'result ต้องเป็น CUT, RELEASED หรือ RETRY')
    const note = String(req.body?.note || '').slice(0, 500) || null
    return withTx(pool, async (c) => {
      const { rows: [cur] } = await c.query('SELECT * FROM lg_reservation WHERE lg_no = $1 FOR UPDATE', [lgNo])
      if (!cur) {
        if (result === 'RETRY') return { ok: true, reservation: null }
        await c.query('INSERT INTO lg_reservation (lg_no, ra_no, status, created_by, done_at, note) VALUES ($1, $2, $3, $4, now(), $5)',
          [lgNo, String(req.body?.raNo || '-'), result, who(req), note])
      } else if (cur.status === 'CUT' && result !== 'CUT') {
        return reply.code(409).send({ error: 'ALREADY_CUT', message: `${lgNo} ตัดสต็อกไปแล้ว` })
      } else if (cur.status === 'RELEASED' && result === 'RETRY') {
        return { ok: true, reservation: view(cur) }
      } else {
        const st = result === 'RETRY' ? 'RESERVED' : result
        if (cur.status === st) return { ok: true, reservation: view(cur) }
        await c.query(`UPDATE lg_reservation SET status = $2, note = COALESCE($3, note),
            done_at = CASE WHEN $2 IN ('CUT', 'RELEASED') THEN now() ELSE NULL END,
            claimed_by = CASE WHEN $2 = 'RESERVED' THEN NULL ELSE claimed_by END,
            claimed_at = CASE WHEN $2 = 'RESERVED' THEN NULL ELSE claimed_at END, updated_at = now()
          WHERE lg_no = $1`, [lgNo, st, note])
      }
      await audit(c, { actor: who(req), action: 'LG_CUT_' + result, entityType: 'lg_reservation', entityId: lgNo, detail: { note } })
      const { rows: [r] } = await c.query('SELECT * FROM lg_reservation WHERE lg_no = $1', [lgNo])
      return { ok: true, reservation: view(r) }
    })
  })
}
