// Build frontend → dist/ (static ล้วน วางบน nginx / static host ไหนก็ได้)
//   ui/*.html     ไฟล์ของลูกค้า (ไม่แก้ต้นฉบับ) → แทรก config.js + whrm-bridge.js ไว้ต้น <head>
//   dist/raw/     ไฟล์เดิมไม่แทรกอะไร (ใช้เทียบเวลาหา bug)
//   config.js     apiBase ว่าง = เรียก /api, /bus ผ่าน frontend server (proxy ไป backend) — แนะนำ
//                 API_BASE=http://host:3000 = เรียก backend ตรง (ข้าม origin, ต้องตั้ง CORS ที่ backend)
//
//   node scripts/build.mjs                  apiBase ว่าง (ผ่าน proxy)
//   UI_SRC=../1790951454 node scripts/build.mjs   ใช้ไฟล์ UI จากโฟลเดอร์อื่น
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_SRC = path.resolve(ROOT, process.env.UI_SRC || 'ui')
const DIST = path.join(ROOT, 'dist')
const API_BASE = process.env.API_BASE || ''

// บน Vercel ไม่มี proxy /api → ต้องบอก URL ของ backend (Railway) เสมอ
if (process.env.VERCEL && !/^https:\/\//.test(API_BASE)) {
  throw new Error('Vercel: ต้องตั้ง Environment Variable API_BASE = https://<backend>.up.railway.app (ไม่มี / ท้าย)')
}

const TAGS = '<script src="config.js"></script><script src="whrm-bridge.js"></script>'

export function injectBridge(html) {
  const m = html.match(/<head[^>]*>/i)
  if (!m) return TAGS + html
  const at = m.index + m[0].length
  return html.slice(0, at) + TAGS + html.slice(at)
}

export function configJs(apiBase) {
  return `// สร้างโดย build / docker-entrypoint — แก้ค่า apiBase ให้ชี้ไป backend\nwindow.WHRM_CONFIG = ${JSON.stringify({ apiBase }, null, 2)};\n`
}

fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(path.join(DIST, 'raw'), { recursive: true })

const pages = fs.readdirSync(UI_SRC).filter((f) => /\.html$/i.test(f))
if (!pages.length) throw new Error(`ไม่พบไฟล์ .html ใน ${UI_SRC}`)
for (const f of pages) {
  const html = fs.readFileSync(path.join(UI_SRC, f), 'utf8')
  fs.writeFileSync(path.join(DIST, f), injectBridge(html))
  fs.writeFileSync(path.join(DIST, 'raw', f), html)
}
fs.copyFileSync(path.join(ROOT, 'src', 'whrm-bridge.js'), path.join(DIST, 'whrm-bridge.js'))
fs.copyFileSync(path.join(ROOT, 'src', 'index.html'), path.join(DIST, 'index.html'))
fs.copyFileSync(path.join(ROOT, 'src', 'login.html'), path.join(DIST, 'login.html'))
fs.writeFileSync(path.join(DIST, 'config.js'), configJs(API_BASE))

console.log(`built ${pages.join(', ')} from ${path.relative(ROOT, UI_SRC) || '.'} → dist/  (apiBase=${API_BASE || '(same origin → proxy)'})`)
