// ข้อมูลชั่งจาก V4 → ตาราง weighing_report / weighing_item
// มาได้ 2 ทาง: REST (/weighing/items, /weighing/save-trip) และ bus (TRIP_SAVED / TRIP_IMPORTED / ...)
// ทั้งสองทางเป็น upsert จึงซ้ำกันได้ไม่เสียหาย

const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '-') return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
const int = (v) => {
  const n = num(v)
  return n === null ? null : Math.round(n)
}
const str = (v) => (v === null || v === undefined || v === '' || v === '-' ? null : String(v))

// BBF/EXP ที่พนักงานพิมพ์ใน V4 (placeholder "วว/ดด/ปปปป", ตัวอย่างของลูกค้า "31/12/2569")
// R13: ปี ≥ 2400 = พ.ศ. (−543) · ปี 2 หลัก = พ.ศ. 25xx · รับ yyyy-mm-dd ด้วย · วันที่ไม่จริง → date = null
export function parseBbfExp(value) {
  const text = str(value) && String(value).trim()
  if (!text) return { text: null, date: null }
  let d, m, y
  let mt = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/)
  if (mt) [, d, m, y] = mt.map(Number)
  else if ((mt = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = mt.map(Number)
  else return { text, date: null }
  if (y < 100) y += 2500
  if (y >= 2400) y -= 543
  const dt = new Date(Date.UTC(y, m - 1, d))
  const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  return { text, date: valid ? dt.toISOString().slice(0, 10) : null }
}

// ลำดับสถานะ — ห้ามถอยจาก IMPORTED/REJECTED/DELETED กลับเป็น SENT/BASKET
const STATUS_RANK = { BASKET: 0, SENT: 1, IMPORTED: 2, REJECTED: 2, DELETED: 2 }

export async function upsertReport(db, r) {
  await db.query(
    `INSERT INTO weighing_report (report_id, weighing_type, trip_no, vehicle_plate, vehicle_type,
        supplier_transport, customer, weighed_by, device_id, weighed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (report_id) DO UPDATE SET
        weighing_type      = COALESCE(EXCLUDED.weighing_type, weighing_report.weighing_type),
        trip_no            = COALESCE(EXCLUDED.trip_no, weighing_report.trip_no),
        vehicle_plate      = COALESCE(EXCLUDED.vehicle_plate, weighing_report.vehicle_plate),
        vehicle_type       = COALESCE(EXCLUDED.vehicle_type, weighing_report.vehicle_type),
        supplier_transport = COALESCE(EXCLUDED.supplier_transport, weighing_report.supplier_transport),
        customer           = COALESCE(EXCLUDED.customer, weighing_report.customer),
        weighed_by         = COALESCE(EXCLUDED.weighed_by, weighing_report.weighed_by),
        device_id          = COALESCE(EXCLUDED.device_id, weighing_report.device_id),
        weighed_at         = COALESCE(EXCLUDED.weighed_at, weighing_report.weighed_at),
        updated_at         = now()`,
    [
      r.reportId, str(r.weighingType), str(r.tripNo), str(r.vehiclePlate), str(r.vehicleType),
      str(r.supplierTransport), str(r.customer), str(r.weighedBy), str(r.deviceId), r.weighedAt || null,
    ],
  )
}

// item จาก V4 มี 2 รูปแบบ: basket item (itemName, netWeightVal, ...) และ bus item (name, netWeight, ...)
export function normalizeItem(it) {
  return {
    id: String(it._id || it.id),
    code: str(it.code),
    name: str(it.itemName ?? it.name),
    category: str(it.category),
    customer: str(it.customer),
    batchNo: str(it.batchNo ?? it.batch),
    gross: num(it.grossWeight),
    tare: num(it.tareWeight),
    net: num(it.netWeightVal ?? it.netWeight),
    pcs: int(it.pcsCount),
    unit: str(it.unit) || 'kg',
    captureMode: str(it.captureMode),
    barcodeValue: str(it.barcodeVal),
    barcodePassed: typeof it.barcodePassed === 'boolean' ? it.barcodePassed : null,
    overrideBy: str(it.overrideBy),
    overrideReason: str(it.overrideReason),
    overrideAt: it.overrideAt || null,
    bbfExp: parseBbfExp(it.bbfExp),
  }
}

// weighingType: ประเภทของ report (item จาก bus ไม่มี weighingType รายตัว)
export async function upsertItem(db, reportId, raw, status, weighingType) {
  const it = normalizeItem(raw)
  const prpStatus = (raw.weighingType || weighingType) === 'PRP' ? 'PENDING' : null
  if (!it.id || it.id === 'undefined') return
  await db.query(
    `INSERT INTO weighing_item (id, report_id, product_code, product_name, category, customer, batch_no,
        gross_weight, tare_weight, net_weight, pcs_count, unit, capture_mode, barcode_value, barcode_passed,
        override_by, override_reason, override_at, wms_status, raw, bbf_exp_text, bbf_exp, prp_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$22,$23,$24)
     ON CONFLICT (id) DO UPDATE SET
        product_code    = COALESCE(EXCLUDED.product_code, weighing_item.product_code),
        product_name    = COALESCE(EXCLUDED.product_name, weighing_item.product_name),
        category        = COALESCE(EXCLUDED.category, weighing_item.category),
        customer        = COALESCE(EXCLUDED.customer, weighing_item.customer),
        batch_no        = COALESCE(EXCLUDED.batch_no, weighing_item.batch_no),
        gross_weight    = COALESCE(EXCLUDED.gross_weight, weighing_item.gross_weight),
        tare_weight     = COALESCE(EXCLUDED.tare_weight, weighing_item.tare_weight),
        net_weight      = COALESCE(EXCLUDED.net_weight, weighing_item.net_weight),
        pcs_count       = COALESCE(EXCLUDED.pcs_count, weighing_item.pcs_count),
        unit            = COALESCE(EXCLUDED.unit, weighing_item.unit),
        capture_mode    = COALESCE(EXCLUDED.capture_mode, weighing_item.capture_mode),
        barcode_value   = COALESCE(EXCLUDED.barcode_value, weighing_item.barcode_value),
        barcode_passed  = COALESCE(EXCLUDED.barcode_passed, weighing_item.barcode_passed),
        override_by     = COALESCE(EXCLUDED.override_by, weighing_item.override_by),
        override_reason = COALESCE(EXCLUDED.override_reason, weighing_item.override_reason),
        override_at     = COALESCE(EXCLUDED.override_at, weighing_item.override_at),
        wms_status      = CASE WHEN $21 > (CASE weighing_item.wms_status
                              WHEN 'BASKET' THEN 0 WHEN 'SENT' THEN 1 ELSE 2 END)
                          THEN EXCLUDED.wms_status ELSE weighing_item.wms_status END,
        raw             = weighing_item.raw || EXCLUDED.raw,
        bbf_exp_text    = COALESCE(EXCLUDED.bbf_exp_text, weighing_item.bbf_exp_text),
        bbf_exp         = COALESCE(EXCLUDED.bbf_exp, weighing_item.bbf_exp),
        prp_status      = COALESCE(weighing_item.prp_status, EXCLUDED.prp_status),
        updated_at      = now()`,
    [
      it.id, reportId, it.code, it.name, it.category, it.customer, it.batchNo,
      it.gross, it.tare, it.net, it.pcs, it.unit, it.captureMode, it.barcodeValue, it.barcodePassed,
      it.overrideBy, it.overrideReason, it.overrideAt, status, JSON.stringify(raw), STATUS_RANK[status] ?? 0,
      it.bbfExp.text, it.bbfExp.date, prpStatus,
    ],
  )
  if (it.bbfExp.text && !it.bbfExp.date) {
    await audit(db, { action: 'BBF_EXP_INVALID', entityType: 'weighing_item', entityId: it.id,
      detail: { reportId, code: it.code, text: it.bbfExp.text } })
  }
}

// อัปเดตสถานะตาม event จาก WH13 (อ้างด้วย reportId + รหัสสินค้า เพราะ WH13 ส่ง itemCodes)
export async function setStatusByCodes(db, reportId, codes, status) {
  if (!reportId) return 0
  const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean).map(String)
  const { rowCount } = list.length
    ? await db.query(
        `UPDATE weighing_item SET wms_status = $3, updated_at = now()
         WHERE report_id = $1 AND product_code = ANY($2::text[])`,
        [reportId, list, status],
      )
    : await db.query(
        `UPDATE weighing_item SET wms_status = $2, updated_at = now() WHERE report_id = $1`,
        [reportId, status],
      )
  return rowCount
}

export async function audit(db, { deviceId, app, actor, action, entityType, entityId, detail }) {
  await db.query(
    `INSERT INTO audit_log (device_id, app, actor, action, entity_type, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [deviceId || null, app || null, actor || null, action, entityType || null, entityId || null,
      detail ? JSON.stringify(detail) : null],
  )
}

// ผูก event บน bus → domain
export async function applyBusEvent(db, data, deviceId) {
  const type = data?.type
  const p = data?.payload || {}
  switch (type) {
    case 'TRIP_SAVED': {
      if (!p.reportId) return
      await upsertReport(db, {
        reportId: p.reportId, weighingType: p.weighingType, tripNo: p.tripNo,
        vehiclePlate: p.vehiclePlate, vehicleType: p.vehicleType, supplierTransport: p.supplierTransport,
        customer: p.customer, weighedBy: p.weighingUser, deviceId,
      })
      for (const it of p.items || []) await upsertItem(db, p.reportId, it, 'SENT', p.weighingType)
      await audit(db, { deviceId, app: 'V4', actor: p.weighingUser, action: 'TRIP_SAVED',
        entityType: 'weighing_report', entityId: p.reportId, detail: { items: (p.items || []).length } })
      return
    }
    case 'TRIP_IMPORTED':
      await setStatusByCodes(db, p.reportId, p.itemCodes, 'IMPORTED')
      await audit(db, { deviceId, app: 'WH13', actor: p.importedBy, action: 'TRIP_IMPORTED',
        entityType: 'weighing_report', entityId: p.reportId, detail: { itemCodes: p.itemCodes } })
      return
    case 'TRIP_ITEMS_DELETED':
      await setStatusByCodes(db, p.reportId, p.itemCodes, 'DELETED')
      await audit(db, { deviceId, app: 'WH13', actor: p.deletedBy, action: 'TRIP_ITEMS_DELETED',
        entityType: 'weighing_report', entityId: p.reportId, detail: { itemCodes: p.itemCodes } })
      return
    case 'TRIP_REJECTED':
      await setStatusByCodes(db, p.reportId, p.itemCode, 'REJECTED')
      await audit(db, { deviceId, app: 'WH13', action: 'TRIP_REJECTED',
        entityType: 'weighing_report', entityId: p.reportId, detail: p })
      return
    default:
  }
}
