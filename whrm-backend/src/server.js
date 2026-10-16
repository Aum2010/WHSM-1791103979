import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { createPool, migrate, waitForDb } from './db.js'
import { createBus } from './bus.js'
import { createRuCancel } from './rucancel.js'
import { createAuth } from './auth.js'
import syncRoutes from './routes/sync.js'
import v4Routes from './routes/v4.js'
import queryRoutes from './routes/query.js'

const VERSION = '0.6.0-phaseA'
const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://whrm:whrm_dev_pw@localhost:5433/whrm'
// frontend อยู่คนละ origin — คั่นด้วย , · รองรับ * ในชื่อ host เช่น https://*.vercel.app (preview ของ Vercel)
// '*' ตัวเดียว = อนุญาตทุก origin (dev เท่านั้น)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map((s) => s.trim()).filter(Boolean)
const CORS_MATCHERS = CORS_ORIGINS.map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^./]+') + '$', 'i'))
const corsAllowed = (origin) => !origin || CORS_ORIGINS.includes('*') || CORS_MATCHERS.some((re) => re.test(origin))

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 20 * 1024 * 1024, // ค่า localStorage บาง key (Stock Card) ใหญ่หลาย MB
  genReqId: () => crypto.randomUUID(),
  // อยู่หลัง proxy (Railway edge / nginx ของ frontend) → ใช้ IP + https จาก X-Forwarded-* (lockout, cookie Secure)
  trustProxy: process.env.TRUST_PROXY !== '0',
})

const pool = createPool(DATABASE_URL)
await waitForDb(pool, app.log)
await migrate(pool, app.log)

const auth = createAuth({ pool, log: app.log, ttlHours: Number(process.env.SESSION_TTL_HOURS || 12) })
await auth.seedAdmin({
  username: process.env.WHRM_ADMIN_USER || 'admin',
  password: process.env.WHRM_ADMIN_PASSWORD,
  production: process.env.NODE_ENV === 'production' && !process.env.WHRM_ALLOW_DEFAULT_ADMIN,
})

const ruCancel = createRuCancel({ pool, log: app.log })
const bus = createBus({ pool, log: app.log, ruCancel, auth })
ruCancel.attachBus(bus)

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
  if (status >= 500) req.log.error({ err }, 'request failed')
  reply.code(status).send({
    error: status >= 500 ? 'INTERNAL_ERROR' : err.code || 'BAD_REQUEST',
    message: status >= 500 ? 'เกิดข้อผิดพลาดที่ server' : err.message,
    requestId: req.id,
  })
})

await app.register(cors, {
  origin: (origin, cb) => cb(null, corsAllowed(origin)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'Idempotency-Key'],
  credentials: true,   // cookie (โดเมนเดียวกัน) · ข้ามโดเมนใช้ Authorization: Bearer
  maxAge: 600,
})

await app.register(websocket, { options: { maxPayload: 20 * 1024 * 1024 } })
app.get('/bus', { websocket: true }, bus.handler)

await app.register(async (api) => {
  // ทุก /api/v1/* ต้อง login (ยกเว้น /health, /auth/login)
  api.decorateRequest('user', null)
  api.addHook('onRequest', auth.guard)
  await api.register(auth.routes)
  await api.register(queryRoutes, { pool, bus, version: VERSION })
  await api.register(syncRoutes, { pool, bus, ruCancel })
  await api.register(v4Routes, { pool, auth })
}, { prefix: '/api/v1' })

app.get('/', async () => ({ name: 'whrm-backend', version: VERSION, api: '/api/v1', bus: '/bus', health: '/api/v1/health' }))

const shutdown = async () => {
  app.log.info('shutting down')
  await app.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await app.listen({ port: PORT, host: HOST })
app.log.info(`WH-RM backend ${VERSION} — CORS: ${CORS_ORIGINS.join(', ')}`)
