// Endpoint อ่านข้อมูล — ใช้ตรวจสอบ/ดูสถานะระบบตอน demo
const limitOf = (q, def = 50, max = 500) => Math.min(Math.max(parseInt(q.limit, 10) || def, 1), max)

export default async function queryRoutes(app, { pool, bus, version }) {
  app.get('/health', async (req, reply) => {
    let db = 'up'
    try { await pool.query('SELECT 1') } catch { db = 'down' }
    if (db === 'down') reply.code(503)
    return { ok: db === 'up', db, bus: 'up', connections: bus.stats().length, version, time: new Date().toISOString() }
  })

  app.get('/status', async () => {
    const [{ rows: [counts] }, { rows: devices }] = await Promise.all([
      pool.query(`SELECT
          (SELECT count(*) FROM kv_store WHERE value IS NOT NULL)::int AS keys,
          (SELECT count(*) FROM bus_message)::int AS bus_messages,
          (SELECT count(*) FROM weighing_report)::int AS weighing_reports,
          (SELECT count(*) FROM weighing_item)::int AS weighing_items,
          (SELECT count(*) FROM audit_log)::int AS audit_entries`),
      pool.query('SELECT device_id, app, ip, last_seen FROM device ORDER BY last_seen DESC LIMIT 20'),
    ])
    return { counts, online: bus.stats(), devices }
  })

  app.get('/weighing/reports', async (req) => {
    const { rows } = await pool.query(
      `SELECT r.*, count(i.id)::int AS item_count,
              COALESCE(sum(i.net_weight), 0)::float AS total_net,
              array_remove(array_agg(DISTINCT i.wms_status), NULL) AS statuses
       FROM weighing_report r LEFT JOIN weighing_item i ON i.report_id = r.report_id
       GROUP BY r.report_id ORDER BY r.updated_at DESC LIMIT $1`,
      [limitOf(req.query)],
    )
    return rows
  })

  app.get('/weighing/reports/:reportId', async (req, reply) => {
    const { rows: [report] } = await pool.query('SELECT * FROM weighing_report WHERE report_id = $1', [req.params.reportId])
    if (!report) return reply.code(404).send({ error: 'NOT_FOUND', message: `ไม่พบรายงาน ${req.params.reportId}` })
    const { rows: items } = await pool.query(
      `SELECT id, product_code, product_name, category, customer, batch_no, gross_weight, tare_weight, net_weight,
              pcs_count, unit, capture_mode, barcode_passed, override_by, override_reason, wms_status,
              bbf_exp_text, to_char(bbf_exp, 'YYYY-MM-DD') AS bbf_exp, prp_status, updated_at
       FROM weighing_item WHERE report_id = $1 ORDER BY created_at`,
      [req.params.reportId],
    )
    return { ...report, items }
  })

  app.get('/bus/messages', async (req) => {
    const params = [limitOf(req.query)]
    let where = ''
    if (req.query.type) { params.push(req.query.type); where = 'WHERE type = $2' }
    const { rows } = await pool.query(
      `SELECT seq, msg_id, channel, type, source, device_id, at, payload FROM bus_message ${where}
       ORDER BY seq DESC LIMIT $1`,
      params,
    )
    return rows
  })

  app.get('/audit', async (req) => {
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limitOf(req.query)])
    return rows
  })

  app.get('/overrides', async (req) => {
    const { rows } = await pool.query('SELECT * FROM override_log ORDER BY id DESC LIMIT $1', [limitOf(req.query)])
    return rows
  })

  // ยกเลิก RU: ส่งให้ V4 แล้วกี่ครั้ง / V4 ตอบ DONE หรือยัง
  app.get('/ru-cancels', async (req) => {
    const { rows } = await pool.query('SELECT * FROM ru_cancel ORDER BY cancelled_at DESC LIMIT $1', [limitOf(req.query)])
    return rows
  })

  // FGT (นำส่งสินค้า) / FGA (อนุมัติ) — Phase A อ่านจากค่าที่ WH13 sync ขึ้นมา (ยังไม่มีตารางของตัวเอง)
  async function kvList(key) {
    const { rows: [r] } = await pool.query('SELECT value, version, updated_at FROM kv_store WHERE key = $1', [key])
    let list = []
    try { const x = JSON.parse(r?.value || '[]'); if (Array.isArray(x)) list = x } catch { /* ค่าเสีย → ว่าง */ }
    return { list, version: r?.version || 0, updatedAt: r?.updated_at || null }
  }
  // เลขเอกสารซ้ำ = 2 เครื่องออกเลขพร้อมกันก่อน sync ถึงกัน → แจ้งให้เห็น (Phase B ให้ server ออกเลข)
  function duplicatesOf(list, field) {
    const count = {}
    for (const x of list) if (x && x[field]) count[x[field]] = (count[x[field]] || 0) + 1
    return Object.keys(count).filter((k) => count[k] > 1)
  }

  app.get('/fgt', async (req) => {
    const { list, version, updatedAt } = await kvList('whrm_fgt_queue_v1')
    const status = req.query.status ? String(req.query.status).toUpperCase() : null
    const items = list.filter((x) => !status || String(x.status || '').toUpperCase() === status)
    const byStatus = {}
    for (const x of list) byStatus[x.status || '-'] = (byStatus[x.status || '-'] || 0) + 1
    const duplicates = duplicatesOf(list, 'fgtNo')
    if (duplicates.length) req.log.warn({ duplicates }, 'FGT number issued twice')
    return { total: list.length, byStatus, duplicates, version, updatedAt, items: items.slice(0, limitOf(req.query, 100, 1000)) }
  })

  app.get('/fga/reports', async (req) => {
    const { list, version, updatedAt } = await kvList('whrm_fga_reports_v1')
    return { total: list.length, duplicates: duplicatesOf(list, 'fgaNo'), version, updatedAt, items: list.slice(0, limitOf(req.query, 100, 1000)) }
  })

  app.get('/users', async () => {
    const { rows } = await pool.query('SELECT username, full_name, role, dept, status, updated_at FROM app_user ORDER BY username')
    return rows
  })
}
