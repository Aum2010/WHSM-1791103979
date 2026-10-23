// Build frontend → dist/ (static ล้วน วางบน nginx / static host ไหนก็ได้)
//   ui/**/*.html  ไฟล์ของลูกค้า (ไม่แก้ต้นฉบับ) → แทรก config.js + whrm-bridge.js ไว้ต้น <head>
//                 โฟลเดอร์ย่อยได้ (เช่น ui/Production module/) · ชื่อที่มีเว้นวรรคเปลี่ยนเป็น - ใน URL
//   ui/**/*.js ฯลฯ ไฟล์ประกอบ (library ที่หน้าเว็บโหลดจากเครื่อง) → copy ตามโครงเดิม
//   dist/raw/     ไฟล์เดิมไม่แทรกอะไร (ใช้เทียบเวลาหา bug)
//   pages.json    รายการหน้าเว็บ (หน้ารวมใช้สร้างลิงก์)
//   config.js     apiBase ว่าง = เรียก /api, /bus ผ่าน frontend server (proxy ไป backend) — แนะนำ
//                 API_BASE=http://host:3000 = เรียก backend ตรง (ข้าม origin, ต้องตั้ง CORS ที่ backend)
//
//   DEMO_BOT=1    แสดงปุ่ม 🤖 Demo Bot ใน V4 (กรอก/ชั่งแทนคน — demo เท่านั้น) · container ตั้งทับได้ด้วย env DEMO_BOT
//
//   node scripts/build.mjs                  apiBase ว่าง (ผ่าน proxy)
//   UI_SRC=../1790951454 node scripts/build.mjs   ใช้ไฟล์ UI จากโฟลเดอร์อื่น
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyHotfixes } from './hotfixes.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_SRC = path.resolve(ROOT, process.env.UI_SRC || 'ui')
const DIST = path.join(ROOT, 'dist')
const API_BASE = process.env.API_BASE || ''
const DEMO_BOT = /^(1|true|yes|on)$/i.test(process.env.DEMO_BOT || '')

// บน Vercel ไม่มี proxy /api → ต้องบอก URL ของ backend (Railway) เสมอ
if (process.env.VERCEL && !/^https:\/\//.test(API_BASE)) {
  throw new Error('Vercel: ต้องตั้ง Environment Variable API_BASE = https://<backend>.up.railway.app (ไม่มี / ท้าย)')
}

// prefix = '../' ต่อชั้นของโฟลเดอร์ย่อย → หน้าใน ui/Production module/ ยังหา config.js ที่ root เจอ (ทั้งบน nginx และ Vercel)
export function injectBridge(html, prefix = '', { demoBot = false } = {}) {
  const tags = `<script src="${prefix}config.js"></script><script src="${prefix}whrm-bridge.js"></script>` +
    (demoBot ? `<script src="${prefix}whrm-demo-bot.js" defer></script>` : '')
  const m = html.match(/<head[^>]*>/i)
  if (!m) return tags + html
  const at = m.index + m[0].length
  return html.slice(0, at) + tags + html.slice(at)
}

export function configJs(apiBase, demoBot = false) {
  return `// สร้างโดย build / docker-entrypoint — แก้ค่า apiBase ให้ชี้ไป backend\nwindow.WHRM_CONFIG = ${JSON.stringify({ apiBase, demoBot }, null, 2)};\n`
}

// เว้นวรรคใน URL ต้อง encode (%20) และพังง่ายเวลาพิมพ์/ส่งลิงก์ → ใช้ - แทน
const urlSafe = (rel) => rel.split(path.sep).map((s) => s.trim().replace(/\s+/g, '-')).join('/')

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(base, e.name)
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel]
  })
}

// ไฟล์ของเราเอง — ถ้าลูกค้าส่งชื่อเดียวกันมา ใช้ของเรา
const OURS = new Set(['index.html', 'login.html', 'guide.html', 'users.html', 'user.html', 'config.js', 'whrm-bridge.js', 'whrm-demo-bot.js', 'pages.json'])

fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(path.join(DIST, 'raw'), { recursive: true })

const files = walk(UI_SRC)
const pages = []
for (const rel of files) {
  const out = urlSafe(rel)
  if (OURS.has(out)) { console.warn(`ข้าม ui/${rel.replace(/\\/g, '/')} (ชื่อชนกับไฟล์ของ whrm-frontend)`); continue }
  for (const dir of [DIST, path.join(DIST, 'raw')]) fs.mkdirSync(path.dirname(path.join(dir, out)), { recursive: true })
  if (!/\.html?$/i.test(rel)) {
    fs.copyFileSync(path.join(UI_SRC, rel), path.join(DIST, out))
    fs.copyFileSync(path.join(UI_SRC, rel), path.join(DIST, 'raw', out))
    continue
  }
  const html = fs.readFileSync(path.join(UI_SRC, rel), 'utf8')
  const depth = out.split('/').length - 1
  // ปุ่ม Demo Bot แทรกเฉพาะ V4 (สถานีชั่ง) · แสดงหรือไม่ขึ้นกับ WHRM_CONFIG.demoBot
  fs.writeFileSync(path.join(DIST, out), injectBridge(applyHotfixes(out, html), '../'.repeat(depth), { demoBot: out === 'V4.html' }))
  fs.writeFileSync(path.join(DIST, 'raw', out), html)
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]
  pages.push({ path: out, title: title ? title.trim() : '' })
}
if (!pages.length) throw new Error(`ไม่พบไฟล์ .html ใน ${UI_SRC}`)

fs.copyFileSync(path.join(ROOT, 'src', 'whrm-bridge.js'), path.join(DIST, 'whrm-bridge.js'))
fs.copyFileSync(path.join(ROOT, 'src', 'whrm-demo-bot.js'), path.join(DIST, 'whrm-demo-bot.js'))
fs.copyFileSync(path.join(ROOT, 'src', 'index.html'), path.join(DIST, 'index.html'))
fs.copyFileSync(path.join(ROOT, 'src', 'login.html'), path.join(DIST, 'login.html'))
fs.copyFileSync(path.join(ROOT, 'src', 'guide.html'), path.join(DIST, 'guide.html'))
fs.copyFileSync(path.join(ROOT, 'src', 'users.html'), path.join(DIST, 'users.html'))
// พิมพ์ผิดบ่อย /user.html → /users.html
fs.writeFileSync(path.join(DIST, 'user.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/users.html"><script>location.replace('/users.html')</script><a href="/users.html">ไปหน้าจัดการผู้ใช้</a>`)
fs.writeFileSync(path.join(DIST, 'config.js'), configJs(API_BASE, DEMO_BOT))
fs.writeFileSync(path.join(DIST, 'pages.json'), JSON.stringify(pages, null, 2))

console.log(`built ${pages.map((p) => p.path).join(', ')} from ${path.relative(ROOT, UI_SRC) || '.'} → dist/  (apiBase=${API_BASE || '(same origin → proxy)'} · demoBot=${DEMO_BOT})`)
