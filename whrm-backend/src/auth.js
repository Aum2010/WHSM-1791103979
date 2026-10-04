// Login ระดับระบบ
//   - ผู้ใช้อยู่ใน app_user (รหัสผ่าน scrypt) · session = token สุ่มใน cookie HttpOnly (DB เก็บแค่ sha256)
//   - ทุก /api/v1/* ต้อง login ยกเว้น PUBLIC_PATHS · WebSocket /bus ตรวจ cookie ตอนต่อ
//   - รับ Authorization: Bearer <token> ด้วย (สำหรับ script / client ที่ไม่ใช่ browser)
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { audit } from './weighing.js'

const scrypt = promisify(crypto.scrypt)

export const COOKIE = 'whrm_session'
export const ROLES = ['ADMIN', 'WH_SUPERVISOR', 'WH_STAFF', 'QA', 'WEIGH_OPERATOR', 'PRODUCTION']
const PUBLIC_PATHS = new Set(['/api/v1/health', '/api/v1/auth/login'])
const MAX_FAILS = 5
const LOCK_MS = 5 * 60 * 1000

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(String(password), salt, 32)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, keyHex] = String(stored || '').split('$')
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), 32)
  const expected = Buffer.from(keyHex, 'hex')
  return expected.length === key.length && crypto.timingSafeEqual(expected, key)
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

export function parseCookies(header) {
  const out = {}
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=')
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim())
  })
  return out
}

function tokenOf(req) {
  const h = req.headers.authorization || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return parseCookies(req.headers.cookie)[COOKIE] || null
}

// WebSocket จาก browser ใส่ header Authorization ไม่ได้ → รับ ?token= เฉพาะตอนต่อ /bus
// (frontend บน Vercel + backend บน Railway = คนละโดเมน · cookie ข้ามโดเมนถูก browser บล็อก)
function wsTokenOf(req) {
  const t = tokenOf(req)
  if (t) return t
  try { return new URL(req.url, 'http://x').searchParams.get('token') || null } catch { return null }
}

// ผู้ใช้ภายนอกที่ระบบเห็นได้ (ไม่มี password_hash)
const publicUser = (u) => u && ({ username: u.username, fullName: u.full_name, role: u.role, dept: u.dept, status: u.status })

export function createAuth({ pool, log, ttlHours = 12 }) {
  const TTL_MS = ttlHours * 3600 * 1000
  const fails = new Map() // `${username}|${ip}` → { count, until }

  async function lookup(token) {
    if (!token) return null
    const { rows } = await pool.query(
      `SELECT s.token_hash, s.expires_at, u.* FROM auth_session s JOIN app_user u ON u.username = s.username
       WHERE s.token_hash = $1 AND s.expires_at > now() AND COALESCE(u.status, 'active') = 'active'`,
      [sha256(token)],
    )
    const r = rows[0]
    if (!r) return null
    // ต่ออายุแบบเลื่อน (ใช้งานอยู่ = ไม่หลุด) — อัปเดตเมื่อเหลือไม่ถึงครึ่ง
    if (new Date(r.expires_at).getTime() - Date.now() < TTL_MS / 2) {
      await pool.query('UPDATE auth_session SET expires_at = $2, last_seen_at = now() WHERE token_hash = $1',
        [r.token_hash, new Date(Date.now() + TTL_MS)])
    }
    return publicUser(r)
  }

  function cookieHeader(req, token, maxAgeSec) {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
  }

  // hook: ใส่ใน scope ของ /api/v1
  async function guard(req, reply) {
    const path = req.url.split('?')[0]
    if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(path)) return
    req.user = await lookup(tokenOf(req))
    if (!req.user) return reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'กรุณาเข้าสู่ระบบ' })
  }

  const requireRole = (...roles) => async (req, reply) => {
    if (!req.user || !roles.includes(req.user.role)) {
      await audit(pool, { actor: req.user?.username, action: 'DENIED', entityType: 'route', entityId: req.routeOptions?.url, detail: { need: roles } })
      return reply.code(403).send({ error: 'FORBIDDEN_ROLE', message: `ต้องการสิทธิ์: ${roles.join(', ')}` })
    }
  }

  async function routes(app) {
    app.post('/auth/login', async (req, reply) => {
      const username = String(req.body?.username || '').trim()
      const password = String(req.body?.password || '')
      if (!username || !password) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'กรอกชื่อผู้ใช้และรหัสผ่าน' })
      const key = `${username.toLowerCase()}|${req.ip}`
      const f = fails.get(key)
      if (f && f.until > Date.now()) {
        return reply.code(423).send({ error: 'LOGIN_LOCKED', message: `ใส่รหัสผิดหลายครั้ง — ลองใหม่ใน ${Math.ceil((f.until - Date.now()) / 60000)} นาที` })
      }
      const { rows: [u] } = await pool.query('SELECT * FROM app_user WHERE lower(username) = lower($1)', [username])
      const ok = u && statusOf(u) === 'active' && (await verifyPassword(password, u.password_hash))
      if (!ok) {
        // ล็อกครบเวลาแล้ว → เริ่มนับใหม่ · ยังไม่ถูกล็อก (until = 0) → นับต่อ
        const prev = f && !(f.until && f.until <= Date.now()) ? f.count : 0
        const n = prev + 1
        fails.set(key, { count: n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 })
        await audit(pool, { actor: username, action: 'LOGIN_FAIL', entityType: 'app_user', entityId: username, detail: { ip: req.ip, count: n } })
        return reply.code(401).send({ error: 'AUTH_INVALID', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' })
      }
      fails.delete(key)
      const token = crypto.randomBytes(32).toString('base64url')
      await pool.query(
        `INSERT INTO auth_session (token_hash, username, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
        [sha256(token), u.username, new Date(Date.now() + TTL_MS), req.ip, req.headers['user-agent'] || null],
      )
      await pool.query('UPDATE app_user SET last_login_at = now() WHERE username = $1', [u.username])
      await audit(pool, { actor: u.username, action: 'LOGIN', entityType: 'app_user', entityId: u.username, detail: { ip: req.ip } })
      reply.header('set-cookie', cookieHeader(req, token, Math.floor(TTL_MS / 1000)))
      // browser ใช้ cookie HttpOnly (JS อ่าน token ไม่ได้) · script / client อื่นขอ token ได้ด้วย returnToken: true
      return { user: publicUser(u), expiresInSec: Math.floor(TTL_MS / 1000), ...(req.body?.returnToken ? { token } : {}) }
    })

    app.post('/auth/logout', async (req, reply) => {
      const token = tokenOf(req)
      if (token) await pool.query('DELETE FROM auth_session WHERE token_hash = $1', [sha256(token)])
      await audit(pool, { actor: req.user?.username, action: 'LOGOUT', entityType: 'app_user', entityId: req.user?.username })
      reply.header('set-cookie', cookieHeader(req, '', 0))
      return { ok: true }
    })

    app.get('/auth/me', async (req) => ({ user: req.user, roles: ROLES }))

    app.post('/auth/password', async (req, reply) => {
      const { currentPassword, newPassword } = req.body || {}
      if (!newPassword || String(newPassword).length < 6) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'รหัสผ่านใหม่อย่างน้อย 6 ตัว' })
      const { rows: [u] } = await pool.query('SELECT password_hash FROM app_user WHERE username = $1', [req.user.username])
      if (!(await verifyPassword(currentPassword || '', u?.password_hash))) {
        return reply.code(401).send({ error: 'AUTH_INVALID', message: 'รหัสผ่านเดิมไม่ถูกต้อง' })
      }
      await pool.query('UPDATE app_user SET password_hash = $2, updated_at = now() WHERE username = $1', [req.user.username, await hashPassword(newPassword)])
      await audit(pool, { actor: req.user.username, action: 'PASSWORD_CHANGE', entityType: 'app_user', entityId: req.user.username })
      return { ok: true }
    })

    // ── จัดการผู้ใช้ (ADMIN) ──
    app.get('/auth/users', { preHandler: requireRole('ADMIN') }, async () => {
      const { rows } = await pool.query(
        `SELECT username, full_name, role, dept, status, last_login_at, password_hash IS NOT NULL AS has_password
         FROM app_user ORDER BY username`)
      return rows
    })

    // สร้าง / แก้ไข · password ใส่เมื่อสร้างหรือรีเซ็ต
    app.post('/auth/users', { preHandler: requireRole('ADMIN') }, async (req, reply) => {
      const u = req.body || {}
      const username = String(u.username || '').trim()
      if (!/^[\w.@-]{2,40}$/.test(username)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ชื่อผู้ใช้ 2–40 ตัว (a-z 0-9 . _ - @)' })
      if (u.role && !ROLES.includes(u.role)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `role ต้องเป็น ${ROLES.join(', ')}` })
      if (u.password && String(u.password).length < 6) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'รหัสผ่านอย่างน้อย 6 ตัว' })
      const { rows: [exists] } = await pool.query('SELECT 1 FROM app_user WHERE username = $1', [username])
      if (!exists && !u.password) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'ผู้ใช้ใหม่ต้องมีรหัสผ่าน' })
      if (username === req.user.username && (u.status === 'inactive' || (u.role && u.role !== 'ADMIN'))) {
        return reply.code(409).send({ error: 'INVALID_STATE', message: 'ลดสิทธิ์หรือปิดบัญชีตัวเองไม่ได้' })
      }
      const hash = u.password ? await hashPassword(u.password) : null
      await pool.query(
        `INSERT INTO app_user (username, password_hash, full_name, role, dept, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (username) DO UPDATE SET
           password_hash = COALESCE(EXCLUDED.password_hash, app_user.password_hash),
           full_name = COALESCE(EXCLUDED.full_name, app_user.full_name),
           role = COALESCE(EXCLUDED.role, app_user.role),
           dept = COALESCE(EXCLUDED.dept, app_user.dept),
           status = COALESCE(EXCLUDED.status, app_user.status),
           updated_at = now()`,
        [username, hash, u.fullName || null, u.role || null, u.dept || null, u.status || (exists ? null : 'active')],
      )
      // ปิดบัญชี / รีเซ็ตรหัส → เตะ session เดิมออก
      if (u.status === 'inactive' || (exists && u.password)) await pool.query('DELETE FROM auth_session WHERE username = $1', [username])
      await audit(pool, { actor: req.user.username, action: exists ? 'USER_UPDATE' : 'USER_CREATE', entityType: 'app_user', entityId: username,
        detail: { role: u.role, status: u.status, passwordReset: !!(exists && u.password) } })
      return { ok: true, username }
    })
  }

  // ผู้ดูแลคนแรก — สร้างเมื่อยังไม่มีใครตั้งรหัสผ่านไว้เลย
  async function seedAdmin({ username, password, production }) {
    const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM app_user WHERE password_hash IS NOT NULL AND role = 'ADMIN'")
    if (n > 0) return
    if (!password) {
      if (production) throw new Error('ต้องตั้ง WHRM_ADMIN_PASSWORD เพื่อสร้างผู้ดูแลคนแรก')
      password = 'admin1234'
      log.warn('สร้างผู้ดูแลคนแรกด้วยรหัสผ่านเริ่มต้น (dev) — เปลี่ยนรหัสหลัง login ทันที')
    }
    await pool.query(
      `INSERT INTO app_user (username, password_hash, full_name, role, status) VALUES ($1,$2,'ผู้ดูแลระบบ','ADMIN','active')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'ADMIN', status = 'active'`,
      [username, await hashPassword(password)],
    )
    log.info({ username }, 'seeded first admin user')
  }

  // ลบ session หมดอายุ วันละครั้ง
  const timer = setInterval(() => { pool.query('DELETE FROM auth_session WHERE expires_at < now()').catch(() => {}) }, 24 * 3600 * 1000)
  timer.unref()

  return { guard, requireRole, routes, seedAdmin, lookup, tokenOf, wsTokenOf }
}

function statusOf(u) { return u.status == null ? 'active' : u.status }
