# 08 — จัดการผู้ใช้รายส่วน (รอบ 1)

> สถานะ: 23 ต.ค. 2026 · backend 0.9.0-phaseA · migration `004_user_access.sql`, `005_default_access.sql` · E2E 92/92 (ข้ามโดเมน) · 91/91 (proxy) · รอบ 1 + รอบ 2 (WH13)
> หน้าจอ: `/users.html` (ผู้ดูแลระบบเท่านั้น — ลิงก์จากหน้ารวม)
> **อัปเดต 26 ต.ค.:** นำเข้า/ส่งออก Excel (Authorized list) · รหัสผ่านขั้นต่ำ 4 ตัว · ส่วน LOGISTICS · alias QA-001 / WH-002 เลิกใช้ (ใช้รหัสบัตร) — ดู [09-ui-oct26-update.md](09-ui-oct26-update.md)

## แนวคิด

- **1 คน = 1 บัญชี** ใน `app_user` (รหัส scrypt) · บทบาทหลัก `role` (`ADMIN` = ผู้ดูแลระบบ ได้ทุกส่วนเสมอ)
- **สิทธิ์รายส่วน** ใน `user_access` — ส่วน: `WH13` คลัง · `V4` ชั่ง · `QA` · `BD02` ขาย · `PRODUCTION` ผลิต + วางแผน · `DBV2` master
- **ระดับ**: `NONE` เปิดหน้าไม่ได้ · `VIEW` ดู · `USE` ใช้งาน · `APPROVE` อนุมัติ · `ADMIN` ผู้ดูแล (ไม่มีแถว = NONE)
- **alias** ต่อส่วน = ตัวตนที่หน้าจอของลูกค้าใช้ตรวจสิทธิ์ (WH13: `QA-001` / `WH-002` / `Tom`) — ใช้ในรอบ 2
- **template** (`role_template`) = ชุดสิทธิ์สำเร็จรูป: ผู้ดูแลระบบ · หัวหน้าโรงงาน · QA · พนักงานคลัง · พนักงานชั่ง · ฝ่ายผลิต · ฝ่ายขาย

## บัญชีเดิมที่ฝังในหน้าจอ

migration ย้าย `Tom`, `QA-001`, `WH-002`, `operator_01`, `supervisor1`, `BD001` เข้า DB **แบบปิด + ยังไม่มีรหัส** (ไม่มีบัญชีรหัส 8888 / 1234 เปิดค้างบน server) — ผู้ดูแลเปิดใช้โดยตั้งรหัสที่ `/users.html` · login ในหน้าจอ (Tom/8888 ฯลฯ) ยังทำงานแบบเดิมจนถึงรอบ 2

## API (`/api/v1`, ADMIN)

| | |
|---|---|
| `GET /users/meta` | ส่วน · ระดับ · บทบาท · ฝ่าย · บัญชีที่ถูกล็อก |
| `GET /users?q=&status=&dept=&role=&module=` | รายชื่อ + สิทธิ์รายส่วน |
| `GET /users/:username` | รายละเอียด |
| `POST /users` | สร้าง `{ username, fullName, dept, role, cardId, template, password, mustChangePassword, status, access }` · ไม่มีรหัส = สร้างแบบปิด |
| `PUT /users/:username` | แก้ (ส่งเฉพาะช่องที่เปลี่ยน) · `password` = รีเซ็ต · `status: inactive` = ปิด (session หลุดทันที) |
| `PUT /users/:username/access` | แก้สิทธิ์ `{ WH13: 'USE', BD02: { level: 'VIEW', alias: 'BD002' } }` |
| `POST /users/bulk-access` | `{ usernames, module, level }` |
| `POST /users/:username/unlock` | ปลดล็อก (ใส่รหัสผิด 5 ครั้ง) |
| `DELETE /users/:username` | ลบถาวร `{ confirm: username }` — เฉพาะบัญชีที่ไม่เคยใช้งาน (เคยใช้ → 409 ให้ปิดบัญชีแทน) |
| `POST /users/import` | `{ csv }` หรือ `{ rows }` (หน้า users.html แปลงจาก Excel) + `mustChangePassword` — หัวคอลัมน์เหมือนไฟล์ส่งออก + `password` · ช่องส่วน `USE` หรือ `APPROVE:WH001` · แถวที่มีรหัส = เปิดใช้ · ผลรายแถว |
| `GET /users/export.csv` | ส่งออก (ไม่มีรหัสผ่าน · มี BOM ให้ Excel อ่านไทยได้) |
| `GET /users/audit?username=` | ประวัติ: สร้าง/แก้/ลบ/ปลดล็อก/นำเข้า/ส่งออก/template + login / รหัสผิด |
| `GET/POST /role-templates` · `PUT/DELETE /role-templates/:name` · `POST /role-templates/:name/apply` | template · `PUT` ส่ง `applyToUsers: true` = ใช้กับคนที่ใช้ template นี้อยู่ด้วย · ลบได้เมื่อไม่มีคนใช้ |

ทุกคน: `GET /auth/me` คืน `access` (สิทธิ์รายส่วน) + `user.mustChangePassword`

## กันพลาด

- ผู้ดูแลลดสิทธิ์ / ปิด / ลบบัญชีตัวเองไม่ได้ · ต้องมี ADMIN ที่ใช้งานได้อย่างน้อย 1 คน
- เปิดใช้บัญชีต้องมีรหัส · รหัสบัตรห้ามซ้ำ
- **บังคับตั้งรหัสใหม่**: บัญชีที่ผู้ดูแลตั้ง/รีเซ็ตรหัส → login แล้วทุก API ตอบ `403 PASSWORD_CHANGE_REQUIRED` จนกว่าจะตั้งรหัสใหม่ · หน้า login และ bridge พาไปหน้าตั้งรหัสเอง แล้วกลับหน้าเดิม
- ทุกการแก้บันทึก `audit_log` (append-only) พร้อมค่าก่อน → หลัง

## รอบ 2 (WH13) — ทำแล้ว

| | |
|---|---|
| `POST /auth/verify` | `{ username, password, module, minLevel }` → ตรวจรหัส (นับผิด/ล็อกร่วมกับ login) → `{ alias, level, user }` · บันทึก `APP_LOGIN` / `APP_LOGIN_FAIL` (actor = คนจริง, `by` = บัญชีที่ login เครื่องนั้น) |
| alias เริ่มต้น (ไม่ได้กรอก) | ตั้งแต่ 26 ต.ค.: รหัสบัตร → ชื่อผู้ใช้ → ผู้ดูแล = `Tom` (WH13 / V4) · ดู → login ในหน้าจอไม่ได้ · (เดิม: อนุมัติ → `QA-001` · ใช้งาน → `WH-002`) |
| bridge — หน้าต่าง login WH13 (`__rmaGatePwdVerify`) + ปุ่ม login sidebar (`tryLogin`) | ชื่อที่ไม่อยู่ในบัญชีเดิม → ตรวจที่ server → ใส่รหัสใช้ครั้งเดียวชั่วคราวให้ตัวตรวจเดิมผ่านในนาม alias แล้วคืนค่าทันที |
| bridge — Info Center | ผ่านเฉพาะสิทธิ์ WH13 ระดับผู้ดูแล → ทำงานในนาม `Tom` |
| bridge — กันเปิดหน้า | ส่วนของหน้านั้นเป็น `NONE` → ขึ้น "🔒 ไม่มีสิทธิ์ใช้หน้านี้" |
| บัญชีเดิม (Tom/8888 ฯลฯ) | ยังใช้ได้ช่วงเปลี่ยนผ่าน · ปิด: `WHRM_CONFIG.legacyAppLogin = false` |
| migration 005 | ผู้ใช้ที่มีก่อน 004 ได้สิทธิ์ตาม template ของบทบาทเดิม (ไม่ถูกล็อกออก) |

เพิ่มเติม (23 ต.ค.):
- ดักที่ **ปุ่มยืนยันของทุกหน้าต่างที่มีช่องรหัส** (คลิกหรือกด Enter) แทนการดักทีละฟังก์ชัน — WH13 มีตัวตรวจหลายชุด (`attemptManualLogin`, `rmaGatePwdVerify`, `verifyOverridePassword`, `verifyCancelPassword` …) · หลังยืนยันช่อง User ID กลับเป็นชื่อจริง
- **แสดงชื่อบทบาทแทนชื่อบัญชีทดสอบ** ทุกข้อความบน WH13: Tom → ผู้ดูแล · QA-001 → QA · WH-002 → พนักงานคลัง (เฉพาะตัวหนังสือที่แสดง ข้อมูลที่ WH13 บันทึกยังเป็นชื่อเดิม) · ปิดได้ `WHRM_CONFIG.relabelAliases = false`

ข้อจำกัด: ผู้ที่ต้องตั้งรหัสใหม่ (`must_change_password`) ใช้ login ในหน้าจอไม่ได้จนกว่าจะ login ระบบแล้วตั้งรหัส · WH13 ยังมีแค่ 3 ตัวตน (สิทธิ์ละเอียดกว่านี้ = Phase B)

## รอบถัดไป

| รอบ | งาน |
|---|---|
| 3 | V4 + QA Deviation ใช้บัญชีกลาง · login ด้วยการสแกนบัตร (`card_id`) |
| Phase B | ตรวจสิทธิ์ที่ API ทุกการเขียนข้อมูล (hard lock — REQ-F-007 / S-001) |
