// เลขเอกสารกลาง (UI 13 พ.ย. · DOC-ID-STD) — PREFIX 3 ตัว + YYYYMMDD + ลำดับ 4 หลัก
//   เดิมแต่ละเครื่องนับเอง (__idseq_<PFX>_<YYYYMMDD> ใน localStorage) → สองเครื่องออกพร้อมกันได้เลขซ้ำ
//   หน้าเว็บขอเลขที่นี่ผ่าน bridge (window.__whrmDocNo) · ใช้ตาราง doc_seq เดียวกับเลข SBO
//   เลขแรกของวัน = ต่อจากตัวนับเดิมของหน้าเว็บ (kv: __idseq_* และตัวนับรูปแบบเก่า whrm_<x>_seq_<ymd>) ไม่ชนกับใบที่ออกไปแล้ว
import { withTx } from '../db.js'

const PFX_RE = /^[A-Z]{3}$/
// prefix มาตรฐาน → ตัวนับรูปแบบเก่าของวันเดียวกัน (เลขเก่า IO-20261114-003 → IOR202611140003 ใช้ลำดับเดียวกัน)
const LEGACY_SEQ = { IOR: 'whrm_io_seq_', EOA: 'whrm_eo_seq_', RAA: 'whrm_ra_seq_', RMA: 'whrm_rma_seq_', ROA: 'whrm_ro_seq_', RUA: 'whrm_return_seq_' }
const pad = (n, w) => String(n).padStart(w, '0')
export function bangkokYmd(d = new Date()) {
  const t = new Date(d.getTime() + 7 * 3600 * 1000)
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCDate(), 2)}`
}

export default async function docNumberRoutes(app, { pool }) {
  app.post('/doc-numbers', async (req, reply) => {
    const prefix = String(req.body?.prefix || '').toUpperCase()
    if (!PFX_RE.test(prefix)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'prefix ต้องเป็นตัวอักษร 3 ตัว' })
    const ymd = String(req.body?.ymd || bangkokYmd())
    if (!/^\d{8}$/.test(ymd)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'วันที่ไม่ถูกต้อง' })
    const scope = prefix + ymd
    const n = await withTx(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['docseq|' + scope])
      const { rows: [cur] } = await c.query('SELECT last_value FROM doc_seq WHERE scope = $1', [scope])
      let floor = cur ? cur.last_value : 0
      if (!cur) {
        const keys = ['__idseq_' + prefix + '_' + ymd].concat(LEGACY_SEQ[prefix] ? [LEGACY_SEQ[prefix] + ymd] : [])
        const { rows } = await c.query('SELECT value FROM kv_store WHERE key = ANY($1)', [keys])
        rows.forEach((r) => { const v = parseInt(r.value, 10); if (Number.isFinite(v) && v > floor) floor = v })
      }
      const next = floor + 1
      await c.query(`INSERT INTO doc_seq (scope, last_value) VALUES ($1, $2)
        ON CONFLICT (scope) DO UPDATE SET last_value = GREATEST(doc_seq.last_value + 1, $2)`, [scope, next])
      const { rows: [after] } = await c.query('SELECT last_value FROM doc_seq WHERE scope = $1', [scope])
      return after.last_value
    })
    if (n > 9999) return reply.code(409).send({ error: 'SEQ_EXHAUSTED', message: `เลข ${prefix} ของวันนี้เต็มแล้ว` })
    return { id: prefix + ymd + pad(n, 4), prefix, ymd, seq: n }
  })
}
