-- WH-RM Phase A schema
-- kv_store/bus_message ทำให้ UI เดิม (localStorage + BroadcastChannel) ใช้งานข้ามเครื่องได้
-- weighing_* / override_log / app_user / audit_log เป็นข้อมูล domain ชุดแรกที่ได้จาก V4

CREATE TABLE device (
  device_id   text PRIMARY KEY,
  app         text,
  user_agent  text,
  ip          text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- ค่า localStorage key whrm_* ที่ใช้ร่วมกัน (value NULL = ถูกลบ / tombstone)
CREATE TABLE kv_store (
  key         text PRIMARY KEY,
  value       text,
  version     integer NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- เก็บย้อนหลังต่อ key (ใช้กู้ข้อมูล) — trim ให้เหลือล่าสุด N version ใน service
CREATE TABLE kv_history (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  version     integer NOT NULL,
  value       text,
  updated_by  text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kv_history_key_idx ON kv_history (key, version DESC);

-- ทุก message ที่ relay ผ่าน bus (ใช้ replay ตอน reconnect + trace)
CREATE TABLE bus_message (
  seq         bigserial PRIMARY KEY,
  msg_id      text NOT NULL UNIQUE,
  channel     text NOT NULL,
  type        text,
  source      text,
  device_id   text,
  payload     jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bus_message_at_idx ON bus_message (at DESC);
CREATE INDEX bus_message_type_idx ON bus_message (type);

CREATE TABLE weighing_report (
  report_id           text PRIMARY KEY,
  weighing_type       text,
  trip_no             text,
  vehicle_plate       text,
  vehicle_type        text,
  supplier_transport  text,
  customer            text,
  weighed_by          text,
  device_id           text,
  weighed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE weighing_item (
  id               text PRIMARY KEY,
  report_id        text NOT NULL REFERENCES weighing_report (report_id),
  product_code     text,
  product_name     text,
  category         text,
  customer         text,
  batch_no         text,
  gross_weight     numeric(14,3),
  tare_weight      numeric(14,3),
  net_weight       numeric(14,3),
  pcs_count        integer,
  unit             text,
  capture_mode     text,
  barcode_value    text,
  barcode_passed   boolean,
  override_by      text,
  override_reason  text,
  override_at      timestamptz,
  wms_status       text NOT NULL DEFAULT 'BASKET',  -- BASKET, SENT, IMPORTED, REJECTED, DELETED
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX weighing_item_report_idx ON weighing_item (report_id);
CREATE INDEX weighing_item_code_idx ON weighing_item (product_code, batch_no);

CREATE TABLE override_log (
  id          bigserial PRIMARY KEY,
  report_id   text,
  item_code   text,
  net_weight  numeric(14,3),
  reason      text,
  username    text,
  role        text,
  device_id   text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  username       text PRIMARY KEY,
  password_hash  text,
  full_name      text,
  role           text,
  dept           text,
  status         text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- append-only: ห้าม UPDATE/DELETE (trigger ด้านล่าง)
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  device_id    text,
  app          text,
  actor        text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  detail       jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
