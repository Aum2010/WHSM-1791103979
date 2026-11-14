-- แปลงเลขเอกสารเก่าเป็นรูปแบบมาตรฐาน (PREFIX 3 ตัว + YYYYMMDD + ลำดับ 4 หลัก) ครั้งเดียวที่ DB — ตัดสินใจ 14 พ.ย.
--   ตัวแปลง: scripts/migrate-docids.mjs (ค่าเริ่มต้น = ตรวจอย่างเดียว · --apply = เขียน · --rollback = คืนค่า)
--   ตารางนี้แค่เตรียมที่เก็บ: แผนที่เลขเก่า → ใหม่ · ค่าเดิมก่อนแปลง (ไว้คืนค่า) · ประวัติการรัน
CREATE TABLE IF NOT EXISTS docid_map (
  old_id     text PRIMARY KEY,
  new_id     text NOT NULL,
  rule       text,                    -- ตระกูลเลขเก่า เช่น IO-YYYYMMDD-NNN · TRF-<ms>
  run_id     integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS docid_map_new ON docid_map (new_id);

CREATE TABLE IF NOT EXISTS docid_migration_run (
  id          serial PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('APPLIED', 'ROLLED_BACK')),
  run_by      text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats       jsonb
);

CREATE TABLE IF NOT EXISTS docid_migration_backup (
  run_id   integer NOT NULL REFERENCES docid_migration_run (id),
  src      text NOT NULL,            -- kv · doc · weighing · table:<name>
  ref      text NOT NULL,            -- คีย์ / kind|id / report_id / pk
  old      jsonb NOT NULL,           -- แถว / ค่าเดิมทั้งก้อน
  PRIMARY KEY (run_id, src, ref)
);
