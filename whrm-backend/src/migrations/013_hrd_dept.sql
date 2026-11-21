-- UI 1795227104 (21 พ.ย.): ทะเบียนหน่วยงาน + หัวหน้าแผนกอยู่ที่ server
--   หัวหน้าแผนก = ช่องในบัญชีกลาง (app_user.is_dept_head) · ตั้งได้ที่ HRD01 (ฝ่ายบุคคล / ผู้ดูแล)
--   server สร้าง whrm_hrd_employees_v1 + whrm_hrd_account_status_v1 จากบัญชีกลางให้ WH13 / V4 / BD02 อ่าน (เครื่องเขียนเองไม่ได้)
--   ทะเบียนหน่วยงาน hrd_dept_master_v1 เก็บใน kv_store (รูปแบบเดิมของลูกค้า) · เขียนได้เฉพาะผู้มีสิทธิ์ส่วน HRD

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_dept_head boolean NOT NULL DEFAULT false;
