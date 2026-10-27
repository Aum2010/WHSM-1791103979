// นำไฟล์หน้าเว็บชุดใหม่ของลูกค้าเข้า ui/ — ลบรหัสผ่านจริงก่อนเขียน (hotfix ชนิด security)
//   node scripts/import-ui.mjs <โฟลเดอร์ WH-Test ของลูกค้า> [--dry]
// รับ: *.html / *.js / dbv2.json ชั้นบนสุด + Production module/*.html (ไม่รับ index.html / server / .bat / โฟลเดอร์ Main page)
// ตรวจซ้ำ: เอา PIN จริงจากไฟล์ต้นฉบับ (WHAUTH RAW / BD02 USERS) มาค้นในไฟล์ที่จะเขียนทุกไฟล์ — ยังเจอ = ล้ม ไม่เขียนอะไรเลย
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyHotfixes } from './hotfixes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = path.join(ROOT, 'ui')
const src = process.argv[2]
const dry = process.argv.includes('--dry')
if (!src || !fs.existsSync(src)) { console.error('ใช้: node scripts/import-ui.mjs <โฟลเดอร์ของลูกค้า> [--dry]'); process.exit(1) }

const SKIP = new Set(['index.html'])
const files = []
for (const f of fs.readdirSync(src)) {
  if (SKIP.has(f) || !/\.(html|js)$|^dbv2\.json$/.test(f)) continue
  if (fs.statSync(path.join(src, f)).isFile()) files.push(f)
}
const prod = path.join(src, 'Production module')
if (fs.existsSync(prod)) for (const f of fs.readdirSync(prod)) if (/\.html$/.test(f)) files.push(`Production module/${f}`)

// PIN จริงจากต้นฉบับ (Tom/8888 = บัญชีสาธิตของทีม UI ที่เปิดเผยอยู่แล้ว — ไม่นับ)
const pins = new Set(), pairs = new Map()   // pairs: รหัสบัตร → PIN
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const s = fs.readFileSync(path.join(src, f), 'utf8')
  for (const m of s.matchAll(/var RAW = \[([\s\S]*?)\];/g)) for (const r of m[1].matchAll(/\["([^"]*)",\s*"([^"]*)"/g)) if (r[2] && r[1] !== 'Tom') { pins.add(r[2]); pairs.set(r[1], r[2]) }
  for (const r of s.matchAll(/'(BD\d+)'\s*:\s*\{\s*password\s*:\s*'([^']+)'/g)) { pins.add(r[2]); pairs.set(r[1], r[2]) }
}
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const out = []
for (const f of files) {
  const raw = fs.readFileSync(path.join(src, f), 'utf8')
  const name = path.basename(f)
  const html = f.endsWith('.html') ? applyHotfixes(name, raw, { only: 'security' }) : raw
  const found = (m) => { throw new Error(`[security] ${f}: ยังมี PIN จริง (${m[0].slice(0, 40)}…) — เพิ่ม hotfix ใน scripts/hotfixes.mjs ก่อน`) }
  // ค่ารหัสผ่านในโค้ด (password: '1234')
  for (const pin of pins) {
    const m = new RegExp(`(password|pass|pin|pwd)\\w*['"]?\\s*[:=]\\s*['"]${reEsc(pin)}['"]`, 'i').exec(html)
    if (m) found(m)
  }
  // รหัสบัตรตามด้วย PIN ของคนนั้นใกล้ ๆ (ข้อความช่วยจำ / log เช่น "รหัสบัตร/PIN" ใน console.log)
  for (const [id, pin] of pairs) {
    const m = new RegExp(`(?<![A-Za-z0-9])${reEsc(id)}(?![A-Za-z0-9])[^\\n]{0,24}?(?<![0-9])${reEsc(pin)}(?![0-9])`).exec(html)
    if (m) found(m)
  }
  out.push([f, html, raw.length !== html.length || raw !== html])
}

for (const [f, html, changed] of out) {
  const dest = path.join(UI, f)
  const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null
  const st = prev === null ? 'ใหม่' : prev === html ? 'เหมือนเดิม' : 'แก้'
  console.log(`${st.padEnd(10)} ${f}${changed ? '  (ลบรหัสแล้ว)' : ''}`)
  if (!dry && prev !== html) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, html) }
}
console.log(`ตรวจ PIN จริง ${pins.size} ชุด — ไม่พบในไฟล์ที่นำเข้า${dry ? ' (ทดลอง ไม่ได้เขียน)' : ''}`)
