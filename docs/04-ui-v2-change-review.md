# 04 — UI เวอร์ชันใหม่ (`1790951454/`) : ตรวจการเปลี่ยนแปลง + ผลต่อ design

> เทียบ `Archive/V4.html`, `Archive/WH13.html` (30 ก.ย. 2026) กับ `Archive/1790951454/` (V4 2 ต.ค. · WH13 1 ต.ค.)
> ตรวจด้วย: diff (ไม่นับ whitespace), เทียบโครงสร้าง (function / key / bus message / id), ตรวจ syntax ทุก `<script>`,
> และรัน UI ใหม่ผ่าน WH-RM server จริง (E2E 23 ข้อ + ทดสอบ flow ใหม่)
> ประกอบ [BACKEND-DESIGN.md](../BACKEND-DESIGN.md) · [02-erd.md](02-erd.md) · [03-api.md](03-api.md)

## 1. สรุปสั้น

| | เดิม | ใหม่ | สาระ |
|---|---|---|---|
| V4.html | 7,422 บรรทัด · 21 script | 9,785 บรรทัด · 34 script | **+PRP**, **+ช่อง BBF/EXP (วันหมดอายุ)**, ปรับ RMA mode, รับคำสั่งยกเลิก RU, จัดการ timer/console |
| WH13.html | 38,088 บรรทัด · 136 script | 39,657 บรรทัด · 142 script | **+PRP ฝั่งรับ (ล็อก GR + ขอปลดล็อกผ่าน QA)**, คืนจากฝ่ายผลิต → สร้าง RU, ตัวแปรหลักเปิดให้ patch ใช้ได้, ฟอร์มไม่เติมแถวตัวอย่าง |
| server.ps1 / .bat | — | เหมือนเดิม | — |
| Master data | สินค้า 8 / ลูกค้า 4 / คลัง 14 / users | **เหมือนเดิม** | — |

**ใช้กับ backend Phase A ได้ทันที** — E2E 23/23 ผ่านกับ UI ใหม่ ไม่ต้องแก้ bridge

## 2. รายการเปลี่ยนแปลง

### V4.html
| # | เรื่อง | รายละเอียด | ผลทางธุรกิจ |
|---|---|---|---|
| V1 | **PRP (Preparing Station)** | ประเภทการชั่งใหม่ `PRP` → Report ID `PRP{YYYYMMDD}-{NNNN}` + ไอคอนม่วง | ชั่งของที่เตรียมส่งเข้า WHSM07 รอฝ่ายผลิตสแกนรับ |
| V2 | **BBF/EXP** | ช่องใหม่ต่อจาก Lot/Batch (รูปแบบ `วว/ดด/ปปปป`) · เก็บใน basket / logs · พิมพ์บนฉลาก · อยู่ใน CSV/Excel · **ส่งไปกับ `TRIP_SAVED`** (`items[].bbfExp`) | มีวันหมดอายุราย Lot ครั้งแรก — ฐานของ FEFO |
| V3 | RMA mode ปรับใหม่ | `RMA ITEM BRIDGE` (เติมสินค้าที่ขาดใน dropdown), `CATEGORY FIX` ×3, `TYPE ENFORCER` (โหมด RMA บังคับประเภท = คืน), `ACTIVE MODE FORCER`, `I4.7` (กรอง dropdown เฉพาะรายการในคำขอ + เพิ่มทั้งหมดในโหมดนับ) | ชั่งของคืนได้ถูกประเภทและเร็วขึ้น |
| V4 | ยกเลิก RU จาก WH13 | ฟัง `RMA_CANCEL_RU` → ออกจากโหมด RMA, ล้าง request, ใส่ blacklist (`whrm_v4_cancel_blacklist_v1`) → ตอบ `RMA_CANCEL_RU_DONE` | ยกเลิกงานคืนแล้วเครื่องชั่งหยุดรอ |
| V5 | Phase 1 Cleanup | ครอบ `window.setInterval` บล็อก timer ซ้ำ 4 ตัว + ชะลอ 1 ตัว · กรอง `console.log` ของ patch เก่า | ลดภาระเครื่อง (ไม่มีผลต่อ bridge — bridge ใช้ timer ใน Worker) |
| V6 | `inventoryDB` เปิดให้ `window` | getter ผ่าน `Object.defineProperty` | patch อื่นอ่าน master ได้ |
| V7 | ลบ function เก่า 17 ตัว | ชุด RMA v1 (`setRmaMode`, `sendRmaResult`, …) ถูกแทนด้วยชุดใหม่ | — |

### WH13.html
| # | เรื่อง | รายละเอียด | ผลทางธุรกิจ |
|---|---|---|---|
| W1 | **PRP ฝั่งรับ** | badge ม่วง, banner, รายการ PRP ติด `_isPRP`, `prpStatus=pending`, `_destWh=WHSM07`, **ล็อกประเภทตรวจรับเป็น GR**, เก็บ `prpReportId` ใน RO item และแสดงในแถวย่อย | ของเตรียมผลิตรับเข้าโดยไม่ต้องผ่าน QA |
| W2 | **ขอปลดล็อก PRP → QA** | ปุ่ม "ปลดล็อก" → ยืนยันตัวตน → บันทึกคำขอ `PRP_INSPECTION_CHANGE` ลง `whrm_qa_issues_v1` | เปลี่ยน GR→QA ต้องผ่าน QA (แต่ **ยังไม่มีหน้าจอให้ QA อนุมัติ** — ดู §4) |
| W3 | **คืนจากฝ่ายผลิต = สร้าง RU** | `Phase 1 RU Hook` ดักฟอร์ม เบิก/คืน → แท็บคืน: **ไม่ลง Stock Card ทันทีแล้ว** แต่สร้างคำขอคืน RU (`PENDING`) เข้าคิว RMA | ของคืนต้องชั่ง + ตรวจก่อนเข้าคลัง (process เปลี่ยน) |
| W4 | รับ "ยกเลิกเสร็จ" จาก V4 | ฟัง `RMA_CANCEL_RU_DONE` → log (`whrm_v4_cancel_done_log_v1`) + ไฮไลต์แถว + ป้าย "V4 ล้างแล้ว" | เห็นว่าเครื่องชั่งรับรู้การยกเลิก |
| W5 | **ตัวแปรหลัก `let` → `var` + expose** | `roStatusStore`, `selectedROIds`, `inspectionTypeRules`, `weighingModalRecords` | **แก้ปัญหาที่พบรอบก่อน:** WH13 ส่ง `TRIP_IMPORTED` ได้จริงแล้ว → สถานะใน V4/DB อัปเดตเอง (ทดสอบแล้ว) |
| W6 | Balance ราย Lot สำหรับ RMA | `Phase 2 Balance Fix` คำนวณยอดคงเหลือแยก code+Lot ข้ามคลัง ให้การตรวจ RMA | แก้เฉพาะฝั่ง RMA — **Stock Card หลักยังคิดยอดรวมทั้งคลังเหมือนเดิม** |
| W7 | ฟอร์มไม่เติมแถวตัวอย่าง | จ่ายออก / เบิก / คืน / FGT / โอน เริ่มเป็นตารางว่าง | ลดการบันทึกข้อมูลตัวอย่างผิด ๆ |
| W8 | Dev panel ต้อง login | ตรวจผู้ใช้ก่อนเปิด + log `whrm_dev_audit_v1` | — |
| W9 | Toast | ย้ายจากกลางบนไปขวาบน | — |

## 3. ผลการทดสอบกับ WH-RM server (port 8001, DB แยก `whrm_v2test`)

| ทดสอบ | ผล |
|---|---|
| E2E เดิม 23 ข้อ (bus ข้ามเครื่อง, sync, conflict, purge, ไม่มี JS error เพิ่มจาก bridge) | ✅ 23/23 |
| V4 ชั่ง PRP ผ่าน `saveEntireTrip()` จริง → WH13 อีกเครื่อง | ✅ `PRP20261002-0004` → WH13: `_isPRP`, `pending`, `GR` ล็อก, `WHSM07` · DB: `weighing_type=PRP` |
| BBF/EXP เดินทางถึง server | ✅ `items[].bbfExp = "15/10/2026"` อยู่ใน bus · DB เก็บใน `raw` (ยังไม่มีคอลัมน์) |
| WH13 import จริง → `TRIP_IMPORTED` | ✅ ส่งเองแล้ว (รอบก่อนไม่ส่ง) · DB → `IMPORTED` |
| Syntax ทุก `<script>` | ❌ V4 ใหม่ 1 จุด (ดู §4-1) · WH13 ไม่มี |

## 4. ปัญหาที่พบในเวอร์ชันใหม่

| # | ระดับ | ปัญหา | หลักฐาน | แนะนำ |
|---|---|---|---|---|
| 1 | กลาง | **V4 มี syntax error** — `if (banner4-RMA v2.7) {` (เดิมคือ `if (banner) {`) น่าจะเกิดจาก find/replace ทั้งไฟล์ ทำให้ script block "Table 2 Status Explainer" ทั้งก้อนไม่ทำงาน | `1790951454/V4.html:6710` · หน้า `?bridge=0` ก็ error | แก้กลับเป็น `if (banner)` · block นี้เป็นโค้ดของ WH13 ที่ติดมาใน V4 พิจารณาลบทิ้ง · ควรตรวจ syntax ก่อนส่งทุกครั้ง |
| 2 | สูง | **BBF/EXP ไปไม่ถึงคลัง** — V4 ส่งมา แต่ WH13 ไม่อ่าน `bbfExp` เลย (0 จุด) → RO / Stock Card ไม่มีวันหมดอายุ → ทำ FEFO ไม่ได้ | `grep bbfExp WH13.html` = 0 | backend เก็บจาก bus/save-trip เข้า `lot.exp_date` (Phase B) · หรือให้ทีม UI map ใน `mapV4Item` |
| 3 | สูง | **คลัง WHSM07 ไม่มีใน master** — PRP ตั้ง `_destWh='WHSM07'` แต่รายการคลัง 14 คลังไม่มี WHSM07 · `addStockCardEntry` กับคลังที่ไม่มีจะเงียบ ๆ ไม่บันทึก | `warehouses` ไม่มี WHSM07 | เพิ่ม WHSM07 ใน master ทั้ง UI และ backend · ยืนยันกับลูกค้าว่า PRP รับเข้าคลังไหน |
| 4 | กลาง | **คำขอปลดล็อก PRP ไม่มีคนอนุมัติ** — บันทึกลง `whrm_qa_issues_v1` ได้ แต่ยังไม่มีหน้าจอ QA approve/reject (มีแค่ debug function) | roadmap PRP Phase 2 | backend: `qa_issue` + `GET/POST /qa/issues` |
| 5 | กลาง | **ยกเลิก RU ยังทำไม่ครบ** — V4 พร้อมรับ `RMA_CANCEL_RU` แต่ **WH13 ไม่มีจุดส่ง** (มีแค่ฟังก์ชันจำลอง) | `grep "RMA_CANCEL_RU'" WH13.html` → ไม่มีผู้ส่ง | ให้ `rmaCancelSession` ส่ง message · หรือ backend `/returns/{ruNo}/cancel` เป็นผู้ส่ง |
| 6 | ต่ำ | **รูปแบบปีของ BBF/EXP** — ช่องรับ `วว/ดด/ปปปป` แบบพิมพ์เอง ไม่ตรวจรูปแบบ · พนักงานอาจพิมพ์ พ.ศ. (2569) หรือ ค.ศ. (2026) | patch BBF/EXP ไม่มี validation | กำหนดให้ชัด + server แปลง (ปี > 2400 → −543) และ reject รูปแบบผิด |
| 7 | ต่ำ | คำว่า "คืน" มี 2 ความหมาย — ประเภทการชั่ง `คืน`(REE) กับคืนจากฝ่ายผลิต (RU) · หลังเปลี่ยน W3 ของคืนต้องผ่าน RU เสมอ แต่ REE จาก V4 ยังเข้า inbox รับเข้าแบบเดิมได้ | — | ยืนยัน flow คืนที่ถูกต้องกับลูกค้า |
| 8 | ต่ำ | Patch ซ้อนยังเพิ่ม — V4 script 21→34, WH13 136→142 · มี patch "fix ของ fix" (CATEGORY FIX v1.0.0 → 1.0.1 → 1.0.4 → 1.0.4.1, BBF/EXP hotfix 1.0.1–1.0.4) | — | วางแผนรวม patch ก่อน go-live |

**ปัญหาเดิมที่ยังอยู่:** Stock Card คิดยอดรวมทั้งคลัง · จ่าย/เบิก/โอนไม่ตรวจของพอและ Hold · หน้าอนุมัติยังไม่มีผลจริง · รหัส/PIN อยู่ในโค้ด · ชื่อสินค้า 3A001 ไม่ตรงกันระหว่าง V4 ("มันหมูสด") กับฟอร์มหลักของ WH13 ("เนื้อหมูสันนอก")

## 5. ผลต่อ design backend

### 5.1 Phase A (ที่ทำแล้ว) — ไม่ต้องแก้ เพิ่มเล็กน้อย

| เรื่อง | ทำ |
|---|---|
| UI ที่เสิร์ฟ | ชี้ `UI_DIR` ไปที่ `1790951454/` (หรือย้ายไฟล์ใหม่ขึ้นมาแทนไฟล์เดิม) |
| key ใหม่ที่ sync | `whrm_qa_issues_v1` (คิว QA ใช้ร่วม), `whrm_v4_cancel_blacklist_v1` (ทุกสถานีชั่งต้องรู้ RU ที่ยกเลิก), `whrm_v4_cancel_done_log_v1`, `whrm_dev_audit_v1` — **sync ทั้งหมด** (ค่า default ของ bridge ถูกอยู่แล้ว) |
| bus message ใหม่ | `RMA_CANCEL_RU`, `RMA_CANCEL_RU_DONE` — relay ได้เลย · เพิ่มบันทึกลง `audit_log` |
| เก็บ BBF/EXP | เพิ่มคอลัมน์ `weighing_item.bbf_exp date` + แปลงจาก `bbfExp` ทั้งทาง `/weighing/save-trip` และ `TRIP_SAVED` (ปัจจุบันอยู่ใน `raw` แล้ว ไม่หาย) |
| PRP | `weighing_type='PRP'` ใช้ได้แล้ว · เพิ่มเก็บ `prp_status` |

### 5.2 Phase B — สิ่งที่ต้องเพิ่ม / แก้ใน ERD และ API

| ส่วน | เพิ่ม / แก้ |
|---|---|
| **ERD** `weighing_item` | `+ bbf_exp date`, `+ prp_status (PENDING/CONFIRMED)` |
| `lot` | `exp_date` ได้จาก `bbf_exp` ตอนรับเข้า → เปิดทาง FEFO (R7) |
| `ro_item` | `+ prp_report_id`, `+ inspection_locked boolean`, `+ bbf_exp` |
| **ตารางใหม่ `qa_issue`** | `id, type (PRP_INSPECTION_CHANGE…), subject_type, subject_id, from_type, to_type, reason, status (PENDING_QA/APPROVED/REJECTED), requested_by, decided_by, decided_at` |
| `return_request` | `+ source (WH13_RETURN_FORM / RMA)`, `+ cancel_done_at`, `+ cancel_done_by_device` |
| `warehouse` | `+ WHSM07 Preparing Station` |
| **API ใหม่** | `GET /qa/issues?status` · `POST /qa/issues` · `POST /qa/issues/{id}/approve\|reject` · `POST /prp/{reportId}/confirm` (ฝ่ายผลิตสแกนรับ → `prp_status=CONFIRMED`, ตัดออกจาก WHSM07) |
| API แก้ | `POST /returns/{ruNo}/cancel` → server ส่ง `RMA_CANCEL_RU` และรอ `RMA_CANCEL_RU_DONE` · `POST /requisitions` kind `RETURN` → สร้าง RU แทนการลงสต็อกทันที (ตาม W3) |
| กฎใหม่ | **R12** PRP รับเข้าเป็น GR และล็อก — เปลี่ยนได้ผ่าน qa_issue ที่ QA อนุมัติเท่านั้น · **R13** BBF/EXP ต้องเป็นวันที่ถูกต้อง (แปลง พ.ศ.→ค.ศ.) และไม่ย้อนหลัง · **R14** ของคืนจากฝ่ายผลิตต้องผ่าน RU → ชั่ง → ตรวจ ก่อนลง Stock Card |
| Sequence ที่ต้องเพิ่ม | PRP (V4 → WH13 → WHSM07 → ฝ่ายผลิตยืนยัน) · ขอปลดล็อก PRP → QA · ยกเลิก RU (WH13 → V4 → DONE) |

## 6. คำตอบจากตัวอย่างของลูกค้า (ยืนยันแล้ว)

> แหล่งอ้างอิง: `PRP-Developer-Summary` (REQ-PRP-001…012, TC-PRP-001…013) · `Report ID code 01102026` (§3 PRP Specification, §9 End-to-End Flow) ·
> `return-system-erd` · โค้ดใน `1790951454/V4.html`, `1790951454/WH13.html` · `V4.html` เวอร์ชันก่อน

| # | คำถาม | คำตอบ | หลักฐาน |
|---|---|---|---|
| 1 | PRP รับเข้าคลังไหน | **WHSM07 — Preparing Station** · PRP = วัตถุดิบที่ถูกจ่ายออก (ISU) แล้วนำมาชั่งที่ V4 · Stock Movement **IN WHSM07 only** · รอฝ่ายผลิตสแกนยืนยัน → **OUT WHSM07** เข้าการผลิต (`prpStatus: pending → confirmed`) | Report ID §3: Destination WHSM07, Inspection GR (locked), Stock Movement "IN WHSM07 only", Confirm Flow "Production Scan" · §9 Phase 3 |
| 2 | BBF/EXP ปี พ.ศ. หรือ ค.ศ. / บังคับไหม | **`วว/ดด/ปปปป` แบบ พ.ศ.** (ตัวอย่าง `31/12/2569`) · **ไม่บังคับ** — ว่างได้ แสดงเป็น `-` บนฉลาก/ตาราง | `__bbfExpExtTest()` ใช้ `bbfExp: '31/12/2569'` · placeholder `วว/ดด/ปปปป` · ไม่มี validation |
| 3 | ใครอนุมัติคำขอปลดล็อก PRP | **QA** · ผู้ขอ = ผู้ใช้ที่ login ผ่าน `__rmaGate` + ระบุเหตุผล (บังคับ) → issue `PRP_INSPECTION_CHANGE` สถานะ `PENDING_QA` · หน้าจอ QA approve/reject เป็นงาน **Phase 2 "QA Module integration (real API)"** = ให้ backend ทำ | REQ-PRP-008, TC-PRP-009 · Report ID "Phase Breakdown": QA Module integration ⏳ Future · PRP Summary §12 Roadmap |
| 4 | ของคืนจากฝ่ายผลิตต้องผ่าน RU ทุกครั้งไหม | **ใช่** · ฟอร์มคืนทุกครั้งสร้าง RU (`PENDING`) → คิวตรวจ → ชั่งที่ V4 (RMA) → QA → RMA Report แล้วจึงลงสต็อก | `Phase 1 RU Hook` ดักแท็บคืนทุกครั้ง · `return-system-erd` · Report ID #06 RU |
| 5 | ยกเลิก RU / syntax error ใครแก้ | **ยกเลิก RU ทำตาม `return-system-erd`**: RU → `CANCELLED` + `cancelledBy/At` → แจ้ง V4 → V4 blacklist + ตอบ DONE → WH13 บันทึก `CANCEL_DONE_LOG` · โค้ด WH13 ตอนนี้ยกเลิกแค่ลบออกจากคิว + เขียน audit `RMA_CANCELLED` **ยังไม่ตั้งสถานะ RU และไม่ส่งข้อความ** → **backend เติมส่วนที่ขาด** (ดู 7.3) · **syntax error** ยึด V4 เวอร์ชันก่อนเป็นต้นแบบ (`if (banner) {`) → แจ้งทีม UI แก้ (server ไม่แก้ไฟล์ของลูกค้า) | `return-system-erd`: RETURN_REQUEST, RMA_ACK, CANCEL_BLACKLIST, CANCEL_DONE_LOG · `rmaCancelSession()` ที่ WH13:6548 · V4 เดิม:5554 |

## 7. Design ที่ปรับตามคำตอบ

### 7.1 กฎธุรกิจที่เพิ่ม
| กฎ | รายละเอียด |
|---|---|
| **R12 PRP** | รับเข้าเป็น GR ล็อก · ลงสต็อก **WHSM07 เท่านั้น** · เปลี่ยน GR→QA ได้เมื่อ QA อนุมัติ qa_issue · ฝ่ายผลิตสแกนยืนยัน = OUT จาก WHSM07, `prp_status=CONFIRMED` |
| **R13 BBF/EXP** | รับ `dd/mm/yyyy` · ปี ≥ 2400 ถือเป็น พ.ศ. → −543 · ปี < 2400 ถือเป็น ค.ศ. · วันที่ไม่จริง (31/02) → ไม่บันทึก exp แต่เก็บข้อความเดิมไว้ + เตือน · ว่างได้ |
| **R7 FEFO (ปรับ)** | Lot ที่มี exp → เรียงวันหมดอายุก่อน · Lot ที่ไม่มี exp → ต่อท้าย เรียงตามวันรับเข้า (FIFO) ตรงกับ REQ-F-004 "FIFO / FEFO" |
| **R14 คืนสินค้า** | คืนจากฝ่ายผลิต/แผนกต้องผ่าน RU → ชั่ง → ตรวจ → RMA ก่อนลง Stock Card เสมอ |
| **R15 ยกเลิก RU** | ยกเลิกได้ก่อน RMA Report ถูก CONFIRMED · ต้อง login · ระบบต้องแจ้ง V4 และรอ DONE (แสดงสถานะรอ ถ้าไม่ตอบใน 30 วิ ส่งซ้ำ ตาม `RETRY_DELAY_MS` ของ V4) |

### 7.2 ERD (เพิ่มจาก 02-erd.md)
| ตาราง | เปลี่ยน |
|---|---|
| `warehouse` | + `WHSM07` Preparing Station (`wh_type=PREP`) |
| `weighing_item` | + `bbf_exp_text` (ค่าที่พิมพ์), + `bbf_exp date` (แปลงแล้ว), + `prp_status` (`PENDING`/`CONFIRMED`) |
| `ro_item` | + `prp_report_id`, + `inspection_locked boolean`, + `bbf_exp date` |
| `lot` | `exp_date` ← `bbf_exp` ตอนรับเข้า (ถ้ามี) |
| **`qa_issue`** (ใหม่) | `id, type, status (PENDING_QA/APPROVED/REJECTED), from_type, to_type, reason, requested_by, requested_at, decided_by, decided_at, decision_note, subject_type, subject_ref` · **`subject_ref` ต้องมี** — UI ปัจจุบันไม่ส่งว่าขอปลดล็อกรายการไหน (ดู 7.4) |
| `return_request` | + `cancelled_by`, `cancelled_at`, `cancel_reason`, `cancel_sent_at`, `cancel_done_at`, `cancel_done_device` |
| `v4_cancel_blacklist` | (ใน Phase A อยู่ใน kv `whrm_v4_cancel_blacklist_v1` · Phase B ใช้ `return_request.status=CANCELLED` แทน) |

### 7.3 API / Bus (เพิ่มจาก 03-api.md)

> ✅ = implement แล้ว (whrm-server 0.2.0, E2E 32/32 กับ UI นี้ · 2 ต.ค. 2026) · ERD / API / sequence อัปเดตแล้วใน 01–03
| | Endpoint / message | ใช้ทำ |
|---|---|---|
| ✅ Phase A | **server สร้าง `RMA_CANCEL_RU` เอง** เมื่อเห็น audit `RMA_CANCELLED` ใหม่ใน kv `whrm_rma_audit_v1` (WH13 เขียนอยู่แล้ว) → V4 ตอบ `RMA_CANCEL_RU_DONE` → WH13 แสดงป้าย | ปิดช่องว่างยกเลิก RU **โดยไม่ต้องแก้ UI** |
| ✅ Phase A | เก็บ `bbfExp` จาก `TRIP_SAVED` / `save-trip` ลง `weighing_item.bbf_exp*` | วันหมดอายุไม่หาย แม้ WH13 ยังไม่ใช้ |
| Phase B | `GET /qa/issues?status=PENDING_QA` · `POST /qa/issues/{id}/approve` · `POST /qa/issues/{id}/reject` (role QA) | หน้าจอ QA Module |
| Phase B | `POST /prp/{reportId}/confirm` (ฝ่ายผลิตสแกน) · `GET /prp?status=PENDING` | Production Scan → OUT WHSM07 |
| Phase B | `POST /returns/{ruNo}/cancel` → `status=CANCELLED` + ส่ง `RMA_CANCEL_RU` | ทางหลักเมื่อย้ายตรรกะมา server |

### 7.4 สิ่งที่ต้องแจ้งทีม UI (ไม่ต้องรอ — backend ทำต่อได้)
1. V4 `1790951454/V4.html:6710` → แก้ `if (banner4-RMA v2.7) {` กลับเป็น `if (banner) {`
2. WH13 เพิ่มคลัง `WHSM07` ใน `warehouses` (ไม่งั้นการลงสต็อก WHSM07 หายเงียบ)
3. คำขอ `PRP_INSPECTION_CHANGE` ใส่ `reportId` + `itemId` ของรายการที่ขอปลดล็อก
4. WH13 `mapV4Item` เก็บ `bbfExp` ต่อไปถึง RO item / Stock Card
5. `rmaCancelSession` ตั้ง RU เป็น `CANCELLED` (ตาม ERD) — ระหว่างรอ backend ส่ง `RMA_CANCEL_RU` แทนให้ (7.3)
