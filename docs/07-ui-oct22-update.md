# 07 — UI ชุด 22 ต.ค. 2026: Master Data (DBV2.0), QA, Production Planning

> ที่มา: `1792678061/` (WH-Test 21–22 ต.ค. + `01_Requirements_Developer_Summary` + `02_TestCase_Developer_Summary`)
> สถานะ: เข้าระบบแล้ว 22 ต.ค. 2026 · backend 0.7.0-phaseA · E2E 63/63 (ข้ามโดเมน) · 62/62 (proxy)

## 1. ไฟล์ใน `whrm-frontend/ui/`

| ไฟล์ | สถานะ | URL |
|---|---|---|
| `WH13.html` | แก้ — QA Hold/Release bridge (ตั้ง/ปลด Hold ผ่าน QA Deviation เท่านั้น), FGT มีคอลัมน์ลูกค้า, อ่าน master จาก DBV2.0 | `/WH13.html` |
| `V4.html` | แก้ — อ่าน master จาก DBV2.0 | `/V4.html` |
| `BD02.html` | แก้ใหญ่ — เลือกสินค้าจากสต็อก WHC, จองสต็อก, ราคาแพ็ก, login + audit, KPI | `/BD02.html` |
| `Production module/production-stockcard.html` | แก้ — แสดง QA Hold | `/Production-module/production-stockcard.html` |
| `DBV2.0.html` + `dbv2.json` | **ใหม่** — Master Data (สินค้า ~500, หมวดหมู่, ผู้ขาย, ลูกค้า, audit) | `/DBV2.0.html` |
| `QA_Deviation_06.html` | **ใหม่** — ออก Deviation → Hold / ปลด Hold Lot | `/QA_Deviation_06.html` |
| `QAincoming03.html` | **ใหม่** — QA ตรวจรับวัตถุดิบขาเข้า | `/QAincoming03.html` |
| `Production planning301.html` | **ใหม่** — วางแผนผลิต BOM/MRP (ทำงานแยก ไม่เก็บ/ไม่ส่งข้อมูล) | `/Production-planning301.html` |

ไม่ใช้: `index.html` ของลูกค้า, `Production module/Main page/`, `Product catagoery/*.jpg` (รูปใบรายการสินค้า — ข้อมูลอ้างอิง)

## 2. สิ่งที่แก้

| ที่ | แก้อะไร | ทำไม |
|---|---|---|
| bridge `SHARED_KEYS` | sync master ของ DBV2.0: `pmp_master_v66`, `pmp_categories_v66`, `pmp_main_categories_v66`, `pmp_mapping_v66`, `pmp_suppliers_v1`, `pmp_audit_v66`, `pmp.crm.customers.v4` · `pmp_role_v66` คงเป็นค่าเฉพาะเครื่อง | เดิม WH13 เครื่องที่ไม่เคยเปิด DBV2.0 มีสินค้าแค่ 13 รายการ (ชุดสำรองในโค้ด) — ตอนนี้ได้ 498 ทุกเครื่อง และแก้ที่ DBV2.0 ครั้งเดียวทุกเครื่องเห็น |
| bridge — ลบ master | การลบ key master (เช่น ปุ่ม "Hard Reset" ของ DBV2.0) มีผลเฉพาะเครื่องนั้น → reload แล้วได้ master จาก server กลับมา | Hard Reset ลบแค่ 2 key (น้อยกว่าเกณฑ์ตรวจการล้างข้อมูล 4 key) → ทดสอบพบว่า master กลางถูกลบทุกเครื่อง |
| bridge `ID_FIELDS` | + `c` (รหัสสินค้าใน master) | 2 เครื่องแก้สินค้าพร้อมกัน → รวมตามรหัส ไม่เกิดแถวซ้ำ |
| bridge ชื่อแอป | `DBV2`, `QA-DEV`, `QA-IN`, `PLANNING` | หน้ารวม "เครื่องที่เชื่อมต่ออยู่" |
| backend `sync.js` | รับ key master ข้างบน (เดิมรับเฉพาะ `whrm*`) | ไม่งั้น PUT ได้ 400 |
| หน้ารวม | ชื่อ/คำอธิบาย 10 หน้า | |

ใช้ข้ามเครื่องได้โดยไม่ต้องแก้: QA Deviation ↔ WH13 (`whrm_qa_*`, channel `whrm-qa-deviation-v1`), QA Incoming (`whrm_qa_requests_v1`), BD02 จอง/คำสั่งซื้อ (`whrm_bd*`), WH13 → BD02 แจ้งจ่ายของ (`whrm-bus`)

> **Deploy:** ต้องขึ้น backend (Railway) ก่อนหรือพร้อม frontend — frontend ใหม่ + backend เก่า = master ส่งไม่ขึ้น (400) จนกว่า backend จะอัปเดต

## 2b. Hotfix: ปุ่มยืนยัน FGT ไม่สร้างใบ (23 ต.ค. 2026)

WH13 22 ต.ค. มี patch "แยกหน่วย / Sub-row" เขียนทับ `handleFGTSubmit` ด้วยตัวที่ขึ้น toast "✅ ส่งคำขอ FGT สำเร็จ!" แล้วล้างฟอร์มเท่านั้น (`_origFGTSubmit` ไม่ถูกเรียก) → ไม่ถาม login, ไม่ออกเลข, ไม่เข้าคิว FGT Approval
- แก้ชั่วคราวที่ [`scripts/hotfixes.mjs`](../whrm-frontend/scripts/hotfixes.mjs) (`WH13-FGT-SUBMIT-STUB`): แทนบรรทัด toast + ล้างฟอร์ม ด้วย `return _origFGTSubmit.call(this, e)` ตอน build — `ui/` และ `dist/raw/` ยังเป็นต้นฉบับ
- ทดสอบ: กดยืนยัน → ถาม login QA-001 → ได้ `FGT202610230001` PENDING ในคิว
- ข้อจำกัด: แถวย่อย (ปุ่ม ⑂ แยกหน่วย) ยังไม่ถูกส่งไปกับใบ — รอทีม UI รวม sub-row เข้ากับตัวสร้างคิว
- แจ้งทีม UI: ใน PART 5 ของ patch แยกหน่วย ให้เรียก `_origFGTSubmit(e)` (หรือส่ง items ที่รวม sub-row เข้า FGT-B) แทนการขึ้น toast เอง

## 2c. Hotfix: ปุ่ม "ค้นหาใน DB" ซ้ำ 2 ปุ่มในแท็บ "2. คืน" (24 ต.ค. 2026)

ต้นฉบับของลูกค้าเองก็เป็น (ไม่เกี่ยวกับ bridge) — มีปุ่มจาก ReturnFlow (`retQuickSearch`) + SearchDB v1 · patch `Fix-v14c` ของลูกค้าตั้งใจลบปุ่ม ReturnFlow ด้วย rAF watchdog แต่ patch "RAF HARD KILL" / "FGA-Final-Kill" หยุด rAF ทั้งหน้า → ปุ่มซ้ำค้าง
- แก้ที่ [`scripts/hotfixes.mjs`](../whrm-frontend/scripts/hotfixes.mjs) (`WH13-RETURN-DUP-SEARCH`): ซ่อนปุ่ม `retQuickSearch` ในแท็บคืนด้วย CSS — เหลือ SearchDB v1 ตามที่ Fix-v14c ตั้งใจ · แท็บเบิก / FGT มีปุ่มเดียวอยู่แล้ว
- แจ้งทีม UI: Fix-v14c ใช้ rAF ซึ่งถูก patch อื่นฆ่า — ควรลบปุ่ม ReturnFlow ที่ต้นทาง

## 2d. Hotfix: แท็บ "1. เบิก" / "2. คืน" เบียด (24 ต.ค. 2026)

WH13 22 ต.ค. เปลี่ยนแท็บ FGT เป็นเต็มจอ (`max-w-4xl` → `w-full`) แต่เบิก / คืน ยังกว้างสุด ~900px → ตาราง 8 คอลัมน์ต้องเลื่อนซ้ายขวา ชื่อสินค้าถูกตัด
- `WH13-REQ-PANEL-WIDTH` ใน `scripts/hotfixes.mjs`: `#reqPanel-issue, #reqPanel-return` กว้างเต็มเท่า FGT (ทดสอบที่จอ 1600px: ทั้ง 3 แท็บกว้าง 1288px)
- แจ้งทีม UI: เปลี่ยน class ของ `reqPanel-issue` / `reqPanel-return` เป็น `w-full` แบบเดียวกับ FGT

## 3. ยังติด

| เรื่อง | ผล | รอ |
|---|---|---|
| BD02 → WH13 ส่ง SO ผ่าน `pmp.bridge.bd2wh13` | ข้ามเครื่องไม่ได้ (ทิศกลับได้แล้ว) | ลูกค้า: ใช้คนละเครื่องไหม |
| QAincoming03 ลิงก์ `QMS_Deviation_UI_Kouhaku_Theme.html` | 404 (น่าจะเป็นชื่อเก่าของ QA_Deviation_06) | ทีม UI |
| Production planning301 ไม่รับคำขอผลิตจาก Info Center | webhook PL ยังไม่มีปลายทาง | ลูกค้า |
| QA Hold ล็อกเฉพาะใน UI | ยังไม่ hard lock ที่ API/DB (REQ-F-007) | Phase B |
| V4 `if (banner4-RMA v2.7)` บรรทัด 6780 | patch block นั้นไม่ทำงาน | ทีม UI |

## 4. ERD ของลูกค้า (54 ตาราง) เทียบกับ `02-erd.md`

| กลุ่ม | ตารางของลูกค้า | ของเรา |
|---|---|---|
| มีแล้ว / ใช้อยู่ (Phase A) | `auth_sessions`, `audit_logs`, `devices` | `auth_session`, `audit_log`, `device` |
| มีใน design (ชื่อต่าง) | `roles`, `permissions`, `role_permissions`, `employees`, `items`, `item_categories`, `suppliers`, `customers`, `warehouses`, `lots`, `stock_balances`, `stock_ledger`, `qa_requests`, `deviation_docs`, `lot_holds`, `documents`, `document_lines`, `number_sequences`, `print_jobs` | `ROLE`, `PERMISSION`, `ROLE_PERMISSION`, `APP_USER`, `PRODUCT`, `PRODUCT.category`, `SUPPLIER`, `CUSTOMER`, `WAREHOUSE`, `LOT`, `STOCK_BALANCE`, `STOCK_MOVEMENT`, `QA_ISSUE`, `QA_ISSUE`/`QA_DECISION`, `QA_DECISION`, `RO_DOCUMENT`/`REQUISITION`/`TRANSFER`…, `*_ITEM`, `DOC_SEQUENCE`, `PRINT_JOB` |
| **ใหม่สำหรับเรา** | `employee_cards`, `locations` (zone/bin), `workstations`, `lot_status_history`, `hold_movements`, `pick_allocations` (FIFO/FEFO), `stock_reservations` (BD02), `trace_links`, `production_orders`, `production_batches`, `production_steps`, `step_materials`, `step_outputs`, `bom_headers`, `bom_components`, `rework_orders`, `rework_rounds`, `scale_readings`, `scan_events`, `barcode_labels`, `label_templates`, `notification_events`, `notification_rules`, `notification_templates`, `notification_deliveries`, `security_events`, `app_error_logs`, `export_jobs`, `payments`, `doc_types`, `document_files`, `document_status_history` | เพิ่มตอนเริ่ม Phase B — ใช้ DDL ในเอกสารลูกค้า §11 เป็นจุดตั้งต้น |

## 5. ให้ผู้ใช้ทดสอบ (UAT)

ดูรายการในข้อความสรุปถึงผู้ใช้ / คู่มือ — สรุป: master ข้ามเครื่อง · Hard Reset · QA Hold ข้ามเครื่อง · QA Incoming · BD02 จองสต็อก · V4 ยืนยันก่อนส่ง · หน้าใหม่เปิดได้ครบ
