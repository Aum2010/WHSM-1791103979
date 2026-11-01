-- ขาย (BD02): ออเดอร์ SBO · คิวส่ง WH13 · ผลตอบกลับ · ใบเสนอราคา (RC-01)
--   data = ข้อมูลเต็มตามที่หน้าจอลูกค้าใช้ · คอลัมน์อื่นไว้ค้น / กันซ้ำ

CREATE TABLE doc_seq (
  scope      text PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE TABLE sbo_order (
  sbo_number    text PRIMARY KEY,
  sale_order_id text,
  status        text,
  data          jsonb NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sbo_order_status_idx ON sbo_order (status);

-- 1 SBO ส่งได้ครั้งเดียว · claimed_* = WH13 เครื่องแรกที่รับเข้า Info Center
CREATE TABLE sbo_handoff (
  id             text PRIMARY KEY,
  sbo_number     text NOT NULL UNIQUE REFERENCES sbo_order (sbo_number),
  data           jsonb NOT NULL,
  pushed_by      text,
  pushed_at      timestamptz NOT NULL DEFAULT now(),
  claimed_by     text,
  claimed_device text,
  claimed_at     timestamptz
);

-- dedupe_key: WH13 หลายเครื่องส่งผลเดียวกันได้ → เก็บครั้งเดียว
CREATE TABLE sbo_decision (
  id          text PRIMARY KEY,
  sbo_number  text NOT NULL,
  decision    text NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  data        jsonb NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_by text,
  consumed_at timestamptz
);
CREATE INDEX sbo_decision_pending_idx ON sbo_decision (created_at) WHERE consumed_at IS NULL;

CREATE TABLE quotation (
  id            text PRIMARY KEY,
  customer_name text,
  status        text,
  total         numeric,
  data          jsonb NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
