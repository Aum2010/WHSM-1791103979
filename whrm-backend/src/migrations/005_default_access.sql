-- เริ่มกันการเปิดหน้าตามสิทธิ์ (ไม่มีสิทธิ์ส่วนไหน = เปิดหน้านั้นไม่ได้)
-- ผู้ใช้ที่มีก่อน migration 004 ยังไม่มีแถวใน user_access → ให้สิทธิ์ตาม template ที่ตรงกับบทบาทเดิม จะได้ไม่ถูกล็อกออกหลังอัปเดต
WITH map(role, template) AS (VALUES
  ('QA', 'QA'), ('WH_STAFF', 'พนักงานคลัง'), ('WH_SUPERVISOR', 'หัวหน้าโรงงาน'),
  ('WEIGH_OPERATOR', 'พนักงานชั่ง'), ('PRODUCTION', 'ฝ่ายผลิต')
), targets AS (
  SELECT u.username, t.name, t.access, t.aliases
  FROM app_user u
  JOIN map ON map.role = u.role
  JOIN role_template t ON t.name = map.template
  WHERE COALESCE(u.role, '') <> 'ADMIN'
    AND NOT EXISTS (SELECT 1 FROM user_access a WHERE a.username = u.username)
)
INSERT INTO user_access (username, module, level, alias, updated_by)
SELECT tg.username, a.key, a.value #>> '{}', tg.aliases ->> a.key, 'migration-005'
FROM targets tg CROSS JOIN LATERAL jsonb_each(tg.access) a
ON CONFLICT DO NOTHING;

UPDATE app_user u SET template = map.template
FROM (VALUES ('QA', 'QA'), ('WH_STAFF', 'พนักงานคลัง'), ('WH_SUPERVISOR', 'หัวหน้าโรงงาน'),
             ('WEIGH_OPERATOR', 'พนักงานชั่ง'), ('PRODUCTION', 'ฝ่ายผลิต')) AS map(role, template)
WHERE u.role = map.role AND u.template IS NULL
  AND EXISTS (SELECT 1 FROM user_access a WHERE a.username = u.username AND a.updated_by = 'migration-005');
