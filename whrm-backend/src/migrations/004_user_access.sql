-- จัดการผู้ใช้รายส่วน: 1 คน = 1 บัญชี (app_user) + สิทธิ์แยกตามส่วนของระบบ + template สิทธิ์สำเร็จรูป
-- ผู้ดูแลระบบ = app_user.role 'ADMIN' (เหมือนเดิม) · ส่วนอื่นอยู่ใน user_access

ALTER TABLE app_user
  ADD COLUMN card_id              text UNIQUE,          -- รหัสบัตรพนักงาน (สแกน) — REQ-F-001
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN template             text,                  -- template ที่ใช้ตั้งสิทธิ์ล่าสุด (อ้างอิง ไม่ผูก FK)
  ADD COLUMN note                 text;

-- ระดับต่อส่วน: ไม่มีแถว = NONE (เปิดหน้าไม่ได้)
-- alias = ชื่อที่หน้าจอของลูกค้าใช้ตรวจสิทธิ์ (WH13: QA-001 / WH-002 / Tom · V4: operator_01 · BD02: BD001)
CREATE TABLE user_access (
  username    text NOT NULL REFERENCES app_user (username) ON DELETE CASCADE,
  module      text NOT NULL CHECK (module IN ('WH13', 'V4', 'QA', 'BD02', 'PRODUCTION', 'DBV2')),
  level       text NOT NULL CHECK (level IN ('NONE', 'VIEW', 'USE', 'APPROVE', 'ADMIN')),
  alias       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (username, module)
);

CREATE TABLE role_template (
  name         text PRIMARY KEY,
  description  text,
  role         text,                         -- บทบาทหลักที่ตั้งให้ผู้ใช้ (ADMIN / QA / WH_STAFF …)
  access       jsonb NOT NULL DEFAULT '{}',  -- { "WH13": "APPROVE", "QA": "APPROVE", ... }
  aliases      jsonb NOT NULL DEFAULT '{}',  -- { "WH13": "QA-001" }
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);

-- template เริ่มต้น (สรุปจากสิทธิ์ที่หน้าจอของลูกค้าฝังไว้ · ผู้ดูแลแก้ได้)
INSERT INTO role_template (name, description, role, access, aliases) VALUES
  ('ผู้ดูแลระบบ', 'ทุกส่วนระดับผู้ดูแล + จัดการผู้ใช้', 'ADMIN',
   '{"WH13":"ADMIN","V4":"ADMIN","QA":"ADMIN","BD02":"ADMIN","PRODUCTION":"ADMIN","DBV2":"ADMIN"}', '{"WH13":"Tom"}'),
  ('หัวหน้าโรงงาน', 'อนุมัติ / ปลดล็อกทุกอย่างในคลัง (เทียบ Tom ในหน้าจอเดิม)', 'WH_SUPERVISOR',
   '{"WH13":"ADMIN","V4":"ADMIN","QA":"APPROVE","BD02":"VIEW","PRODUCTION":"VIEW","DBV2":"ADMIN"}', '{"WH13":"Tom"}'),
  ('QA', 'ตรวจรับ, ส่ง/อนุมัติ FGT, Deviation, Hold/ปลด Hold (เทียบ QA-001)', 'QA',
   '{"WH13":"APPROVE","V4":"VIEW","QA":"APPROVE","PRODUCTION":"VIEW","DBV2":"VIEW"}', '{"WH13":"QA-001"}'),
  ('พนักงานคลัง', 'รับเข้า เบิก โอนย้าย จ่ายออก (เทียบ WH-002)', 'WH_STAFF',
   '{"WH13":"USE","V4":"USE","QA":"VIEW","PRODUCTION":"VIEW","DBV2":"VIEW"}', '{"WH13":"WH-002"}'),
  ('พนักงานชั่ง', 'ชั่งที่ V4 เท่านั้น', 'WEIGH_OPERATOR',
   '{"V4":"USE"}', '{}'),
  ('ฝ่ายผลิต', 'หน้าผลิต + วางแผน', 'PRODUCTION',
   '{"PRODUCTION":"USE","WH13":"VIEW","DBV2":"VIEW"}', '{}'),
  ('ฝ่ายขาย', 'BD02 + ดูสต็อก', 'WH_STAFF',
   '{"BD02":"USE","WH13":"VIEW","DBV2":"VIEW"}', '{"BD02":"BD002"}');

-- ผู้ดูแลที่มีอยู่แล้ว → สิทธิ์ทุกส่วน
INSERT INTO user_access (username, module, level, updated_by)
SELECT u.username, m.module, 'ADMIN', 'migration-004'
FROM app_user u CROSS JOIN (VALUES ('WH13'), ('V4'), ('QA'), ('BD02'), ('PRODUCTION'), ('DBV2')) AS m(module)
WHERE u.role = 'ADMIN'
ON CONFLICT DO NOTHING;

-- บัญชีเดิมที่ฝังในหน้าจอ → ย้ายเข้า DB แบบ "ปิด + ยังไม่มีรหัส" (ผู้ดูแลตั้งรหัสตอนเปิดใช้ — ไม่มีบัญชีรหัส 8888 / 1234 เปิดค้าง)
INSERT INTO app_user (username, full_name, role, dept, status, template, note, must_change_password) VALUES
  ('Tom',         'Tom (Authorized)',  'WH_SUPERVISOR',  'Factory',     'inactive', 'หัวหน้าโรงงาน', 'ย้ายจาก WH13 (Tom/8888)', true),
  ('QA-001',      'QA Officer',        'QA',             'QA',          'inactive', 'QA',            'ย้ายจาก WH13 (QA-001)', true),
  ('WH-002',      'Warehouse Supervisor', 'WH_STAFF',    'คลังสินค้า',   'inactive', 'พนักงานคลัง',    'ย้ายจาก WH13 (WH-002)', true),
  ('operator_01', 'พนักงานชั่ง 01',     'WEIGH_OPERATOR', 'คลังสินค้า',   'inactive', 'พนักงานชั่ง',     'ย้ายจาก V4', true),
  ('supervisor1', 'หัวหน้างาน คลัง',    'WH_SUPERVISOR',  'คลังสินค้า',   'inactive', 'หัวหน้าโรงงาน',   'ย้ายจาก V4', true),
  ('BD001',       'BD001 (Admin)',     'WH_STAFF',       'ฝ่ายขาย',      'inactive', 'ฝ่ายขาย',         'ย้ายจาก BD02', true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO user_access (username, module, level, alias, updated_by)
SELECT u.username, a.key, a.value #>> '{}', t.aliases ->> a.key, 'migration-004'
FROM app_user u
JOIN role_template t ON t.name = u.template
CROSS JOIN LATERAL jsonb_each(t.access) a
WHERE u.note LIKE 'ย้ายจาก %'
ON CONFLICT DO NOTHING;

-- BD001 = ผู้ดูแลฝ่ายขาย · alias ของ V4 / BD02 ตามชื่อเดิม
UPDATE user_access SET level = 'ADMIN', alias = 'BD001' WHERE username = 'BD001' AND module = 'BD02';
UPDATE user_access SET alias = username WHERE module = 'V4' AND username IN ('operator_01', 'supervisor1');
