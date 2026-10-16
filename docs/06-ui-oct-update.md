# 06 — UI ชุด 14–16 ต.ค. 2026: FGT/FGA, BD02, ฝ่ายผลิต

> ที่มา: `1791465357/` (สเปก FGT/FGA 7 ต.ค.) · `1791984572/` (WH-Test 14 ต.ค.: WH13, V4, BD02, Production module + เอกสาร requirement) · `1792168326/` (WH13 16 ต.ค.)
> สถานะ: เข้าระบบแล้ว 17 ต.ค. 2026 · E2E 52/52 (ข้ามโดเมน) · 51/51 (proxy)

## 1. ไฟล์ที่ใช้

| ไฟล์ใน `whrm-frontend/ui/` | มาจาก | URL |
|---|---|---|
| `WH13.html` | `1792168326` (16 ต.ค.) | `/WH13.html` |
| `V4.html` | `1791984572` (14 ต.ค.) | `/V4.html` |
| `BD02.html` | `1791984572` | `/BD02.html` |
| `Production module/Preparing.html` | `1791984572` | `/Production-module/Preparing.html` |
| `Production module/Processing and packing12.html` | `1791984572` | `/Production-module/Processing-and-packing12.html` |
| `Production module/production-stockcard.html` | `1791984572` | `/Production-module/production-stockcard.html` |
| `qrcode.min.js`, `html5-qrcode.min.js` | `1791984572` | library ที่ WH13 โหลดจากเครื่อง |

ไม่ใช้: `index.html` / `Run-WH-Server.bat` / `server.ps1` ของลูกค้า (มีของเราแทน) · `Production module/Main page/` (ไฟล์สำรอง + dashboard ภาพนิ่ง)

## 2. สิ่งที่แก้ใน whrm-frontend

| เรื่อง | เดิม | ตอนนี้ |
|---|---|---|
| build | อ่านเฉพาะ `ui/*.html` | อ่านทุกโฟลเดอร์ย่อย · copy ไฟล์ `.js` · เว้นวรรคใน path → `-` · หน้าในโฟลเดอร์ย่อยอ้าง `../config.js` · สร้าง `pages.json` |
| หน้ารวม | ลิงก์ V4, WH13 ตายตัว | สร้างจาก `pages.json` — ลูกค้าเพิ่มหน้า ลิงก์ขึ้นเอง |
| อ่าน token (โหมดข้ามโดเมน) | ผ่าน `window.localStorage` | ผ่าน localStorage ตัวจริงที่จับไว้ตอนเริ่ม — WH13 ใหม่แทน `window.localStorage` ด้วย Proxy ทำให้ token หาย → เด้งไปหน้า login หลังรับข้อมูลจาก V4 |
| เลขลำดับเอกสารชนกัน | ยึดค่าเครื่องตัวเอง (เลขถอยหลังได้) | ใช้ค่ามากสุด: `whrm_fgt_seq_*`, `whrm_io_seq_*`, `whrm_trf_seq_v1`, `whrm_pl_ref_seq_v1`, `whrm_txn_seq_v1`, `whrm_logid_counter_v4` |
| merge รายการ | รู้จัก id 9 ชื่อ | + เดาเลขเอกสารเอง (field ลงท้าย `No` / `Ref` / `Id` / `_number` ที่ไม่ซ้ำ) → คิว FGT รวมตาม `fgtNo` ไม่เกิดใบซ้ำ |
| ค่าเฉพาะเครื่อง (ไม่ sync) | 14 key | + 16 key: login ในแอป (`whrm_wh13_session_v1`, `whrm_trf_login_v1`, `whrm_ic_dev_session_v1`) · ค่า dev/ปลดล็อก (`whrm_rma_dev_ai_config_v1`, `whrm_ic_dev_mode_v1`, `whrm_i7_dev_flags_v1`, `whrm_fgt_dev_unlock_v1`, `whrm_transfer_dest_unlock_v1`, `whrm_subunit_unlock_v1`) · ค่าหน้าจอ (`whrm_trf_last_src`, `whrm_ew_alerts_seen_v1`) · ร่างเอกสารแนบ (`whrm_*_docs_draft_v1` 5 key) |
| ป้ายสถานะ | online / รอส่ง | + เตือน "⚠ พื้นที่เครื่องใกล้เต็ม" เมื่อ localStorage ใช้เกิน 80% (ตรวจทุก 30 วิ) |
| ชื่อแอปใน bridge | V4 / WH13 | + `BD02`, `PRODUCTION` (เห็นในหน้ารวม "เครื่องที่เชื่อมต่ออยู่") |

## 3. สิ่งที่เพิ่มใน whrm-backend (0.6.0-phaseA)

| API | ใช้ทำอะไร |
|---|---|
| `GET /api/v1/fgt?status=PENDING` | คิว FGT จากข้อมูลที่ WH13 sync ขึ้นมา + จำนวนตามสถานะ + `duplicates` (เลข FGT ที่ออกซ้ำ — log เตือนด้วย) |
| `GET /api/v1/fga/reports` | รายงานอนุมัติ FGA + `duplicates` |

## 4. ข้อจำกัดที่ยังอยู่ (Phase A)

| เรื่อง | ผล | ทางแก้ |
|---|---|---|
| เลขเอกสารออกพร้อมกัน 2 เครื่องในวินาทีเดียวกัน | ได้เลขซ้ำได้ (แต่เลขถัดไปจะไม่ถอยหลัง) · `/fgt` แสดงเลขที่ซ้ำ | Phase B: server ออกเลข (`doc_sequence`) |
| BD02 ↔ WH13 (`pmp.bridge.*`), ฝ่ายผลิต (`wh13_prepare_*`, `smart_multibatch_*`), channel `wh13_stock_sync` | ทำงานเฉพาะ browser เดียวกัน ไม่ข้ามเครื่อง | รอลูกค้ายืนยันว่าใช้คนละเครื่องไหม |
| เมนู Quick Access ของ Preparing | 8 รายการชี้ไฟล์ที่ยังไม่ส่งมา → 404 | รอไฟล์ / ให้ทีม UI ซ่อนเมนู |
| Info Center ส่ง webhook "Production Planning" | URL ว่าง → ไม่ส่ง (คิว + bus ยังทำงาน) · ไม่มีหน้าไหนรับ | รอคำตอบลูกค้า — backend เป็นปลายทางได้ |
| WH13 ดาวน์โหลดตัวเอง (5 MB) ทุกครั้งที่เปิด (`WH13_SYNTAX_FINDER`) | เปิดหน้าช้าบนเน็ตช้า | แจ้งทีม UI ลบ block นี้ |
| รหัสผ่านในโค้ด (QA-001, Tom/8888) · Dev Panel ไม่มี login | ใครเปิด source ก็เห็น | Phase B: RBAC ที่ server |
| V4 `if (banner4-RMA v2.7)` (บรรทัด 6780) | patch block นั้นไม่ทำงาน (ตั้งแต่รุ่นก่อน) | แจ้งทีม UI |

## 5. คำถามที่ส่งลูกค้า

1. BD02, หน้าฝ่ายผลิต และ WH13 ใช้คนละเครื่องไหม
2. หน้าฝ่ายผลิต 8 หน้าในเมนู Quick Access จะส่งมาไหม หรือรอบนี้ demo 3 หน้า
3. "Production Planning" ที่ Info Center ส่ง webhook ไป คือระบบไหน
4. "FGT นำส่ง" ของฝ่ายผลิต กับ FGT ใน WH13 เป็นตัวเดียวกันไหม
5. ERD ในเอกสาร 14 ต.ค. เป็นภาพรวม — ต้องเก็บตำแหน่งถึง zone/bin ไหม · Order/Invoice อยู่ในระบบนี้หรือ SBO
6. Dev Panel (AI Checks) เป็นค่ากลางหรือค่าของ developer เครื่องเดียว (ตอนนี้ตั้งเป็นเฉพาะเครื่อง)
