-- เอกสารรายใบ (เฟส 1: ใบโอน + คิวขนส่ง) · เดิมเก็บเป็น array ก้อนเดียวใน kv_store
--   kind = ชนิดเอกสาร · id = เลขเอกสาร · data = ข้อมูลเต็มตามที่หน้าจอใช้ · version กันเขียนทับ

CREATE TABLE doc_store (
  kind       text NOT NULL,
  id         text NOT NULL,
  data       jsonb NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);

CREATE TABLE doc_history (
  kind       text NOT NULL,
  id         text NOT NULL,
  version    integer NOT NULL,
  data       jsonb NOT NULL,
  updated_by text,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id, version)
);

-- ย้ายข้อมูลเดิมจาก kv_store (ใบซ้ำในก้อนเดิม ใช้ใบแรก = ใหม่สุด)
INSERT INTO doc_store (kind, id, data, created_by, updated_by)
SELECT DISTINCT ON (x.e->>'trfNo') 'dc_transfer', x.e->>'trfNo', x.e, 'migration-008', 'migration-008'
FROM kv_store k, jsonb_array_elements(CASE WHEN jsonb_typeof(k.value::jsonb) = 'array' THEN k.value::jsonb ELSE '[]'::jsonb END) WITH ORDINALITY AS x(e, n)
WHERE k.key = 'whrm_dc_transfer_v1' AND k.value IS NOT NULL AND coalesce(x.e->>'trfNo', '') <> ''
ORDER BY x.e->>'trfNo', x.n
ON CONFLICT DO NOTHING;

INSERT INTO doc_store (kind, id, data, created_by, updated_by)
SELECT DISTINCT ON (x.e->>'lgNo') 'logistic_queue', x.e->>'lgNo', x.e, 'migration-008', 'migration-008'
FROM kv_store k, jsonb_array_elements(CASE WHEN jsonb_typeof(k.value::jsonb) = 'array' THEN k.value::jsonb ELSE '[]'::jsonb END) WITH ORDINALITY AS x(e, n)
WHERE k.key = 'whrm_logistic_queue_v1' AND k.value IS NOT NULL AND coalesce(x.e->>'lgNo', '') <> ''
ORDER BY x.e->>'lgNo', x.n
ON CONFLICT DO NOTHING;

INSERT INTO doc_history (kind, id, version, data, updated_by)
SELECT kind, id, version, data, 'migration-008' FROM doc_store;

-- ค่าเดิมยังอยู่ใน kv_history ถ้าต้องย้อนกลับ
DELETE FROM kv_store WHERE key IN ('whrm_dc_transfer_v1', 'whrm_logistic_queue_v1');
