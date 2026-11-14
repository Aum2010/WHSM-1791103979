#!/usr/bin/env node
// แปลงเลขเอกสารเก่าเป็นรูปแบบมาตรฐาน (PREFIX 3 ตัว + YYYYMMDD + ลำดับ 4 หลัก) ครั้งเดียวที่ DB — ตัดสินใจ 14 พ.ย.
//
//   node scripts/migrate-docids.mjs              ตรวจอย่างเดียว (ไม่เขียน) · พิมพ์รายงาน
//   node scripts/migrate-docids.mjs --apply      แปลงจริง (transaction เดียว · ล็อกตารางระหว่างทำ · สำรองค่าเดิมทุกแถว)
//   node scripts/migrate-docids.mjs --rollback   คืนค่าเดิมของการแปลงครั้งล่าสุด
//   ตัวเลือก: --json <ไฟล์>  เขียนรายงานเต็ม (แผนที่เลข + key ที่เปลี่ยน) · --by <ชื่อ>  ผู้รัน (ค่าเริ่มต้น = ชื่อผู้ใช้เครื่อง)
//   ใช้ DATABASE_URL ตัวเดียวกับ backend · ต้องเปิด backend เวอร์ชันนี้มาแล้วอย่างน้อยครั้งหนึ่ง (migration 012)
//
// กติกาแปลง = DOC ID STANDARD v1.2.0 ของลูกค้า (WH13 / V4 · __docIdStd.mapExact + rewriteDeep) ไม่คิดใหม่ ยกเว้น:
//   ใบสั่งจ่าย SO-YYYYMMDD-NNN → SOA (ลูกค้าใช้ SBO · ตัดสินใจ 14 พ.ย.: SBO = คำสั่งซื้อ BD02 เท่านั้น)
//   ลำดับของเลขที่ต้องออกใหม่ (TRF-<ms> · FGA-<ms> · PQ / WMS · TRF ddmmyyyy · IO-SO-<n>) ต่อจากตัวนับกลาง (doc_seq) + ตัวนับหน้าเว็บ (__idseq_*)
//     + เลขมาตรฐานที่มีอยู่แล้วในข้อมูล → ไม่ชนกับเลขที่ออกไปแล้ว · เรียงตามเวลาจริงก่อนออกเลข
//   แผนที่เดิมของหน้าเว็บ (whrm_idmap_v1) ใช้ต่อ → เลขที่หน้าเว็บเคยแปลงไว้แล้วได้ผลเดิม
// แปลง: kv_store (whrm_* / WMS-*) · doc_store (เลขใบ + เนื้อใน) · weighing_report / weighing_item · sbo_order / sbo_handoff / quotation (data) · ru_cancel.rma_no
// ไม่แตะ: ประวัติ (audit_log · kv_history · doc_history · bus_message) — ตรวจย้อนหลังด้วยเลขเดิมได้ + แผนที่ใน docid_map
import os from 'node:os'
import fs from 'node:fs'
import pg from 'pg'

process.env.TZ = process.env.TZ || 'Asia/Bangkok'   // วันที่จาก timestamp ต้องตรงกับหน้าเว็บ (เครื่องในไทย)

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const MODE = has('--rollback') ? 'rollback' : has('--apply') ? 'apply' : 'dry'
const BY = opt('--by') || os.userInfo().username
const JSON_OUT = opt('--json')
const DB = process.env.DATABASE_URL
if (!DB) { console.error('ต้องตั้ง DATABASE_URL'); process.exit(2) }

/* ═══ กติกาแปลง (ยกจาก DOC_ID_STD_CORE v1.2.0 ของ WH13) ═══ */
const p2 = (n) => (n < 10 ? '0' + n : '' + n)
const pad4 = (n) => String(n).padStart(4, '0')
const ymdOf = (d) => d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())   // ตามเวลาเครื่อง (ตั้ง TZ=Asia/Bangkok ให้เหมือนหน้าเว็บ)
const validYmd = (y, m, d) => +y >= 2000 && +y <= 2099 && +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31
const STD = /^[A-Z]{3}\d{12}$/
const PFX = { IO: 'IOR', SO: 'SOA', RA: 'RAA', EO: 'EOA', MR: 'MRA', RMA: 'RMA' }
const TSP = { TRF: 'TRF', FGA: 'FGA', PQ: 'PRQ', WMS: 'WMS' }

const idmap = {}              // เลขเก่า → เลขใหม่ (เฉพาะตระกูลที่ต้องออกเลข · เริ่มจาก whrm_idmap_v1)
const seq = {}                // PREFIX+YMD → ลำดับล่าสุด
const used = new Map()        // เลขเก่า → { new, rule } ที่พบจริงในการรันครั้งนี้
let todayYmd = ymdOf(new Date())

function nextSeq(prefix, ymd) { const k = prefix + ymd; seq[k] = (seq[k] || 0) + 1; return seq[k] }
function bumpSeq(prefix, ymd, n) { const k = prefix + ymd; if (n > (seq[k] || 0)) seq[k] = n }
function mapped(legacy, make) { if (!idmap[legacy]) idmap[legacy] = make(); return idmap[legacy] }

function mapExactRaw(id, newOnly) {
  if (typeof id !== 'string') return null
  const n = id.length
  if (n < 9 || n > 40) return null
  const c0 = id.charCodeAt(0)
  if (c0 < 65 || c0 > 90) return null
  if (STD.test(id)) return null
  let m
  m = /^(TRF|FGA|PQ|WMS)-(\d{13})(?:-[A-Za-z0-9]{1,8})?$/.exec(id)
  if (m) { const tp = TSP[m[1]]; return [mapped(id, () => { const ymd = ymdOf(new Date(parseInt(m[2], 10))); return tp + ymd + pad4(nextSeq(tp, ymd)) }), m[1] + '-<ms>'] }
  m = /^(ROO|REE|ISU|PRP|UNK)(\d{8})-(\d{4})$/.exec(id)
  if (m) return [m[1] + m[2] + m[3], m[1] + 'YYYYMMDD-NNNN']
  m = /^(?:ISU|RMA)-([A-Z]{2,4}-?[A-Z0-9-]{6,30})$/.exec(id)
  if (m) {
    const inner = STD.test(m[1]) ? m[1] : (mapExactRaw(m[1], newOnly) || [])[0]
    if (inner && STD.test(inner)) return [inner, 'ISU/RMA-<เลขต้นทาง>']
  }
  m = /^TRF(\d{2})(\d{2})(\d{4})-(\d{1,4})$/.exec(id)
  if (m && validYmd(m[3], m[2], m[1])) return [mapped(id, () => { const ymd = m[3] + m[2] + m[1]; return 'TRF' + ymd + pad4(nextSeq('TRF', ymd)) }), 'TRFddmmyyyy-N']
  m = /^DEV(\d{2})(\d{2})(\d{4})-(\d{1,4})$/.exec(id)
  if (m && validYmd(m[3], m[2], m[1])) {
    return [mapped(id, () => { const ymd = m[3] + m[2] + m[1], k = parseInt(m[4], 10) || 0; bumpSeq('DEV', ymd, k); return 'DEV' + ymd + pad4(k || nextSeq('DEV', ymd)) }), 'DEVddmmyyyy-N']
  }
  m = /^TXN-(\d{8})-(\d{1,4})$/.exec(id)
  if (m) return ['TXN' + m[1] + pad4(parseInt(m[2], 10)), 'TXN-YYYYMMDD-N']
  if (newOnly) return null
  m = /^(IO|SO|RA|EO|MR|RMA)-(\d{8})-(\d{1,4})$/.exec(id)
  if (m) return [PFX[m[1]] + m[2] + pad4(parseInt(m[3], 10)), m[1] + '-YYYYMMDD-N']
  if (/^IO-SO-\d+$/.test(id)) return [mapped(id, () => 'ISO' + todayYmd + pad4(nextSeq('ISO', todayYmd))), 'IO-SO-<n>']
  m = /^PL-REQ-(\d{8})-(\d{1,4})$/.exec(id)
  if (m) return ['PLN' + m[1] + pad4(parseInt(m[2], 10)), 'PL-REQ-YYYYMMDD-N']
  m = /^PL(\d{2})(\d{2})(\d{4})(\d{1,4})$/.exec(id)
  if (m && validYmd(m[3], m[2], m[1])) return ['PLN' + m[3] + m[2] + m[1] + pad4(parseInt(m[4], 10)), 'PLddmmyyyyN']
  m = /^RO(\d{8})(\d{1,4})$/.exec(id)
  if (m) return ['ROA' + m[1] + pad4(parseInt(m[2], 10)), 'ROYYYYMMDDN']
  m = /^FGT(\d{2})(\d{2})(\d{4})-(\d{1,4})$/.exec(id)
  if (m && validYmd(m[3], m[2], m[1])) return ['FGT' + m[3] + m[2] + m[1] + pad4(parseInt(m[4], 10)), 'FGTddmmyyyy-N']
  m = /^FGT-(\d{2})(\d{2})(\d{2})-(\d{1,4})$/.exec(id)
  if (m && validYmd('20' + m[1], m[2], m[3])) return ['FGT20' + m[1] + m[2] + m[3] + pad4(parseInt(m[4], 10)), 'FGT-yymmdd-N']
  return null
}
function mapExact(id, newOnly) {
  const r = mapExactRaw(id, newOnly)
  if (!r) return null
  if (!used.has(id)) used.set(id, { new: r[0], rule: r[1] })
  return r[0]
}
const EMB = /\b(?:TRF|FGA|PQ|WMS)-\d{13}(?:-[A-Za-z0-9]{1,8})?(?![A-Za-z0-9])|\bTXN-\d{8}-\d{1,4}(?!\d)|\bTRF\d{8}-\d{1,4}(?!\d)|\bDEV\d{8}-\d{1,4}(?!\d)|\b(?:ROO|REE|ISU|PRP|UNK)\d{8}-\d{4}(?!\d)/g
function mapString(s, newOnly) {
  const x = mapExact(s, newOnly)
  if (x) return x
  if (s.length > 600 || s.length < 12 || s.indexOf('-') < 0) return s
  return s.replace(EMB, (t) => mapExact(t, newOnly) || t)
}
const isLotBatchField = (k) => /(?:lot|batch)/i.test(String(k == null ? '' : k).replace(/\s+/g, ''))
function rewriteDeep(x, depth, parentKey) {
  if (!x || typeof x !== 'object' || depth > 14 || isLotBatchField(parentKey)) return false
  let changed = false
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      if (typeof v === 'string') { const nv = mapString(v, false); if (nv !== v) { x[i] = nv; changed = true } }
      else if (v && typeof v === 'object') { if (rewriteDeep(v, depth + 1, parentKey)) changed = true }
    }
    return changed
  }
  for (const k of Object.keys(x)) {
    const v = x[k]
    if (isLotBatchField(k)) continue
    if (typeof v === 'string') { const nv = mapString(v, false); if (nv !== v) { x[k] = nv; changed = true } }
    else if (v && typeof v === 'object') { if (rewriteDeep(v, depth + 1, k)) changed = true }
    const nk = mapExact(k, false)
    if (nk && !Object.prototype.hasOwnProperty.call(x, nk)) { x[nk] = x[k]; delete x[k]; changed = true }
  }
  return changed
}
// แปลงค่า kv ทั้งก้อน: JSON → rewriteDeep · ข้อความล้วน → mapString
function rewriteValue(raw) {
  if (raw == null || raw.length < 9) return raw
  let obj
  try { obj = JSON.parse(raw) } catch { obj = undefined }
  if (obj && typeof obj === 'object') return rewriteDeep(obj, 0) ? JSON.stringify(obj) : raw
  if (typeof obj === 'string') { const n = mapString(obj, false); return n !== obj ? JSON.stringify(n) : raw }
  return mapString(raw, false)
}
const QUICK = /(?:TRF|FGA|PQ|WMS)-\d{13}|TXN-\d{8}-\d|TRF\d{8}-\d|DEV\d{8}-\d|(?:ROO|REE|ISU|PRP|UNK)\d{8}-\d{4}|(?:ISU|RMA)-[A-Z]{2,4}|(?:IO|SO|RA|EO|MR|RMA)-\d{8}-\d|IO-SO-\d|PL-REQ-\d|"RO\d{9,12}"|"PL\d{11,14}"|FGT\d{8}-\d|FGT-\d{6}-\d/
// เลขที่ต้องออกใหม่: เก็บทั้งหมดก่อน แล้วเรียงตามเวลา (เหมือน sweep ของหน้าเว็บ) → 0001, 0002 … ตรงลำดับจริง
const LEGACY_MS = /\b(TRF|FGA|PQ|WMS)-(\d{13})(?:-[A-Za-z0-9]{1,8})?(?![A-Za-z0-9])/g
const LEGACY_DM = /\bTRF(\d{2})(\d{2})(\d{4})-(\d{1,4})(?!\d)/g
const LEGACY_DEV = /\bDEV(\d{2})(\d{2})(\d{4})-(\d{1,4})(?!\d)/g
const STD_ANY = /(?<![A-Z0-9])(TRF|FGA|PRQ|WMS|ISO|DEV)(\d{8})(\d{4})(?!\d)/g

/* ═══ อ่านข้อมูลทั้งหมด ═══ */
const TABLE_JSON = [   // ตารางอื่นที่มี data jsonb (ไม่เปลี่ยนคีย์หลัก — เป็นเลข SBO / QT อยู่แล้ว)
  { table: 'sbo_order', pk: 'sbo_number', col: 'data' },
  { table: 'sbo_handoff', pk: 'id', col: 'data' },
  { table: 'quotation', pk: 'id', col: 'data' },
]
async function load(c) {
  const kv = (await c.query("SELECT key, value, version FROM kv_store WHERE (key ~ '^(whrm_|WMS-)') AND key <> 'whrm_idmap_v1' ORDER BY key")).rows
  const idmapRow = (await c.query("SELECT value, version FROM kv_store WHERE key = 'whrm_idmap_v1'")).rows[0] || null
  const seqKv = (await c.query("SELECT key, value, version FROM kv_store WHERE key LIKE '\\_\\_idseq\\_%'")).rows
  const docSeq = (await c.query('SELECT scope, last_value FROM doc_seq')).rows
  const docs = (await c.query('SELECT kind, id, data, version FROM doc_store ORDER BY kind, id')).rows
  const reports = (await c.query('SELECT * FROM weighing_report ORDER BY report_id')).rows
  const items = (await c.query('SELECT * FROM weighing_item ORDER BY report_id, id')).rows
  const tables = {}
  for (const t of TABLE_JSON) tables[t.table] = (await c.query(`SELECT ${t.pk} AS pk, ${t.col} AS data FROM ${t.table}`)).rows
  const ru = (await c.query('SELECT ru_no, rma_no FROM ru_cancel')).rows
  return { kv, idmapRow, seqKv, docSeq, docs, reports, items, tables, ru }
}

function plan(d) {
  // 1) แผนที่เดิมของหน้าเว็บ + ตัวนับ
  try { Object.assign(idmap, JSON.parse(d.idmapRow?.value || '{}') || {}) } catch {}
  const idmapBefore = Object.keys(idmap).length
  for (const r of d.seqKv) { const m = /^__idseq_([A-Z]{3})_(\d{8})$/.exec(r.key); if (m) bumpSeq(m[1], m[2], parseInt(r.value, 10) || 0) }
  for (const r of d.docSeq) { const m = /^([A-Z]{3})(\d{8})$/.exec(r.scope); if (m) bumpSeq(m[1], m[2], Number(r.last_value) || 0) }
  for (const v of Object.values(idmap)) { const m = /^([A-Z]{3})(\d{8})(\d{4})$/.exec(String(v)); if (m) bumpSeq(m[1], m[2], parseInt(m[3], 10)) }
  const blobs = [...d.kv.map((r) => r.value || ''), ...d.docs.map((r) => r.id + ' ' + JSON.stringify(r.data)), ...d.reports.map((r) => JSON.stringify(r)), ...d.items.map((r) => JSON.stringify(r.raw || {})),
    ...Object.values(d.tables).flat().map((r) => JSON.stringify(r.data))]
  // เลขมาตรฐานที่มีอยู่แล้วในข้อมูล → ตัวนับต้องเกินเลขนั้น
  const seqBefore = { ...seq }
  for (const b of blobs) { STD_ANY.lastIndex = 0; let m; while ((m = STD_ANY.exec(b))) bumpSeq(m[1], m[2], parseInt(m[3], 10)) }
  // 2) ออกเลขให้ตระกูล timestamp / ddmmyyyy ตามลำดับเวลา
  const ms = {}, dm = {}, dev = {}
  for (const b of blobs) {
    let m
    LEGACY_MS.lastIndex = 0; while ((m = LEGACY_MS.exec(b))) ms[m[0]] = parseInt(m[2], 10)
    LEGACY_DM.lastIndex = 0; while ((m = LEGACY_DM.exec(b))) dm[m[0]] = parseInt(m[3] + m[2] + m[1], 10) * 10000 + parseInt(m[4], 10)
    LEGACY_DEV.lastIndex = 0; while ((m = LEGACY_DEV.exec(b))) dev[m[0]] = parseInt(m[3] + m[2] + m[1], 10) * 10000 + parseInt(m[4], 10)
  }
  Object.keys(dev).sort((a, b) => dev[a] - dev[b]).forEach((id) => mapExact(id))
  Object.keys(dm).sort((a, b) => dm[a] - dm[b]).forEach((id) => mapExact(id))
  Object.keys(ms).sort((a, b) => ms[a] - ms[b]).forEach((id) => mapExact(id))

  // 3) แปลงทุกที่
  const out = { kv: [], docs: [], reports: [], tables: [], ru: [] }
  for (const r of d.kv) {
    if (!r.value || !QUICK.test(r.value)) continue
    const nv = rewriteValue(r.value)
    if (nv !== r.value) out.kv.push({ key: r.key, old: r.value, value: nv, version: r.version })
  }
  for (const r of d.docs) {
    const data = JSON.parse(JSON.stringify(r.data))
    const changed = rewriteDeep(data, 0)
    const newId = mapExact(r.id, false) || r.id
    if (changed || newId !== r.id) out.docs.push({ kind: r.kind, id: r.id, newId, old: r.data, data, version: r.version })
  }
  const itemsBy = {}
  for (const it of d.items) (itemsBy[it.report_id] = itemsBy[it.report_id] || []).push(it)
  for (const r of d.reports) {
    const newId = mapExact(r.report_id, false) || r.report_id
    const trip = r.trip_no ? mapString(r.trip_no, false) : r.trip_no
    const its = (itemsBy[r.report_id] || []).map((it) => { const raw = it.raw ? JSON.parse(JSON.stringify(it.raw)) : it.raw; const ch = raw ? rewriteDeep(raw, 0) : false; return { id: it.id, raw, changed: ch } })
    if (newId !== r.report_id || trip !== r.trip_no || its.some((x) => x.changed)) out.reports.push({ old: r, items: itemsBy[r.report_id] || [], newId, trip, its })
  }
  for (const t of TABLE_JSON) {
    for (const r of d.tables[t.table]) {
      if (!r.data) continue
      const data = JSON.parse(JSON.stringify(r.data))
      if (rewriteDeep(data, 0)) out.tables.push({ table: t.table, col: t.col, pkCol: t.pk, pk: r.pk, old: r.data, data })
    }
  }
  for (const r of d.ru) { const n = r.rma_no ? mapString(r.rma_no, false) : r.rma_no; if (n !== r.rma_no) out.ru.push({ ru_no: r.ru_no, old: r.rma_no, rma_no: n }) }

  // 4) ตรวจเลขชน: เลขเก่าคนละใบ → เลขใหม่เดียวกัน · เลขใหม่ (แบบคำนวณตรง) ตรงกับเลขมาตรฐานที่มีอยู่แล้ว
  const byNew = {}
  for (const [o, v] of used) (byNew[v.new] = byNew[v.new] || []).push(o)
  // Trip No แบบ ISU-<เลขต้นทาง> / RMA-<เลขต้นทาง> ตั้งใจให้ได้เลขต้นทาง → นับเป็นเลขเดียวกัน ไม่ใช่เลขชน
  const canon = (o) => { const m = /^(?:ISU|RMA)-([A-Z]{2,4}-?[A-Z0-9-]{6,30})$/.exec(o); return m ? m[1] : o }
  const collisions = Object.entries(byNew).map(([n, olds]) => ({ new: n, olds, distinct: [...new Set(olds.map(canon))] }))
    .filter((x) => x.distinct.length > 1).map(({ new: n, olds }) => ({ new: n, olds }))
  const existing = new Set()
  for (const b of blobs) { const re = /(?<![A-Z0-9])[A-Z]{3}\d{12}(?!\d)/g; let m; while ((m = re.exec(b))) existing.add(m[0]) }
  const preexisting = [...used].filter(([, v]) => existing.has(v.new)).map(([o, v]) => ({ old: o, new: v.new, rule: v.rule }))
  const docIdClash = out.docs.filter((x) => x.newId !== x.id && d.docs.some((y) => y.kind === x.kind && y.id === x.newId))
  const repIdClash = out.reports.filter((x) => x.newId !== x.old.report_id && d.reports.some((y) => y.report_id === x.newId))
  return { out, collisions, preexisting, docIdClash, repIdClash, idmapBefore, seqBefore }
}

function report(p) {
  const rules = {}
  for (const [, v] of used) rules[v.rule] = (rules[v.rule] || 0) + 1
  const sample = {}
  for (const [o, v] of used) { sample[v.rule] = sample[v.rule] || []; if (sample[v.rule].length < 3) sample[v.rule].push(o + ' → ' + v.new) }
  console.log('\n══ แปลงเลขเอกสารเก่า — ' + (MODE === 'dry' ? 'ตรวจอย่างเดียว (ไม่ได้เขียน)' : 'แปลงจริง') + ' ══')
  console.log('เลขเก่าที่พบ: ' + used.size + ' เลข')
  for (const [r, n] of Object.entries(rules).sort((a, b) => b[1] - a[1])) console.log('  ' + r.padEnd(22) + String(n).padStart(6) + '   เช่น ' + sample[r].join(' · '))
  console.log('ที่จะเปลี่ยน: kv ' + p.out.kv.length + ' key · เอกสาร ' + p.out.docs.length + ' ใบ (เปลี่ยนเลขใบ ' + p.out.docs.filter((x) => x.newId !== x.id).length + ') · ใบชั่ง ' + p.out.reports.length +
    ' · ' + TABLE_JSON.map((t) => t.table + ' ' + p.out.tables.filter((x) => x.table === t.table).length).join(' · ') + ' · ru_cancel ' + p.out.ru.length)
  if (p.out.kv.length) console.log('  kv: ' + p.out.kv.map((x) => x.key).join(', '))
  const seqNew = Object.entries(seq).filter(([k, v]) => v !== (p.seqBefore[k] || 0) && /^(TRF|FGA|PRQ|WMS|ISO|DEV)/.test(k))
  if (seqNew.length) console.log('ตัวนับที่ขยับ: ' + seqNew.map(([k, v]) => k + '=' + v).join(' · '))
  const warn = p.collisions.length + p.docIdClash.length + p.repIdClash.length
  console.log('เลขชน (เลขเก่าคนละเลข → เลขใหม่เดียวกัน): ' + p.collisions.length + (p.collisions.length ? '  ⚠ ' + p.collisions.slice(0, 5).map((c) => c.olds.join(' + ') + ' → ' + c.new).join(' · ') : ''))
  console.log('เลขใบ (doc_store / ใบชั่ง) ชนกับใบที่มีอยู่: ' + (p.docIdClash.length + p.repIdClash.length) + (warn ? '' : ''))
  console.log('เลขใหม่ที่มีอยู่แล้วในข้อมูล (ปกติ = ใบเดียวกันที่บางที่แปลงแล้ว · ตรวจถ้าจำนวนมาก): ' + p.preexisting.length + (p.preexisting.length ? '  เช่น ' + p.preexisting.slice(0, 3).map((x) => x.old + '→' + x.new).join(' · ') : ''))
  return warn
}

/* ═══ เขียน ═══ */
async function putKv(c, key, value, version, by) {
  const v = version + 1
  await c.query('UPDATE kv_store SET value = $2, version = $3, updated_by = $4, updated_at = now() WHERE key = $1', [key, value, v, by])
  await c.query('INSERT INTO kv_history (key, version, value, updated_by) VALUES ($1,$2,$3,$4)', [key, v, value, by])
}
async function upsertKv(c, key, value, by) {
  const { rows: [cur] } = await c.query('SELECT version FROM kv_store WHERE key = $1 FOR UPDATE', [key])
  if (cur) return putKv(c, key, value, cur.version, by)
  await c.query('INSERT INTO kv_store (key, value, version, updated_by) VALUES ($1,$2,1,$3)', [key, value, by])
  await c.query('INSERT INTO kv_history (key, version, value, updated_by) VALUES ($1,1,$2,$3)', [key, value, by])
}

async function apply(c, d, p, runId) {
  const by = 'docid-migration'
  const backup = (src, ref, old) => c.query('INSERT INTO docid_migration_backup (run_id, src, ref, old) VALUES ($1,$2,$3,$4)', [runId, src, ref, JSON.stringify(old)])
  for (const x of p.out.kv) { await backup('kv', x.key, { value: x.old }); await putKv(c, x.key, x.value, x.version, by) }
  for (const x of p.out.docs) {
    await backup('doc', x.kind + '|' + x.id, { data: x.old, version: x.version })
    if (x.newId !== x.id) {
      await c.query('UPDATE doc_store SET id = $3, data = $4, version = version + 1, updated_by = $5, updated_at = now() WHERE kind = $1 AND id = $2', [x.kind, x.id, x.newId, JSON.stringify(x.data), by])
    } else {
      await c.query('UPDATE doc_store SET data = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE kind = $1 AND id = $2', [x.kind, x.id, JSON.stringify(x.data), by])
    }
  }
  for (const x of p.out.reports) {
    await backup('weighing', x.old.report_id, { report: x.old, items: x.items })
    const rid = x.old.report_id
    if (x.newId !== rid) {
      const cols = Object.keys(x.old).filter((k) => k !== 'report_id')
      await c.query(`INSERT INTO weighing_report (report_id, ${cols.join(', ')}) SELECT $2, ${cols.join(', ')} FROM weighing_report WHERE report_id = $1`, [rid, x.newId])
      await c.query('UPDATE weighing_item SET report_id = $2 WHERE report_id = $1', [rid, x.newId])
      await c.query('DELETE FROM weighing_report WHERE report_id = $1', [rid])
    }
    await c.query('UPDATE weighing_report SET trip_no = $2, updated_at = now() WHERE report_id = $1', [x.newId, x.trip])
    for (const it of x.its) if (it.changed) await c.query('UPDATE weighing_item SET raw = $2, updated_at = now() WHERE id = $1', [it.id, JSON.stringify(it.raw)])
  }
  for (const x of p.out.tables) {
    await backup('table:' + x.table, String(x.pk), { data: x.old })
    await c.query(`UPDATE ${x.table} SET ${x.col} = $2 WHERE ${x.pkCol} = $1`, [x.pk, JSON.stringify(x.data)])
  }
  for (const x of p.out.ru) { await backup('table:ru_cancel', x.ru_no, { rma_no: x.old }); await c.query('UPDATE ru_cancel SET rma_no = $2 WHERE ru_no = $1', [x.ru_no, x.rma_no]) }

  // แผนที่ของหน้าเว็บ (ใช้แสดงผล / แปลงตอนบันทึก) + ตารางแผนที่ถาวร
  const { rows: [im] } = await c.query("SELECT value FROM kv_store WHERE key = 'whrm_idmap_v1'")
  await backup('kv', 'whrm_idmap_v1', { value: im ? im.value : null })
  await upsertKv(c, 'whrm_idmap_v1', JSON.stringify(idmap), by)
  for (const [o, v] of used) {
    await c.query('INSERT INTO docid_map (old_id, new_id, rule, run_id) VALUES ($1,$2,$3,$4) ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id, rule = EXCLUDED.rule, run_id = EXCLUDED.run_id', [o, v.new, v.rule, runId])
  }
  // ตัวนับ: ตัวนับกลาง (doc_seq) + ตัวนับหน้าเว็บ (__idseq_*) ไม่ต่ำกว่าเลขที่ออกไป
  for (const [k, v] of Object.entries(seq)) {
    const m = /^(TRF|FGA|PRQ|WMS|ISO|DEV)(\d{8})$/.exec(k); if (!m) continue   // เฉพาะตระกูลที่สคริปต์ออกเลขใหม่ (GREATEST = ไม่ลดตัวนับ)
    await c.query('INSERT INTO doc_seq (scope, last_value) VALUES ($1, $2) ON CONFLICT (scope) DO UPDATE SET last_value = GREATEST(doc_seq.last_value, EXCLUDED.last_value)', [k, v])
    const key = '__idseq_' + m[1] + '_' + m[2]
    const { rows: [cur] } = await c.query('SELECT value FROM kv_store WHERE key = $1', [key])
    if (!cur || (parseInt(cur.value, 10) || 0) < v) { await backup('kv', key, { value: cur ? cur.value : null }); await upsertKv(c, key, String(v), by) }
  }
}

async function rollback(c) {
  const { rows: [run] } = await c.query("SELECT * FROM docid_migration_run WHERE status = 'APPLIED' ORDER BY id DESC LIMIT 1")
  if (!run) { console.log('ไม่มีการแปลงที่คืนค่าได้'); return }
  const { rows } = await c.query('SELECT * FROM docid_migration_backup WHERE run_id = $1', [run.id])
  const by = 'docid-rollback'
  let n = 0
  for (const b of rows) {
    // แผนที่ของหน้าเว็บคงไว้ (ไม่มีผลกับข้อมูล) → ถ้าแปลงอีกครั้ง เลขที่ต้องออกใหม่ได้เลขเดิม · ตัวนับก็ไม่ลด (กันเลขซ้ำ)
    if (b.src === 'kv' && (b.ref === 'whrm_idmap_v1' || b.ref.startsWith('__idseq_'))) continue
    if (b.src === 'kv') {
      const { rows: [cur] } = await c.query('SELECT version FROM kv_store WHERE key = $1 FOR UPDATE', [b.ref])
      if (b.old.value == null) { if (cur) await putKv(c, b.ref, null, cur.version, by) } else if (cur) await putKv(c, b.ref, b.old.value, cur.version, by); else await upsertKv(c, b.ref, b.old.value, by)
    } else if (b.src === 'doc') {
      const [kind, id] = [b.ref.slice(0, b.ref.indexOf('|')), b.ref.slice(b.ref.indexOf('|') + 1)]
      const newId = (await c.query('SELECT new_id FROM docid_map WHERE old_id = $1', [id])).rows[0]?.new_id
      const cur = (await c.query('SELECT version FROM doc_store WHERE kind = $1 AND id = ANY($2) ORDER BY version DESC LIMIT 1', [kind, [id, newId].filter(Boolean)])).rows[0]
      await c.query('DELETE FROM doc_store WHERE kind = $1 AND id = ANY($2)', [kind, [id, newId].filter(Boolean)])
      await c.query('INSERT INTO doc_store (kind, id, data, version, updated_by) VALUES ($1,$2,$3,$4,$5)', [kind, id, JSON.stringify(b.old.data), (cur?.version || b.old.version) + 1, by])
    } else if (b.src === 'weighing') {
      const r = b.old.report, newId = (await c.query('SELECT new_id FROM docid_map WHERE old_id = $1', [r.report_id])).rows[0]?.new_id
      const ids = [r.report_id, newId].filter(Boolean)
      await c.query('DELETE FROM weighing_item WHERE report_id = ANY($1)', [ids])
      await c.query('DELETE FROM weighing_report WHERE report_id = ANY($1)', [ids])
      const cols = Object.keys(r)
      await c.query(`INSERT INTO weighing_report (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`, cols.map((k) => r[k]))
      for (const it of b.old.items) { const ic = Object.keys(it); await c.query(`INSERT INTO weighing_item (${ic.join(', ')}) VALUES (${ic.map((_, i) => '$' + (i + 1)).join(', ')})`, ic.map((k) => (k === 'raw' && it[k] ? JSON.stringify(it[k]) : it[k]))) }
    } else if (b.src === 'table:ru_cancel') {
      await c.query('UPDATE ru_cancel SET rma_no = $2 WHERE ru_no = $1', [b.ref, b.old.rma_no])
    } else if (b.src.startsWith('table:')) {
      const t = TABLE_JSON.find((x) => 'table:' + x.table === b.src)
      if (t) await c.query(`UPDATE ${t.table} SET ${t.col} = $2 WHERE ${t.pk} = $1`, [b.ref, JSON.stringify(b.old.data)])
    }
    n++
  }
  await c.query('DELETE FROM docid_map WHERE run_id = $1', [run.id])
  await c.query("UPDATE docid_migration_run SET status = 'ROLLED_BACK', finished_at = now() WHERE id = $1", [run.id])
  console.log('คืนค่าแล้ว ' + n + ' รายการ (การแปลงครั้งที่ ' + run.id + ')')
  console.log('หมายเหตุ: ตัวนับเลขเอกสารไม่ถูกลดกลับ (กันเลขซ้ำกับใบที่ออกไประหว่างนั้น)')
}

/* ═══ main ═══ */
const pool = new pg.Pool({ connectionString: DB, max: 2 })
const c = await pool.connect()
try {
  const { rows: [t] } = await c.query("SELECT to_regclass('docid_migration_run') AS r")
  if (!t.r) throw new Error('ยังไม่มีตาราง docid_migration_* — เปิด backend เวอร์ชันนี้ก่อนหนึ่งครั้ง (migration 012)')
  await c.query('BEGIN')
  if (MODE === 'rollback') {
    await c.query('LOCK TABLE kv_store, doc_store, weighing_report, weighing_item IN EXCLUSIVE MODE')
    await rollback(c)
    await c.query('COMMIT')
  } else {
    if (MODE === 'apply') {
      const { rows: [prev] } = await c.query("SELECT id, finished_at FROM docid_migration_run WHERE status = 'APPLIED' ORDER BY id DESC LIMIT 1")
      if (prev && !has('--again')) throw new Error(`แปลงไปแล้ว (ครั้งที่ ${prev.id} · ${prev.finished_at?.toISOString?.() || ''}) — ถ้าต้องการรันซ้ำจริง ๆ ใส่ --again`)
      // กันหน้าเว็บ / backend เขียนระหว่างแปลง (อ่านได้ตามปกติ)
      await c.query('LOCK TABLE kv_store, doc_store, weighing_report, weighing_item, sbo_order, sbo_handoff, quotation, ru_cancel, doc_seq IN EXCLUSIVE MODE')
    }
    const d = await load(c)
    const p = plan(d)
    const warn = report(p)
    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, JSON.stringify({ mode: MODE, at: new Date().toISOString(), map: Object.fromEntries([...used].map(([o, v]) => [o, v])),
        kv: p.out.kv.map((x) => x.key), docs: p.out.docs.map((x) => ({ kind: x.kind, id: x.id, newId: x.newId })), reports: p.out.reports.map((x) => ({ id: x.old.report_id, newId: x.newId })),
        collisions: p.collisions, docIdClash: p.docIdClash.map((x) => x.id), repIdClash: p.repIdClash.map((x) => x.old.report_id), preexisting: p.preexisting }, null, 2))
      console.log('รายงานเต็ม: ' + JSON_OUT)
    }
    if (MODE === 'dry') { await c.query('ROLLBACK'); console.log('\nยังไม่ได้เขียนอะไร · แปลงจริงด้วย --apply') }
    else {
      if (warn && !has('--force')) throw new Error('พบเลขชน ' + warn + ' รายการ — ตรวจรายงานก่อน (ถ้ายืนยันว่าใช้ได้ ใส่ --force)')
      const { rows: [run] } = await c.query("INSERT INTO docid_migration_run (status, run_by) VALUES ('APPLIED', $1) RETURNING id", [BY])
      await apply(c, d, p, run.id)
      await c.query('UPDATE docid_migration_run SET finished_at = now(), stats = $2 WHERE id = $1', [run.id, JSON.stringify({ ids: used.size, kv: p.out.kv.length, docs: p.out.docs.length, reports: p.out.reports.length, tables: p.out.tables.length, ru: p.out.ru.length })])
      await c.query('COMMIT')
      console.log('\n✅ แปลงเสร็จ (ครั้งที่ ' + run.id + ') · หน้าเว็บที่เปิดใหม่จะได้ข้อมูลเลขใหม่ · คืนค่าได้ด้วย --rollback')
    }
  }
} catch (e) {
  try { await c.query('ROLLBACK') } catch {}
  console.error('\n❌ ' + e.message)
  process.exitCode = 1
} finally {
  c.release(); await pool.end()
}
