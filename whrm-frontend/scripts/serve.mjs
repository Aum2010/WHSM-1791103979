// server สำหรับรันบนเครื่อง (dev) — ทำแบบเดียวกับ nginx ใน Docker:
//   เสิร์ฟ dist/ ที่ PORT (8080) + ส่งต่อ /api/* และ /bus (WebSocket) ไป BACKEND_ORIGIN (http://localhost:3000)
//   timeout สั้น: backend ล่ม → ตอบ 502/504 ทันที หน้าเว็บไม่ค้าง
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const PORT = Number(process.env.PORT || 8080)
const BACKEND = new URL(process.env.BACKEND_ORIGIN || 'http://localhost:3000')
const CONNECT_TIMEOUT_MS = 2000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' }

function sendStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.join(DIST, path.normalize(rel))
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  })
}

function proxyHttp(req, res) {
  const up = http.request({
    hostname: BACKEND.hostname, port: BACKEND.port || 80, method: req.method, path: req.url,
    headers: { ...req.headers, host: BACKEND.host },
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  const timer = setTimeout(() => up.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
  up.on('socket', (s) => s.once('connect', () => clearTimeout(timer)))
  up.on('error', () => {
    clearTimeout(timer)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'BACKEND_UNAVAILABLE', message: 'ติดต่อ backend ไม่ได้' }))
  })
  req.pipe(up)
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) proxyHttp(req, res)
  else sendStatic(req, res)
})

// WebSocket /bus → backend (ส่ง request เดิมต่อ แล้วต่อท่อสองทาง)
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/bus')) { socket.destroy(); return }
  const up = net.connect(Number(BACKEND.port || 80), BACKEND.hostname)
  up.setTimeout(CONNECT_TIMEOUT_MS, () => up.destroy())
  up.on('connect', () => {
    up.setTimeout(0)
    const headers = Object.entries({ ...req.headers, host: BACKEND.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head && head.length) up.write(head)
    up.pipe(socket); socket.pipe(up)
  })
  up.on('error', () => socket.destroy())
  up.on('close', () => socket.destroy())
  socket.on('error', () => up.destroy())
})

server.listen(PORT, () => console.log(`whrm-frontend → http://localhost:${PORT}  (dist/ · /api, /bus → ${BACKEND.origin})`))
