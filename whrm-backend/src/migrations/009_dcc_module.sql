-- UI 6 พ.ย.: หน้า QA_DCC_02 (ควบคุมเอกสาร) แยกสิทธิ์เป็นส่วน DCC · ผู้ใช้ของ DCC ย้ายมาใช้บัญชีกลาง (คำตอบลูกค้า 6 พ.ย.)
--   ระดับ: ดู = เปิดดู · ใช้งาน = จัดทำ / ส่งคำร้อง · อนุมัติ = ผู้อนุมัติเอกสาร (QA manager) · ผู้ดูแล = ผู้อนุมัติ + จัดการ DCC
--   ผู้ใช้เดิมที่เปิดหน้า DCC ได้ด้วยสิทธิ์ QA → ได้สิทธิ์ DCC ระดับเดียวกัน แต่ "อนุมัติ" ลดเป็น "ใช้งาน"
--   (ผู้อนุมัติเอกสาร = QA manager + ผู้ดูแลระบบ เท่านั้น — ผู้ดูแลตั้งให้ QA manager ที่หน้า User)

ALTER TABLE user_access DROP CONSTRAINT IF EXISTS user_access_module_check;
ALTER TABLE user_access ADD CONSTRAINT user_access_module_check
  CHECK (module IN ('WH13', 'V4', 'QA', 'BD02', 'PRODUCTION', 'DBV2', 'LOGISTICS', 'DCC'));

INSERT INTO user_access (username, module, level, updated_by)
SELECT username, 'DCC', CASE WHEN level = 'APPROVE' THEN 'USE' ELSE level END, 'migration-009'
FROM user_access WHERE module = 'QA' AND level IN ('VIEW', 'USE', 'APPROVE', 'ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO user_access (username, module, level, updated_by)
SELECT username, 'DCC', 'ADMIN', 'migration-009' FROM app_user WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

UPDATE role_template SET access = access || '{"DCC":"ADMIN"}', updated_at = now(), updated_by = 'migration-009'
WHERE name = 'ผู้ดูแลระบบ';
UPDATE role_template SET access = access || '{"DCC":"USE"}', updated_at = now(), updated_by = 'migration-009'
WHERE name = 'QA';
UPDATE role_template SET access = access || '{"DCC":"VIEW"}', updated_at = now(), updated_by = 'migration-009'
WHERE name IN ('ผู้บริหาร', 'หัวหน้าโรงงาน');
