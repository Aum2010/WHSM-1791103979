-- งานจ่ายผ่านขนส่ง (Transfer to Logistics) — ตัดสินใจ 14 พ.ย. แบบ ก: server คุม แต่ตัวตัดสต็อกยังเป็นของ WH13
--   1 แถว = 1 ใบงาน LG (LGT) · กันยอดตั้งแต่คลังอนุมัติ (RESERVED) จน LG02 รับงานแล้วตัดเสร็จ (CUT) หรือปฏิเสธ / ยกเลิก (RELEASED)
--   ตอน LG02 รับงาน หน้า WH13 ต้อง "ขอสิทธิ์ตัด" ก่อน (RESERVED → CUTTING) → ได้เครื่องเดียว ตัดครั้งเดียว
CREATE TABLE IF NOT EXISTS lg_reservation (
  lg_no       text PRIMARY KEY,
  ra_no       text NOT NULL,
  io_no       text,
  lines       jsonb NOT NULL DEFAULT '[]',   -- [{ wh, code, lot, qty, name }]
  status      text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'CUTTING', 'CUT', 'RELEASED')),
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by  text,          -- ผู้ใช้ · เครื่อง ที่กำลังตัด
  claimed_at  timestamptz,
  done_at     timestamptz,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lg_reservation_active ON lg_reservation (status) WHERE status IN ('RESERVED', 'CUTTING');
