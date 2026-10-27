// จัดการผู้ใช้รายส่วน (ผู้ดูแลระบบเท่านั้น) — CRUD ผู้ใช้ · สิทธิ์รายส่วน · template · นำเข้า/ส่งออก CSV · ประวัติ
//   1 คน = 1 แถวใน app_user · สิทธิ์แต่ละส่วนอยู่ใน user_access (ไม่มีแถว = NONE)
//   ลบ = ปิดบัญชีเป็นหลัก · ลบถาวรได้เฉพาะบัญชีที่ไม่เคยใช้งาน (ประวัติ audit ต้องอ้างถึงคนได้ — REQ-S-002)
import { withTx } from '../db.js'
import { audit } from '../weighing.js'
import { hashPassword, ROLES, MODULES, LEVELS, MIN_PASSWORD } from '../auth.js'

const USERNAME_RE = /^[\w.@-]{2,40}$/
const STATUSES = ['active', 'inactive']
const MODULE_LABEL = { WH13: 'คลัง (WH13)', V4: 'ชั่ง (V4)', QA: 'QA', BD02: 'ขาย (BD02)', PRODUCTION: 'ผลิต + วางแผน', DBV2: 'Master (DBV2.0)', LOGISTICS: 'ขนส่ง (LG02)' }
const LEVEL_LABEL = { NONE: '—', VIEW: 'ดู', USE: 'ใช้งาน', APPROVE: 'อนุมัติ', ADMIN: 'ผู้ดูแล' }
const CSV_COLS = ['username', 'full_name', 'dept', 'role', 'card_id', 'status', 'template', ...MODULES]

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
const bad = (message) => new HttpError(400, 'VALIDATION_ERROR', message)

// รับได้ทั้ง { WH13: 'USE' } และ { WH13: { level: 'USE', alias: 'WH-002' } }
function normAccess(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const [m, v] of Object.entries(input)) {
    if (!MODULES.includes(m)) throw bad(`ไม่รู้จักส่วน ${m} (มี ${MODULES.join(', ')})`)
    const level = String((v && typeof v === 'object' ? v.level : v) || 'NONE').toUpperCase()
    if (!LEVELS.includes(level)) throw bad(`ระดับ ${level} ไม่ถูกต้อง (มี ${LEVELS.join(', ')})`)
    const alias = v && typeof v === 'object' && v.alias !== undefined ? (String(v.alias || '').trim() || null) : undefined
    out[m] = { level, alias }
  }
  return out
}

const SELECT_USERS = `
  SELECT u.username, u.full_name, u.role, u.dept, u.status, u.card_id, u.template, u.note,
         u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
         u.password_hash IS NOT NULL AS has_password,
         COALESCE(json_object_agg(a.module, json_build_object('level', a.level, 'alias', a.alias))
                  FILTER (WHERE a.module IS NOT NULL), '{}') AS access
  FROM app_user u LEFT JOIN user_access a ON a.username = u.username`

export default async function userRoutes(app, { pool, auth }) {
  const admin = { preHandler: auth.requireRole('ADMIN') }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message })
    if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', message: 'ข้อมูลซ้ำ (ชื่อผู้ใช้หรือรหัสบัตรมีอยู่แล้ว)' })
    req.log.error(err)
    return reply.code(500).send({ error: 'INTERNAL', message: err.message })
  })

  async function getUser(db, username) {
    const { rows: [u] } = await db.query(`${SELECT_USERS} WHERE lower(u.username) = lower($1) GROUP BY u.username`, [username])
    return u || null
  }
  async function activeAdmins(db) {
    const { rows } = await db.query("SELECT username FROM app_user WHERE role = 'ADMIN' AND COALESCE(status, 'active') = 'active' AND password_hash IS NOT NULL")
    return rows.map((r) => r.username)
  }
  // ผู้ดูแลคนสุดท้ายต้องคงอยู่ (ไม่งั้นไม่มีใครเข้ามาแก้ได้อีก)
  async function guardLastAdmin(db, username, next) {
    const admins = await activeAdmins(db)
    if (!admins.includes(username)) return
    const stillAdmin = next.role === undefined ? true : next.role === 'ADMIN'
    const stillActive = next.status === undefined ? true : next.status === 'active'
    if ((!stillAdmin || !stillActive || next.deleted) && admins.length <= 1) {
      throw new HttpError(409, 'LAST_ADMIN', 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน')
    }
  }

  async function templateOf(db, name) {
    if (!name) return null
    const { rows: [t] } = await db.query('SELECT * FROM role_template WHERE name = $1', [name])
    if (!t) throw bad(`ไม่พบ template "${name}"`)
    return t
  }
  const templateAccess = (t) => {
    const out = {}
    for (const [m, level] of Object.entries(t.access || {})) out[m] = { level, alias: (t.aliases || {})[m] ?? null }
    return out
  }

  // เขียนสิทธิ์รายส่วน (merge) · NONE = ลบแถว
  async function writeAccess(db, username, access, actor) {
    for (const [module, { level, alias }] of Object.entries(access)) {
      if (level === 'NONE') { await db.query('DELETE FROM user_access WHERE username = $1 AND module = $2', [username, module]); continue }
      await db.query(
        `INSERT INTO user_access (username, module, level, alias, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (username, module) DO UPDATE SET level = EXCLUDED.level,
           alias = CASE WHEN $6 THEN EXCLUDED.alias ELSE user_access.alias END, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [username, module, level, alias ?? null, actor, alias !== undefined],
      )
    }
  }

  function validateFields(b, { creating }) {
    const f = {}
    if (creating) {
      f.username = String(b.username || '').trim()
      if (!USERNAME_RE.test(f.username)) throw bad('ชื่อผู้ใช้ 2–40 ตัว (a-z A-Z 0-9 . _ - @)')
    }
    if (b.fullName !== undefined) f.full_name = String(b.fullName || '').trim() || null
    if (b.dept !== undefined) f.dept = String(b.dept || '').trim() || null
    if (b.note !== undefined) f.note = String(b.note || '').trim() || null
    if (b.cardId !== undefined) f.card_id = String(b.cardId || '').trim() || null
    if (b.role !== undefined) {
      if (b.role && !ROLES.includes(b.role)) throw bad(`บทบาทต้องเป็น ${ROLES.join(', ')}`)
      f.role = b.role || null
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw bad('สถานะต้องเป็น active หรือ inactive')
      f.status = b.status
    }
    if (b.password !== undefined && b.password !== '' && b.password !== null) {
      if (String(b.password).length < MIN_PASSWORD) throw bad(`รหัสผ่านอย่างน้อย ${MIN_PASSWORD} ตัว`)
      f.password = String(b.password)
    }
    return f
  }

  // สร้าง 1 คน (ใช้ทั้ง POST /users และนำเข้า CSV)
  async function createUser(db, b, actor) {
    const f = validateFields(b, { creating: true })
    if (await getUser(db, f.username)) throw new HttpError(409, 'DUPLICATE', `มีผู้ใช้ ${f.username} อยู่แล้ว`)
    const t = await templateOf(db, b.template)
    const status = f.status || (f.password ? 'active' : 'inactive')
    if (status === 'active' && !f.password) throw bad('เปิดใช้งานต้องตั้งรหัสผ่าน (หรือสร้างแบบปิดไว้ก่อน)')
    await db.query(
      `INSERT INTO app_user (username, password_hash, full_name, role, dept, status, card_id, template, note, must_change_password, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [f.username, f.password ? await hashPassword(f.password) : null, f.full_name ?? null, f.role ?? t?.role ?? null, f.dept ?? null,
        status, f.card_id ?? null, t?.name ?? null, f.note ?? null, b.mustChangePassword !== false],
    )
    const access = { ...(t ? templateAccess(t) : {}), ...normAccess(b.access) }
    await writeAccess(db, f.username, access, actor)
    await audit(db, { actor, action: 'USER_CREATE', entityType: 'app_user', entityId: f.username,
      detail: { role: f.role ?? t?.role, status, template: t?.name, access: Object.fromEntries(Object.entries(access).map(([m, v]) => [m, v.level])) } })
    return getUser(db, f.username)
  }

  async function updateUser(db, username, b, actor) {
    const cur = await getUser(db, username)
    if (!cur) throw new HttpError(404, 'NOT_FOUND', `ไม่พบผู้ใช้ ${username}`)
    const f = validateFields(b, { creating: false })
    if (cur.username === actor && (f.status === 'inactive' || (f.role !== undefined && f.role !== 'ADMIN' && cur.role === 'ADMIN'))) {
      throw new HttpError(409, 'SELF_LOCKOUT', 'ลดสิทธิ์หรือปิดบัญชีตัวเองไม่ได้')
    }
    await guardLastAdmin(db, cur.username, { role: f.role, status: f.status })
    const t = b.template ? await templateOf(db, b.template) : null
    const willBeActive = (f.status ?? cur.status) === 'active'
    if (willBeActive && !cur.has_password && !f.password) throw bad('เปิดใช้งานต้องตั้งรหัสผ่านก่อน')

    const sets = [], vals = [cur.username]
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
    for (const col of ['full_name', 'dept', 'note', 'card_id', 'role', 'status']) if (f[col] !== undefined) put(col, f[col])
    if (t) { put('template', t.name); if (f.role === undefined && t.role) put('role', t.role) }
    if (f.password) { put('password_hash', await hashPassword(f.password)); put('must_change_password', b.mustChangePassword !== false) }
    else if (b.mustChangePassword !== undefined) put('must_change_password', !!b.mustChangePassword)
    if (sets.length) await db.query(`UPDATE app_user SET ${sets.join(', ')}, updated_at = now() WHERE username = $1`, vals)

    const access = { ...(t ? templateAccess(t) : {}), ...normAccess(b.access) }
    if (Object.keys(access).length) await writeAccess(db, cur.username, access, actor)

    // ปิดบัญชี / รีเซ็ตรหัส → session เดิมหลุดทันที
    if (f.status === 'inactive' || f.password) await db.query('DELETE FROM auth_session WHERE username = $1', [cur.username])
    // บันทึกเฉพาะที่เปลี่ยนจริง (ฟอร์มส่งทุกช่องมา)
    const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== 'password' && (cur[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, { from: cur[k] ?? null, to: v }]))
    const accChanged = Object.fromEntries(Object.entries(access)
      .filter(([m, v]) => (cur.access?.[m]?.level || 'NONE') !== v.level || (v.alias !== undefined && (cur.access?.[m]?.alias ?? null) !== (v.alias ?? null)))
      .map(([m, v]) => [m, { from: cur.access?.[m]?.level || 'NONE', to: v.level, ...(v.alias !== undefined && (cur.access?.[m]?.alias ?? null) !== (v.alias ?? null) ? { alias: v.alias } : {}) }]))
    await audit(db, { actor, action: 'USER_UPDATE', entityType: 'app_user', entityId: cur.username,
      detail: { changed, passwordReset: !!f.password, template: t?.name, access: Object.keys(accChanged).length ? accChanged : undefined } })
    return getUser(db, cur.username)
  }

  // ── อ่าน ──
  app.get('/users/meta', admin, async () => ({
    modules: MODULES.map((id) => ({ id, label: MODULE_LABEL[id] })),
    levels: LEVELS.map((id) => ({ id, label: LEVEL_LABEL[id] })),
    roles: ROLES,
    depts: (await pool.query("SELECT DISTINCT dept FROM app_user WHERE dept IS NOT NULL AND dept <> '' ORDER BY dept")).rows.map((r) => r.dept),
    locked: [...auth.lockedUsers()],
  }))

  app.get('/users', admin, async (req) => {
    const q = req.query || {}
    const where = [], vals = []
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)) }
    if (q.q) add("(u.username ILIKE ? OR u.full_name ILIKE $X OR u.card_id ILIKE $X OR u.dept ILIKE $X)".replace(/\$X/g, `$${vals.length + 1}`), `%${q.q}%`)
    if (q.status) add('COALESCE(u.status, \'active\') = ?', q.status)
    if (q.dept) add('u.dept = ?', q.dept)
    if (q.role) add('u.role = ?', q.role)
    if (q.module) {
      vals.push(q.module)
      where.push(`EXISTS (SELECT 1 FROM user_access x WHERE x.username = u.username AND x.module = $${vals.length})`)
    }
    const { rows } = await pool.query(`${SELECT_USERS} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY u.username ORDER BY u.username`, vals)
    const locked = auth.lockedUsers()
    return rows.map((u) => ({ ...u, locked: locked.has(u.username.toLowerCase()) }))
  })

  app.get('/users/audit', admin, async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const vals = [limit]
    let filter = ''
    if (req.query.username) { vals.push(req.query.username); filter = 'AND (entity_id = $2 OR actor = $2)' }
    const { rows } = await pool.query(
      `SELECT id, at, actor, action, entity_type, entity_id, detail FROM audit_log
       WHERE (entity_type IN ('app_user', 'role_template') OR action IN ('LOGIN', 'LOGIN_FAIL', 'LOGOUT', 'PASSWORD_CHANGE', 'DENIED', 'APP_LOGIN', 'APP_LOGIN_FAIL')) ${filter}
       ORDER BY id DESC LIMIT $1`, vals)
    return rows
  })

  app.get('/users/export.csv', admin, async (req, reply) => {
    const { rows } = await pool.query(`${SELECT_USERS} GROUP BY u.username ORDER BY u.username`)
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [CSV_COLS.join(',')]
    for (const u of rows) {
      lines.push([u.username, u.full_name, u.dept, u.role, u.card_id, u.status || 'active', u.template,
        ...MODULES.map((m) => u.access?.[m] ? u.access[m].level + (u.access[m].alias ? ':' + u.access[m].alias : '') : '')].map(cell).join(','))
    }
    await audit(pool, { actor: req.user.username, action: 'USER_EXPORT', entityType: 'app_user', detail: { count: rows.length } })
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="whrm-users.csv"')
    return '﻿' + lines.join('\r\n')   // BOM → Excel อ่านภาษาไทยถูก · ไม่มีรหัสผ่าน
  })

  app.get('/users/:username', admin, async (req, reply) => {
    const u = await getUser(pool, req.params.username)
    if (!u) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบผู้ใช้ ${req.params.username}` })
    return { ...u, locked: auth.lockedUsers().has(u.username.toLowerCase()) }
  })

  // ── สร้าง / แก้ / ลบ ──
  app.post('/users', admin, async (req, reply) => {
    const u = await withTx(pool, (c) => createUser(c, req.body || {}, req.user.username))
    return reply.code(201).send(u)
  })

  app.put('/users/:username', admin, async (req) => withTx(pool, (c) => updateUser(c, req.params.username, req.body || {}, req.user.username)))

  app.put('/users/:username/access', admin, async (req) =>
    withTx(pool, (c) => updateUser(c, req.params.username, { access: req.body?.access || req.body }, req.user.username)))

  // ตั้งส่วนเดียวให้หลายคนพร้อมกัน
  app.post('/users/bulk-access', admin, async (req) => {
    const { usernames = [], module, level, alias } = req.body || {}
    if (!Array.isArray(usernames) || !usernames.length) throw bad('เลือกผู้ใช้อย่างน้อย 1 คน')
    const access = normAccess({ [module]: alias === undefined ? level : { level, alias } })
    await withTx(pool, async (c) => { for (const n of usernames) await updateUser(c, n, { access }, req.user.username) })
    return { ok: true, count: usernames.length }
  })

  app.post('/users/:username/unlock', admin, async (req) => {
    const n = auth.unlock(req.params.username)
    await audit(pool, { actor: req.user.username, action: 'USER_UNLOCK', entityType: 'app_user', entityId: req.params.username, detail: { cleared: n } })
    return { ok: true, cleared: n }
  })

  // ลบถาวร: เฉพาะบัญชีที่ไม่เคย login / ไม่มีประวัติทำรายการ · ต้องส่ง confirm = ชื่อผู้ใช้
  app.delete('/users/:username', admin, async (req, reply) => {
    const cur = await getUser(pool, req.params.username)
    if (!cur) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบผู้ใช้ ${req.params.username}` })
    if ((req.body?.confirm || req.query?.confirm) !== cur.username) throw bad(`ยืนยันโดยส่ง confirm = "${cur.username}"`)
    if (cur.username === req.user.username) throw new HttpError(409, 'SELF_LOCKOUT', 'ลบบัญชีตัวเองไม่ได้')
    await guardLastAdmin(pool, cur.username, { deleted: true })
    const { rows: [{ n }] } = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE actor = $1 AND action NOT IN ('LOGIN_FAIL')", [cur.username])
    if (cur.last_login_at || n > 0) {
      throw new HttpError(409, 'HAS_ACTIVITY', `${cur.username} เคยใช้งานแล้ว (ประวัติ ${n} รายการ) — ใช้ "ปิดบัญชี" แทน เพื่อให้ประวัติยังอ้างถึงได้`)
    }
    await pool.query('DELETE FROM app_user WHERE username = $1', [cur.username])
    await audit(pool, { actor: req.user.username, action: 'USER_DELETE', entityType: 'app_user', entityId: cur.username,
      detail: { fullName: cur.full_name, role: cur.role, access: cur.access } })
    return { ok: true }
  })

  // ── นำเข้า CSV (หัวคอลัมน์เหมือนไฟล์ส่งออก + password ได้) · มีอยู่แล้ว = แก้ · ไม่มี = สร้าง ──
  // rows = จาก Excel (หน้า users.html แปลงให้) · csv = ข้อความ CSV · mustChangePassword = แถวที่มีรหัส ต้องตั้งรหัสใหม่ตอน login ครั้งแรก (ค่าเริ่มต้น: ไม่ต้อง — PIN เดิมของพนักงาน)
  app.post('/users/import', admin, async (req) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : parseCsv(String(req.body?.csv || ''))
    if (!rows.length) throw bad('ไม่มีข้อมูล (ต้องมีหัวคอลัมน์ username)')
    if (rows.length > 2000) throw bad('นำเข้าได้ครั้งละไม่เกิน 2000 แถว')
    const mustChange = req.body?.mustChangePassword === true
    const results = []
    for (const [i, r] of rows.entries()) {
      const access = {}
      for (const m of MODULES) {
        const v = String(r[m] ?? '').trim()
        if (!v) continue
        const [level, alias] = v.split(':')
        access[m] = alias !== undefined ? { level: level.toUpperCase(), alias } : level.toUpperCase()
      }
      const body = {
        username: r.username, fullName: r.full_name, dept: r.dept, role: r.role || undefined, cardId: r.card_id,
        // แถวที่มีรหัสผ่าน (เช่น Authorized list) = เปิดใช้งาน · ไม่มีรหัส = คงสถานะเดิม
        status: r.status || (r.password ? 'active' : undefined), template: r.template || undefined, password: r.password ? String(r.password) : undefined, access,
        mustChangePassword: r.password ? mustChange : undefined,
      }
      try {
        const exists = await getUser(pool, String(r.username || '').trim())
        await withTx(pool, (c) => exists ? updateUser(c, exists.username, { ...body, username: undefined }, req.user.username) : createUser(c, body, req.user.username))
        results.push({ row: i + 2, username: r.username, ok: true, action: exists ? 'updated' : 'created' })
      } catch (e) {
        results.push({ row: i + 2, username: r.username, ok: false, message: e.message })
      }
    }
    await audit(pool, { actor: req.user.username, action: 'USER_IMPORT', entityType: 'app_user',
      detail: { total: results.length, ok: results.filter((x) => x.ok).length } })
    return { results }
  })

  // ── template ──
  app.get('/role-templates', admin, async () => {
    const { rows } = await pool.query(
      `SELECT t.*, (SELECT count(*)::int FROM app_user u WHERE u.template = t.name) AS users FROM role_template t ORDER BY t.name`)
    return rows
  })

  async function saveTemplate(c, name, b, actor, creating) {
    const access = normAccess(b.access || {})
    const levels = Object.fromEntries(Object.entries(access).filter(([, v]) => v.level !== 'NONE').map(([m, v]) => [m, v.level]))
    const aliases = Object.fromEntries(Object.entries(b.aliases || {}).filter(([m, v]) => MODULES.includes(m) && v))
    if (b.role && !ROLES.includes(b.role)) throw bad(`บทบาทต้องเป็น ${ROLES.join(', ')}`)
    if (creating) {
      await c.query('INSERT INTO role_template (name, description, role, access, aliases, updated_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [name, b.description || null, b.role || null, levels, aliases, actor])
    } else {
      const { rowCount } = await c.query(
        'UPDATE role_template SET description = $2, role = $3, access = $4, aliases = $5, updated_by = $6, updated_at = now() WHERE name = $1',
        [name, b.description || null, b.role || null, levels, aliases, actor])
      if (!rowCount) throw new HttpError(404, 'NOT_FOUND', `ไม่พบ template "${name}"`)
    }
    await audit(c, { actor, action: creating ? 'TEMPLATE_CREATE' : 'TEMPLATE_UPDATE', entityType: 'role_template', entityId: name, detail: { role: b.role, access: levels } })
    // แก้ template แล้วใช้กับคนที่ใช้ template นี้อยู่ด้วย (เลือกได้)
    let applied = 0
    if (!creating && b.applyToUsers) {
      const { rows } = await c.query('SELECT username FROM app_user WHERE template = $1', [name])
      for (const r of rows) {
        const reset = Object.fromEntries(MODULES.map((m) => [m, { level: levels[m] || 'NONE', alias: aliases[m] ?? undefined }]))
        await updateUser(c, r.username, { template: name, access: reset }, actor)
        applied++
      }
    }
    return { name, applied }
  }

  app.post('/role-templates', admin, async (req, reply) => {
    const name = String(req.body?.name || '').trim()
    if (!name || name.length > 60) throw bad('ชื่อ template 1–60 ตัว')
    const r = await withTx(pool, (c) => saveTemplate(c, name, req.body || {}, req.user.username, true))
    return reply.code(201).send(r)
  })

  app.put('/role-templates/:name', admin, async (req) =>
    withTx(pool, (c) => saveTemplate(c, req.params.name, req.body || {}, req.user.username, false)))

  // ใช้ template กับผู้ใช้ที่เลือก (ทับสิทธิ์ทุกส่วนตาม template)
  app.post('/role-templates/:name/apply', admin, async (req) => {
    const { usernames = [] } = req.body || {}
    if (!usernames.length) throw bad('เลือกผู้ใช้อย่างน้อย 1 คน')
    await withTx(pool, async (c) => {
      const t = await templateOf(c, req.params.name)
      const reset = Object.fromEntries(MODULES.map((m) => [m, { level: t.access[m] || 'NONE', alias: t.aliases?.[m] ?? undefined }]))
      for (const n of usernames) await updateUser(c, n, { template: t.name, access: reset }, req.user.username)
    })
    return { ok: true, count: usernames.length }
  })

  app.delete('/role-templates/:name', admin, async (req, reply) => {
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM app_user WHERE template = $1', [req.params.name])
    if (n > 0) return reply.code(409).send({ error: 'IN_USE', message: `มีผู้ใช้ ${n} คนใช้ template นี้อยู่ — เปลี่ยน template ของคนเหล่านั้นก่อน` })
    const { rowCount } = await pool.query('DELETE FROM role_template WHERE name = $1', [req.params.name])
    if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบ template "${req.params.name}"` })
    await audit(pool, { actor: req.user.username, action: 'TEMPLATE_DELETE', entityType: 'role_template', entityId: req.params.name })
    return { ok: true }
  })
}

// CSV แบบง่าย (รองรับ "…" และ "" ภายใน) → [{ col: value }]
export function parseCsv(text) {
  const rows = []
  let row = [], cur = '', q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cur += ch
  }
  row.push(cur)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  if (!rows.length) return []
  const head = rows[0].map((h) => h.trim())
  if (!head.includes('username')) return []
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])))
}
