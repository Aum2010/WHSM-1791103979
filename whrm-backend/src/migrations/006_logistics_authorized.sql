-- UI 26 ต.ค.: หน้า LG02 (ขนส่ง) = ส่วนใหม่ LOGISTICS · หน้าจอ WH13 / V4 ใช้รายชื่อ Authorized list (รหัสบัตร + PIN)
--   ชื่อ QA-001 / WH-002 ไม่มีในหน้าจอแล้ว → ล้าง alias เดิม (bridge ใช้รหัสบัตร / ชื่อผู้ใช้ของแต่ละคนแทน)
--   template ใหม่ตามแผนกใน Authorized list (หน้า users.html นำเข้า Excel แล้วจับคู่แผนก → template)

ALTER TABLE user_access DROP CONSTRAINT IF EXISTS user_access_module_check;
ALTER TABLE user_access ADD CONSTRAINT user_access_module_check
  CHECK (module IN ('WH13', 'V4', 'QA', 'BD02', 'PRODUCTION', 'DBV2', 'LOGISTICS'));

UPDATE user_access SET alias = NULL, updated_by = 'migration-006', updated_at = now()
WHERE (module = 'WH13' AND alias IN ('QA-001', 'WH-002')) OR (module = 'BD02' AND alias = 'BD002' AND username <> 'BD002');

UPDATE role_template SET aliases = aliases - 'WH13', updated_at = now(), updated_by = 'migration-006'
WHERE aliases ->> 'WH13' IN ('QA-001', 'WH-002');
UPDATE role_template SET aliases = aliases - 'BD02', updated_at = now(), updated_by = 'migration-006'
WHERE aliases ->> 'BD02' = 'BD002';
UPDATE role_template SET description = 'ตรวจรับ, ส่ง/อนุมัติ FGT, Deviation, Hold/ปลด Hold, DCC' WHERE name = 'QA';
UPDATE role_template SET description = 'รับเข้า เบิก โอนย้าย จ่ายออก · สิทธิ์อนุมัติในหน้าจอตามระดับใน Authorized list' WHERE name = 'พนักงานคลัง';

UPDATE role_template SET access = access || '{"LOGISTICS":"ADMIN"}', updated_at = now(), updated_by = 'migration-006'
WHERE name IN ('ผู้ดูแลระบบ', 'หัวหน้าโรงงาน');
UPDATE role_template SET access = access || '{"LOGISTICS":"VIEW"}', updated_at = now(), updated_by = 'migration-006'
WHERE name = 'พนักงานคลัง';

INSERT INTO role_template (name, description, role, access, aliases, updated_by) VALUES
  ('ฝ่ายโลจิสติกส์', 'คิวขนส่ง LG02 + ดูสต็อกคลัง', 'WH_STAFF',
   '{"LOGISTICS":"USE","WH13":"VIEW","DBV2":"VIEW"}', '{}', 'migration-006'),
  ('ผู้บริหาร', 'ดูได้ทุกส่วน (ไม่แก้ข้อมูล)', NULL,
   '{"WH13":"VIEW","V4":"VIEW","QA":"VIEW","BD02":"VIEW","PRODUCTION":"VIEW","DBV2":"VIEW","LOGISTICS":"VIEW"}', '{}', 'migration-006'),
  ('ฝ่ายสนับสนุน', 'HR / บัญชี / จัดซื้อ / ซ่อมบำรุง — ดูสต็อก + master', NULL,
   '{"WH13":"VIEW","DBV2":"VIEW"}', '{}', 'migration-006')
ON CONFLICT (name) DO NOTHING;

-- ผู้ดูแลระบบที่มีอยู่ → สิทธิ์ LOGISTICS ด้วย (/auth/me ให้ ADMIN ทุกส่วนอยู่แล้ว — แถวนี้ให้ตารางสิทธิ์แสดงตรง)
INSERT INTO user_access (username, module, level, updated_by)
SELECT username, 'LOGISTICS', 'ADMIN', 'migration-006' FROM app_user WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;
