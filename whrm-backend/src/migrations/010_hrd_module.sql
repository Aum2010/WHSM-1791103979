-- HRD01 แบบย่อ (ตัดสินใจ 14 พ.ย.): HR + ผู้ดูแลจัดการพนักงาน / สิทธิ์ผ่านหน้า HRD01 · HR มองไม่เห็นผู้ดูแล · ให้ได้ถึงระดับ 4
--   ส่วนใหม่ HRD = เปิดหน้า HRD01 / เรียก /hr/users · ระดับ HRD01 ของแต่ละคน (1 Staff · 2 Officer · 3 Team Leader · 4 Supervisor)
--   เก็บแยกใน app_user.hrd_level เพื่อแสดงกลับใน HRD01 (สิทธิ์รายส่วนยังเป็น ใช้งาน / อนุมัติ ตามเดิม)

ALTER TABLE user_access DROP CONSTRAINT IF EXISTS user_access_module_check;
ALTER TABLE user_access ADD CONSTRAINT user_access_module_check
  CHECK (module IN ('WH13', 'V4', 'QA', 'BD02', 'PRODUCTION', 'DBV2', 'LOGISTICS', 'DCC', 'HRD'));

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS hrd_level smallint CHECK (hrd_level IN (1, 2, 3, 4, 99));
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS position text;

INSERT INTO user_access (username, module, level, updated_by)
SELECT username, 'HRD', 'ADMIN', 'migration-010' FROM app_user WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

UPDATE role_template SET access = access || '{"HRD":"ADMIN"}', updated_at = now(), updated_by = 'migration-010'
WHERE name = 'ผู้ดูแลระบบ';

INSERT INTO role_template (name, description, role, access, aliases, updated_by) VALUES
  ('ฝ่ายบุคคล (HR)', 'หน้า HRD01: เพิ่ม / แก้พนักงาน + ให้สิทธิ์ถึงระดับ 4 · มองไม่เห็นผู้ดูแลระบบ', NULL,
   '{"HRD":"USE","WH13":"VIEW","DBV2":"VIEW"}', '{}', 'migration-010')
ON CONFLICT (name) DO NOTHING;
