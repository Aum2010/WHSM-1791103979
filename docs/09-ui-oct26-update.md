# UI 26 ต.ค. 2026 — Authorized list · LG02 · QA DCC · เลขเอกสารมาตรฐาน

ไฟล์ลูกค้า: โฟลเดอร์ `1793020281` (WH-Test.rar + Authorized list.xlsx) · ต่อจาก [07-ui-oct22-update.md](07-ui-oct22-update.md) และ [08-user-management.md](08-user-management.md)

## 1. ลูกค้าเปลี่ยนอะไร

| เรื่อง | รายละเอียด |
|---|---|
| รายชื่อผู้ใช้ใหม่ (WHAUTH) | WH13 + V4 ใช้ตาราง `RAW` = Authorized list 57 คน (รหัสบัตร, PIN, แผนก, ตำแหน่ง, ระดับ, ฝั่ง WH/DC) · กฎสิทธิ์ตามระดับ Warehouse · SO อนุมัติได้เฉพาะ WH001 · EO / โอนออกนอกคลังต้อง 2 คน (WH Supervisor + DC Supervisor) · Tom = SUPER |
| บัญชีเก่าเลิกใช้ | QA-001 / WH-002 / operator_01 ฯลฯ ไม่อยู่ในหน้าจอแล้ว |
| หน้าใหม่ | **LG02** (Logistics Control Tower — คิว `whrm_logistic_queue_v1`) · **QA_DCC_02** (Document Control Center — `whrm_dcc_*`) |
| เลขเอกสารมาตรฐาน | `PREFIX + YYYYMMDD + SEQ4` · ตัวนับ `__idseq_<PFX>_<YYYYMMDD>` · แผนที่เลขเก่า `whrm_idmap_v1` · ปิดได้ `whrm_docid_std_off` |
| แก้แล้วโดยลูกค้า | ปุ่มยืนยัน FGT · แท็บเบิก/คืนเบียด → เอา hotfix 2 ตัวออก |

## 2. ความปลอดภัย: PIN จริงไม่อยู่ในโค้ดหน้าจอ

ผู้ใช้ยืนยันว่า PIN ใน Authorized list = **รหัสจริงของพนักงาน** → ห้ามขึ้น git / Vercel

- `scripts/import-ui.mjs <โฟลเดอร์ลูกค้า>` — นำไฟล์ลูกค้าเข้า `ui/` พร้อมลบรหัส (hotfix ชนิด `security`)
  แล้วตรวจซ้ำ: เอา PIN จริงจากต้นฉบับมาค้นทุกไฟล์ (ทั้ง `password: '…'` และ "รหัสบัตร … PIN" ใกล้กันใน log / คำอธิบาย) — เจอ = ล้ม ไม่เขียนอะไร
- `scripts/hotfixes.mjs` (ใช้ทั้งตอน import และ build):

| id | ไฟล์ | ทำอะไร |
|---|---|---|
| SEC-WHAUTH-PINS | WH13, V4 | `var RAW` → PIN เป็น `""` |
| SEC-WH13-DCSUP-PIN + WH13-DCSUP-LOGIN-SERVER | WH13 | บัญชีเปิดใบที่ล็อก (DC_SUP) → ลบรหัส + `checkSup` เรียก `__whrmCredOk` |
| SEC-BD02-PINS + BD02-LOGIN-SERVER | BD02 | `USERS` 7 ชุด ลบรหัส · ตัวตรวจ `user.password !== p` 7 ชุด → `__whrmCredOk(u, p, 'BD02')` |
| SEC-PIN-HINTS | BD02, WH13, V4 | ข้อความ "รหัสบัตร/PIN" ใน console / คำอธิบาย → `••••` |
| SEC-WH13-DEMO-8888 + WH13-IC-LOGIN-SERVER + WH13-IC-FIX-LOGIN-SERVER | WH13 | Info Center / Dev Gate (`__icDevOn`, `__wh13DevOn`, หน้าต่าง Developer Login) เลิกใช้ Tom/8888 → ตรวจที่ server **เฉพาะผู้มีสิทธิ์ WH13 ระดับผู้ดูแล** |
| SEC-DBV2-LOGIN + DBV2-LOGIN-SERVER | DBV2.0 | แก้ / ลบสเปกสินค้า: เลิกใช้ `qa_manager/123456` (เคยกรอกไว้ในช่องให้) → ตรวจที่ server **เฉพาะผู้มีสิทธิ์ DBV2 ระดับผู้ดูแล** · ล้างช่องรหัสทุกครั้งที่กด Login |
| WH13-RETURN-DUP-SEARCH | WH13 | (เดิม) ซ่อนปุ่มค้นหาซ้ำในแท็บคืน |

- build ล้มถ้ายังเจอรหัสใน RAW / USERS ของ BD02 / DC_SUP (`assertNoSecrets`)
- `.gitignore`: โฟลเดอร์ลูกค้า (ตัวเลข 10 หลัก), `*.xlsx`, `*.rar`
- **ข้อควรรู้:** BD02 รุ่นก่อน (commit ตั้งแต่ 14 ต.ค.) มีรหัส BD001–BD003 อยู่ในประวัติ git แล้ว → ควรเปลี่ยน PIN 3 คนนี้ (หรือเขียนประวัติ git ใหม่)
- Tom/8888 (บัญชีสาธิตเดิม) ก็ถูกลบจาก RAW เช่นกัน → ใช้ในหน้าจอไม่ได้แล้ว · ผู้ดูแลทำงานในนาม Tom ผ่าน server แทน

## 3. Login ในหน้าจอ → ตรวจที่ server (bridge)

ทุกหน้าต่างที่ถามรหัสใน WH13 / V4 (และตัวตรวจของ BD02) ส่งไป `POST /auth/verify`

- `/auth/verify` คืน `alias` (ที่ผู้ดูแลตั้ง), `user.cardId`, `defaultAlias` (ผู้ดูแล → `Tom`)
- bridge เลือก "ชื่อในหน้าจอ" อันแรกที่หน้าจอรู้จัก: **alias → รหัสบัตร → ชื่อผู้ใช้ → defaultAlias** · ไม่มีเลย → แจ้ง "ไม่พบ … ในรายชื่อผู้ใช้ของหน้าจอนี้"
- จากนั้นใส่รหัสใช้ครั้งเดียวชั่วคราวในตารางผู้ใช้ของหน้าจอ (`systemUsers`, `WHAUTH.users()`, V4 `USERS_DB`) แล้วปล่อยตัวตรวจเดิมทำงาน · คืนค่าภายใน 300 ms
- ช่องสแกนบัตร `UserID|PIN` + Enter → ตรวจที่ server แล้วเขียนกลับเป็น `ชื่อ|รหัสใช้ครั้งเดียว` · V4 ห่อ `v4LoginCardSubmit` / `submitSessionCard` (ปุ่ม / กล้อง)
- `window.__whrmCredOk(id, pw, module)` สำหรับตัวตรวจที่ถูกแก้ตอน build · จำผล 3 วินาที (BD02 ตัวตรวจ 7 ชุดทำงานพร้อมกัน — ไม่ให้นับรหัสผิดซ้ำจนบัญชีถูกล็อก)
- บัญชีที่หน้าจอยังมีรหัสฝังเอง (ถ้ามี) ยังตรวจในหน้าจอได้ — ปิดได้ `WHRM_CONFIG.legacyAppLogin = false`
- ข้อจำกัด: สแกนบัตรด้วยกล้องใน WH13 บางหน้าต่างที่เรียกฟังก์ชันตรง (ไม่ผ่าน Enter) ยังไม่ได้ทดสอบ

## 4. จัดการผู้ใช้: นำเข้า / ส่งออก Excel (ผู้ดูแลเท่านั้น)

หน้า `/users.html` → **นำเข้า Excel / CSV** · **ส่งออก Excel** · **ส่งออก CSV**

- อ่าน .xlsx ด้วย SheetJS (โหลดจาก cdnjs ตอนกดครั้งแรก — ต้องต่ออินเทอร์เน็ต; CSV ใช้ได้เสมอ)
- รับ 2 แบบ: ไฟล์ที่ส่งออกจากหน้านี้ (แก้ข้างนอกแล้วนำกลับ) หรือ **Authorized list** (CardID · Password · Department · Section, ตารางซ้าย/ขวา)
- Authorized list → ชื่อผู้ใช้ = รหัสบัตร, `card_id` = รหัสบัตร, รหัสผ่าน = PIN, ชื่อ = ตำแหน่ง, template ตามแผนก (เปลี่ยนได้ก่อนกดนำเข้า) · ตารางแสดง PIN เป็น `••••`

| แผนก | template |
|---|---|
| ERP Administration (Tom) | หัวหน้าโรงงาน |
| Warehouse | พนักงานคลัง |
| Quality assurance | QA |
| Production / Production planning | ฝ่ายผลิต |
| Business development | ฝ่ายขาย |
| Logistics | ฝ่ายโลจิสติกส์ (ใหม่) |
| Management | ผู้บริหาร (ใหม่ — ดูทุกส่วน) |
| HR / Finance / Purchase / Maintenance | ฝ่ายสนับสนุน (ใหม่ — ดูสต็อก + master) |

- แถวที่มีรหัส → เปิดใช้งาน · ตัวเลือก "ให้ตั้งรหัสใหม่ตอน login ครั้งแรก" (ค่าเริ่มต้น: ไม่ต้อง)
- รหัสผ่านขั้นต่ำ 4 ตัว (PIN) · ส่งออกไม่มีรหัสผ่าน · นำเข้าครั้งละไม่เกิน 2000 แถว

## 5. ส่วนใหม่ LOGISTICS + การ sync

- migration `006_logistics_authorized.sql`: เพิ่ม `LOGISTICS` ใน CHECK ของ `user_access` · template ใหม่ 3 ชุด · ล้าง alias QA-001 / WH-002 · ผู้ดูแลได้ LOGISTICS
- bridge: `LG02` → ส่วน LOGISTICS · `QA_DCC_02` → ส่วน QA · หน้ารวมมีคำอธิบาย 2 หน้าใหม่
- sync: `__idseq_<PFX>_<YYYYMMDD>`, `whrm_report_seq_*`, `whrm_print_seq_v1` = ตัวนับ (merge ค่ามากสุด) · `WMS-RA report`, `WMS-RMA report`, `WMS-FGT report` = ข้อมูลกลาง (ลบที่เครื่องเดียวไม่ลบที่ server) · backend allowlist ตรงกัน

## 6. ทดสอบ

- E2E (`whrm-backend/test/e2e.mjs`) บน stack แยก (DB `whrm_e2e`): proxy 128/128 · cross-origin 129/129 (รวม Info Center + DBV2 ผู้ดูแลเท่านั้น)
  - ใหม่ (14c): ไม่มี PIN ใน WH13 / V4 / BD02 · WH13 login รหัสบัตร (ปุ่ม + สแกนบัตร + PIN ผิด) · V4 login (ปุ่ม + บัตร) · BD02 login ผิด/ถูก + ไม่ล็อกเพราะตัวตรวจซ้ำ · `__idseq_` ขึ้น server · LG02 ไม่มีสิทธิ์ → เปิดไม่ได้ · นำเข้า Excel Authorized list → PIN ใช้ได้ · ส่งออก Excel
- เปิดทั้ง 12 หน้าผ่าน bridge: ไม่มี JS error เพิ่มจากไฟล์ต้นฉบับ
- local docker: backup DB ก่อน migration → `backups/whrm-before-006-*.dump`
