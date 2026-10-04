# WH-RM Backend Design — รองรับ UI V4 + WH13

> ขอบเขต: ออกแบบ backend ให้ **V4.html (สถานีชั่ง)** และ **WH13.html (WMS + QA Gate)** ใช้งานได้จริง
> โดย **คงหน้าจอเดิมไว้ทั้งหมด** (ลูกค้าต้องการ UI แบบนี้) — เปลี่ยนเฉพาะชั้นเก็บข้อมูลและการสื่อสาร
> อ้างอิงจากโค้ดใน Archive (V4 v4.4 / WH13 ณ 30 ก.ย. 2026) · **อัปเดตตาม UI `1790951454` (2 ต.ค. 2026)** — ดู [docs/04-ui-v2-change-review.md](docs/04-ui-v2-change-review.md)
>
> เอกสารประกอบ: [Sequence Diagrams](docs/01-sequence-diagrams.md) · [ERD](docs/02-erd.md) · [API Overview](docs/03-api.md) · [OpenAPI](docs/03-openapi.yaml)
>
> **สถานะ implement (2 ต.ค. 2026):** Phase A เสร็จและทดสอบแล้ว (E2E 32/32 กับ UI `1790951454`) — รวม PRP, เก็บ BBF/EXP, ส่งต่อการยกเลิก RU → [whrm-backend/](whrm-backend/README.md) + [docker-compose.yml](docker-compose.yml)
>
> **แยก backend / frontend (3 ต.ค. 2026):** [whrm-backend/](whrm-backend/README.md) (API + bus + DB, port 3000) · [whrm-frontend/](whrm-frontend/README.md) (V4/WH13 + bridge, port 8080, proxy `/api` `/bus` ไป backend) · รันด้วย [docker-compose.yml](docker-compose.yml)
>
> **Login (3 ต.ค. 2026):** ทุก API / WebSocket ต้อง login · cookie session HttpOnly · ผู้ใช้ + role ใน `app_user` · ADMIN จัดการผู้ใช้ที่หน้ารวม · E2E 42/42 — ส่วนนี้คือ B1 (Auth) แบบแรก สิทธิ์ราย action ยังเป็น Phase B
>
> **Deploy (4 ต.ค. 2026):** backend → Railway · frontend → Vercel (คนละโดเมน → Bearer token) — ขั้นตอนที่ [docs/05-deploy-railway-vercel.md](docs/05-deploy-railway-vercel.md)
> ใช้ Fastify (Node.js) แทน NestJS สำหรับ Phase A เพราะเป็นแค่ relay + sync บาง ๆ — ย้ายเข้า NestJS ได้ตอนเริ่ม Phase B

---

## 1. หลักการออกแบบ

| # | หลักการ | เหตุผล |
|---|---|---|
| 1 | **UI ไม่เปลี่ยนหน้าตา/flow** | ลูกค้า approve UI แล้ว, ใช้ demo ต่อได้ทันที |
| 2 | **แทรก "Bridge" 1 ไฟล์** แทนการแก้ logic ใน HTML | WH13 มี patch ซ้อน 141 script — แก้ข้างในเสี่ยงพัง |
| 3 | **ย้าย source of truth ไป server ทีละขั้น** (Strangler pattern) | demo ได้ตั้งแต่ขั้นแรก, ค่อย ๆ เพิ่มความถูกต้องทางธุรกิจ |
| 4 | **Envelope message เดิม** (`{type, version, source, timestamp, payload}`) | ทั้ง V4/WH13 ใช้ WHBus format นี้อยู่แล้ว |
| 5 | **Stock = ledger แบบ append-only** คิด balance ราย คลัง+สินค้า+Lot+หน่วย | แก้ปัญหา balance รวมทั้งคลังใน `addStockCardEntry` |

---

## 2. สถาปัตยกรรมภาพรวม

```
┌───────────────────────── Factory LAN ─────────────────────────┐
│                                                                │
│  [Tablet/PC สถานีชั่ง]          [PC คลัง / QA]                     │
│   V4.html                        WH13.html                     │
│    └─ whrm-bridge.js              └─ whrm-bridge.js            │
│        │  ▲                            │  ▲                    │
│        │  │ WebSocket (bus) + REST     │  │                    │
│  [Scale/Printer Agent]  ◄── localhost WS (Phase C)             │
│        │                               │                       │
└────────┼───────────────────────────────┼───────────────────────┘
         ▼                               ▼
   ┌──────────────────────────────────────────────────┐
   │  WH-RM API  (NestJS + Fastify)                     │
   │  ├─ Static host: เสิร์ฟ V4.html / WH13.html          │  ← แทน server.ps1
   │  ├─ Bus Gateway (WebSocket, rooms ต่อ site)         │
   │  ├─ Sync Service (KV snapshot ของ whrm_* keys)      │  ← Phase A
   │  ├─ Domain Modules                                  │  ← Phase B
   │  │   Auth · Master · Weighing · Receiving(RO) · QA  │
   │  │   Inventory Ledger · Requisition/FGT · Transfer  │
   │  │   Stock Out · Return(RU)/RMA · Approval · Print  │
   │  └─ Audit (append-only) · Outbox events              │
   └───────────────┬──────────────────────────────────┘
                   ▼
         PostgreSQL 16  (+ file storage สำหรับเอกสารแนบ RO)
```

**Deploy สำหรับ demo/pilot:** Docker Compose (api + postgres) บน mini PC ใน LAN โรงงาน
→ ใช้ได้แม้ internet ล่ม, latency ต่ำ (scale/scan < 1s) — ย้ายขึ้น cloud ได้ภายหลังโดยไม่แก้โค้ด

---

## 3. แผน 3 Phase

### Phase A — "Demo ได้จริงหลายเครื่อง" (ไม่แตะ logic UI)

เป้าหมาย: ข้อมูลไม่หายเมื่อล้าง browser, V4 กับ WH13 อยู่คนละเครื่องได้, มี backup

1. **Bus relay** — `whrm-bridge.js` polyfill `BroadcastChannel('whrm-bus')`
   ให้ `postMessage` ส่งออกทาง WebSocket ด้วย และ message จาก server ถูก dispatch เข้า `onmessage` เหมือนเดิม
   → `TRIP_SAVED`, `TRIP_IMPORTED`, `TRIP_REJECTED`, `TRIP_ITEMS_DELETED`, `RMA_WEIGH_REQUEST`, `RMA_WEIGH_RESULT`, `PING/PONG` วิ่งข้ามเครื่องได้ทันที
2. **Storage sync** — hook `localStorage.setItem/removeItem` เฉพาะ key `whrm_*`
   - ส่ง `PUT /sync/kv/:key` แบบ debounce 500ms + ส่งเฉพาะเมื่อ hash เปลี่ยน (WH13 มี `setInterval` 71 ตัว อาจเขียนซ้ำถี่)
   - ใช้ `version` (optimistic lock) — ถ้าชน server ตอบ 409 + ค่าล่าสุด → bridge merge (ดูข้อ 7)
   - server broadcast `KV_CHANGED` ให้เครื่องอื่นอัปเดต localStorage + fire `storage` event (UI เดิมฟัง event นี้อยู่แล้ว)
3. **Hydrate ตอนเปิดหน้า** — API เสิร์ฟ HTML เองและ inject
   `<script>window.__WHRM_SNAPSHOT = {...}</script>` + `<script src="/whrm-bridge.js">` ไว้ **ก่อน** script ของแอป
   → bridge เขียน snapshot ลง localStorage ก่อนแอปอ่าน (ไม่ต้องแก้ไฟล์ HTML ต้นฉบับ)
4. **Implement endpoint ที่ V4 เรียกอยู่แล้ว** (V4 มี `apiCall()` + Settings `apiBase/apiToken/mode`) — แค่เปลี่ยน mode จาก `mock` เป็น `api`:
   `GET /health`, `POST /weighing/items`, `POST /weighing/save-trip`, `POST /wms/send`, `POST /audit/override`, `POST /users/save`

> ผลลัพธ์ Phase A: ข้อมูลอยู่ใน Postgres, multi-device, backup ได้ — **แต่กฎธุรกิจยังเป็นของ UI** (ยังไม่แก้ bug balance/HOLD)

### Phase B — "กฎธุรกิจถูกต้อง" (server เป็น source of truth ของ stock)

Bridge **wrap ฟังก์ชัน global** ของ WH13 ที่ทำธุรกรรม → เรียก API ก่อน, ถ้าผ่านจึงเรียกฟังก์ชันเดิมเพื่อ render

| ฟังก์ชันเดิมใน UI | API ที่เรียกก่อน | ถ้า server ปฏิเสธ |
|---|---|---|
| สร้าง RO (`roStatusStore.unshift`) | `POST /receiving/ro` | toast ข้อความไทยจาก server, ไม่สร้าง |
| `approveRO()` | `POST /receiving/ro/:roNo/approve` | — |
| `confirmReject()` | `POST /qa/ro-items/:id/reject` | — |
| Stock Out submit | `POST /inventory/stock-out` | "Stock ไม่พอ" / "Lot ถูก HOLD" |
| เบิก/คืน/FGT submit | `POST /requisitions` | — |
| โอนย้าย submit | `POST /inventory/transfers` | — |
| `addStockCardEntry()` | (ไม่เรียกตรง) — Stock Card ดึงจาก `GET /inventory/stock-card` แล้วเขียนทับ `whrm_warehouse_data_v1` | — |

- เลขเอกสารทั้งหมดออกจาก server (`doc_sequence`) — กันเลขซ้ำเมื่อหลายเครื่อง
- Login (สแกนบัตร/รหัส) ผ่าน `POST /auth/login` → JWT; ลบรหัสผ่าน/PIN ที่ hardcode ใน HTML ออกจาก flow
- Approval ใน `view-approval` ต่อเข้า `POST /approvals/:id/approve|reject` ให้มีผลจริง

### Phase C — Hardware + ฟีเจอร์ใหม่

- **Scale Agent** (Windows service บน PC สถานีชั่ง, อ่าน RS-232/TCP) → เปิด `ws://localhost:8765` ส่งค่าน้ำหนัก + stable flag
  bridge แทน `connectScale()` / `simulateWeight()` ด้วยค่าจริง (REQ < 500ms)
- **Printer** — `POST /print/jobs` → agent ส่ง ZPL ไปเครื่องพิมพ์ label; สถานะกลับมาที่ `PRINT_QUEUE`
- PRP (Preparing → WHSM07), Production Scan confirm, Dispatch Center (IO)

---

## 4. Data Model (PostgreSQL)

### 4.1 Master
| Table | ฟิลด์หลัก | หมายเหตุ |
|---|---|---|
| `warehouse` | code PK, name, type, is_hold_zone | 14 คลังจาก WH13 (WHRM…WHDC03); WHSM06 = hold zone |
| `product` | code PK, name, category, base_unit, shelf_life_days | จาก `inventoryDB` + Excel "Inventory code" |
| `uom_conversion` | product_code, from_unit, to_unit, factor | kg ↔ ไม้ ↔ แพ็ค |
| `inspection_rule` | product_code PK, required_type (QA/GR), reason | แทน `whrm_inspection_rules_v1` |
| `supplier`, `customer`, `department` | code, name | |
| `app_user` | id, card_id, username, name, password_hash, pin_hash, status | รวม user V4 + WH13 เป็นชุดเดียว |
| `role`, `user_role`, `permission` | | ดู §6 |
| `device` | device_id PK, station_name, type (V4/WH13), last_seen | จาก `whrm_device_id` |

### 4.2 Weighing (V4)
| Table | ฟิลด์หลัก |
|---|---|
| `weighing_report` | report_id PK (`ROO/REE/ISU/PRP…`), weighing_type, trip_no, vehicle_plate, vehicle_type, supplier_transport, customer_code, weighed_by, device_id, created_at |
| `weighing_item` | id PK (= `_id` จาก V4), report_id FK, product_code, batch_no, gross, tare, net, pcs_count, unit, capture_mode (AUTO/MANUAL), barcode_passed, override_by, override_reason, **wms_status** (SENT / IMPORTED / REJECTED / DELETED) |
| `override_log` | id, user_id, item_id, old_net, new_net, reason, at | แทน `whrm_override_daily_*` + นับ daily limit ฝั่ง server |

### 4.3 Receiving + QA (WH13)
| Table | ฟิลด์หลัก |
|---|---|
| `receive_order` | ro_no PK, mode (receive/return), dest_wh, vendor, status (PENDING/PARTIAL/CONFIRMED/CANCELLED), created_by, received_at |
| `ro_item` | id PK, ro_no FK, weighing_item_id FK (nullable), product_code, lot_no, qty, unit, inspection_type (GR/QA), inspection_overridden_by, qa_status (NA/PENDING/APPROVED/REJECTED), qa_remark, reject_dest_wh, reject_mode (auto/manual) |
| `ro_document` | id, ro_no, file_key, type | ไฟล์แนบ "จัดการเอกสารที่เกี่ยวข้อง" |
| `qa_decision` | id, ro_item_id, decision, by, at, remark | append-only — ประวัติการตัดสินทุกครั้ง |

### 4.4 Inventory (หัวใจ)
| Table | ฟิลด์หลัก | หมายเหตุ |
|---|---|---|
| `lot` | id, product_code, lot_no, supplier_code, mfg_date, exp_date, **status** (AVAILABLE/HOLD/REJECTED/CONSUMED) | unique (product_code, lot_no) |
| `stock_movement` | id BIGSERIAL, at, wh_code, product_code, lot_id, unit, qty_in, qty_out, qty_loss, movement_type (RECEIVE/QA_REJECT/ISSUE/RETURN/FGT/TRANSFER_OUT/TRANSFER_IN/STOCK_OUT/ADJUST), ref_type, ref_no, counterparty, remark, by_user | **append-only** = Stock Card |
| `stock_balance` | (wh_code, product_code, lot_id, unit) PK, qty, updated_at | projection อัปเดตใน transaction เดียวกับ movement |

Stock Card ที่ UI แสดง = `stock_movement` + running balance คำนวณด้วย
`SUM(qty_in - qty_out - qty_loss) OVER (PARTITION BY wh, product, lot, unit ORDER BY id)`

### 4.5 เบิก/จ่าย/โอน/อนุมัติ
| Table | ฟิลด์หลัก |
|---|---|
| `requisition` | req_no PK, kind (ISSUE/RETURN/FGT), src_wh, dest (wh/dept), ref_doc, reason, status, requested_by |
| `requisition_item` | req_no, product_code, lot_id, qty, unit |
| `stock_out` | so_no PK, wh_code, dest_kind (WH/DEPT/FREE), dest, ref_doc, by_user |
| `transfer` | tr_no PK, src_wh, dest_wh, by_user (+ items) |
| `approval` | id, subject_type (REQUISITION/QA/STOCK_OUT), subject_no, status, decided_by, decided_at, reason |

### 4.6 Return (RU) / RMA
| Table | ฟิลด์หลัก |
|---|---|
| `return_request` | ru_no PK, dest_wh, dept, ref_doc, reason, status (PENDING/WH_ACCEPTED/IN_RMA/COMPLETE/CANCELLED), created_by |
| `return_item` | ru_no, product_code, lot_no, supplier_code, declared_qty, unit |
| `rma_session` | ru_no PK, stage (QUEUE/INSPECTING/AI_PASS/AI_FAIL/APPROVED/CANCELLED), inspection_type, overridden_by |
| `rma_weigh` | ru_no, item_ref, actual_qty, weighed_by, device_id, at | ผลจาก V4 (`RMA_WEIGH_RESULT`) |
| `rma_check` | ru_no, item_ref, dimension, pass, detail | ผล "AI" 6 ข้อ — **ย้ายไปคำนวณที่ server** |
| `rma_report` | rma_no PK, ru_no, created_by, at |

### 4.7 ระบบ
| Table | หมายเหตุ |
|---|---|
| `doc_sequence` (prefix, period, last_no) | `SELECT … FOR UPDATE` ออกเลข ROO/REE/ISU/PRP/RO/RU/IO/RMA/FGT |
| `audit_log` | append-only (`REVOKE UPDATE, DELETE`), user, device, action, entity, before/after, request_id |
| `bus_message` | log ทุก message ที่ relay (idempotency + replay ให้เครื่องที่ offline) |
| `kv_store` (key, value jsonb, version, updated_by, updated_at) | ใช้ใน Phase A — เลิกใช้ทีละ key เมื่อ Phase B ครอบคลุม |
| `print_job` | id, report_id, type, payload, status, attempts, error |

---

## 5. API (REST `/api/v1` + WebSocket `/bus`)

### 5.1 Endpoint ที่ V4 เรียกอยู่แล้ว (ทำก่อน)
| Method | Path | Body (จากโค้ด V4) |
|---|---|---|
| GET | `/health` | — |
| POST | `/weighing/items` | newItem (รายการที่เพิ่มเข้าตะกร้า ก่อนบันทึก trip) |
| POST | `/weighing/save-trip` | `{ reportId, tripNo, items, user }` |
| POST | `/wms/send` | `{ reportId, itemCode }` |
| POST | `/audit/override` | override entry |
| POST | `/users/save` | user record |

### 5.2 Domain API (Phase B)
```
POST /auth/login                      {cardId|username, password|pin} → JWT
GET  /master/products | warehouses | suppliers | customers | inspection-rules
PUT  /master/inspection-rules/:code   (ต้องมีสิทธิ์ RULE_ADMIN)

GET  /weighing/reports?type&date&status
POST /weighing/reports/:id/items/:itemId/delete

GET  /receiving/inbox                 รายการชั่งที่ยังไม่ import (แทน whrm_incoming_weighing_v1)
POST /receiving/ro                    {mode, destWh, items[{weighingItemId?, code, lot, qty, unit, inspectionType}]}
POST /receiving/ro/:roNo/approve
POST /receiving/ro/:roNo/cancel       (ต้อง re-auth)
POST /qa/ro-items/:id/approve | reject {remark, destWh?, mode}
POST /qa/ro-items/:id/override-type   {toType, reason}  (ต้อง re-auth)

GET  /inventory/stock-card?wh&product&lot&from&to
GET  /inventory/balance?wh&product          (ราย Lot + FEFO order)
POST /inventory/stock-out | /inventory/transfers
POST /inventory/lots/:id/hold | release     (release = QA เท่านั้น)

POST /requisitions                    ISSUE / RETURN / FGT
GET  /approvals?status                POST /approvals/:id/approve|reject

POST /returns                         สร้าง RU
POST /returns/:ruNo/rma/start         → server publish RMA_WEIGH_REQUEST ให้ V4
POST /returns/:ruNo/rma/checks        server รัน 6 checks → RMA_AI_RESULT
POST /returns/:ruNo/rma/approve       สร้าง RMA report + stock movement

GET  /reports/:name?filters&format=xlsx|csv|pdf
GET  /sync/snapshot   PUT /sync/kv/:key   (Phase A)
POST /print/jobs
```

### 5.3 WebSocket Bus
- Envelope เดิม: `{ type, version, source, timestamp, payload, msgId }` (เพิ่ม `msgId` เพื่อ idempotency)
- Client → server: message จาก UI (TRIP_SAVED ฯลฯ) → server **บันทึก DB ก่อน** แล้วค่อย broadcast
- Server → client (event ใหม่): `KV_CHANGED`, `STOCK_CHANGED {wh, product, lot}`, `LOT_HELD/RELEASED`, `RO_UPDATED`, `APPROVAL_UPDATED`
- Reconnect: client ส่ง `lastMsgId` → server replay จาก `bus_message` (แทน offline queue `whrm_bus_offline_queue_v1`)

---

## 6. กฎธุรกิจที่ backend ต้องบังคับ

| # | กฎ | ที่บังคับ |
|---|---|---|
| R1 | Balance คิดราย **คลัง + สินค้า + Lot + หน่วย** | `stock_balance` |
| R2 | จ่าย/เบิก/โอน ห้ามเกิน balance (ไม่ติดลบ) | ทุก movement OUT |
| R3 | Lot สถานะ HOLD/REJECTED หรืออยู่คลัง hold zone → **ห้ามจ่าย/โอน/ขาย** | ทุก movement OUT, ตอบ 409 + ข้อความไทย |
| R4 | ปลด HOLD ได้เฉพาะ role QA + บันทึก audit | `/lots/:id/release` |
| R5 | สินค้าที่ rule กำหนด QA → ห้ามเลือก GR เว้นแต่ override โดยผู้มีสิทธิ์ + เหตุผล | `/receiving/ro`, `/override-type` |
| R6 | Approve RO ได้เมื่อทุก item ที่เป็น QA ไม่ PENDING; QA ผ่าน → stock เข้า dest_wh, ไม่ผ่าน → WHSM06 + Lot HOLD | `/approve` (1 DB transaction) |
| R7 | แนะนำ Lot แบบ **FEFO** (exp_date ใกล้สุดก่อน) ตอนเบิก/จ่าย; เลือก Lot อื่นต้องระบุเหตุผล | `/inventory/balance` |
| R8 | weighing item 1 รายการ import เป็น RO ได้ครั้งเดียว | unique `ro_item.weighing_item_id` |
| R9 | Override น้ำหนัก: ต้องมีสิทธิ์, ≤ 20 ครั้ง/วัน/สถานี, ต้องมีเหตุผล | `/audit/override` |
| R10 | เลขเอกสารออกจาก server เท่านั้น ต่อเนื่องไม่ซ้ำ | `doc_sequence` |
| R11 | ทุก action เขียน `audit_log` (append-only) พร้อม user + device + request_id | interceptor |
| R12 | **PRP** รับเข้าเป็น GR ล็อก · ลงสต็อก WHSM07 เท่านั้น · เปลี่ยนเป็น QA ได้เมื่อ QA อนุมัติ `qa_issue` · ฝ่ายผลิตสแกนยืนยัน = OUT จาก WHSM07 | `/receiving/ro/approve`, `/qa/issues/*`, `/prp/{id}/confirm` |
| R13 | **BBF/EXP** รับ `dd/mm/yyyy` · ปี ≥ 2400 = พ.ศ. (−543) · วันที่ไม่จริง → เก็บข้อความ + audit `BBF_EXP_INVALID` · ว่างได้ | `weighing_item`, `lot.exp_date` (**ทำแล้วใน Phase A**) |
| R14 | ของคืนจากฝ่ายผลิต/แผนก ต้องผ่าน RU → ชั่ง → ตรวจ → RMA ก่อนลง Stock Card | `/requisitions` kind RETURN → `/returns` |
| R15 | ยกเลิก RU ก่อน RMA Report CONFIRMED · แจ้ง V4 และรอ DONE (ส่งซ้ำเมื่อ V4 ต่อเข้ามา ภายใน 24 ชม.) | `/returns/{ruNo}/cancel` (**Phase A: server ส่งเองแล้ว**) |

> R7 (FEFO) ปรับ: Lot ที่มี `exp_date` เรียงวันหมดอายุก่อน · Lot ที่ไม่มีต่อท้ายตามวันรับเข้า (FIFO) — ตรง REQ-F-004 "FIFO / FEFO"

### Role เริ่มต้น (ปรับตามลูกค้า)
| Role | สิทธิ์หลัก |
|---|---|
| WEIGH_OPERATOR | ชั่ง, บันทึก trip, พิมพ์ label |
| WH_STAFF | import, สร้าง RO, จ่าย/เบิก/โอน |
| WH_SUPERVISOR | + ยกเลิก RO, อนุมัติเบิก, override ประเภทตรวจรับ |
| QA | ตัดสิน QA, HOLD/RELEASE, อนุมัติ RMA |
| PRODUCTION | สแกนรับ PRP ที่ WHSM07, ขอเบิก/คืน |
| ADMIN | master data, users, rules |

---

## 7. Mapping: localStorage key → Backend

| Key ใน UI | Phase A | Phase B (ปลายทาง) |
|---|---|---|
| `whrm_shared_trips_v1`, `whrm-bus` | Bus relay | `weighing_report/item` + `bus_message` |
| `whrm_incoming_weighing_v1` | KV sync | `GET /receiving/inbox` |
| `whrm_ro_status_v6`, `whrm_ro_seq_*` | KV sync | `receive_order`, `ro_item`, `doc_sequence` |
| `whrm_warehouse_data_v1` | KV sync | `stock_movement` → render เป็น stock card |
| `whrm_inspection_rules_v1` | KV sync | `inspection_rule` |
| `whrm_return_requests_v1`, `whrm_rma_*` | KV sync + bus | `return_request`, `rma_*` |
| `whrm_issue_requests_v1`, `whrm_io_seq_*` | KV sync | `requisition`, `approval` |
| `whrm_report_seq_*` | KV sync | `doc_sequence` |
| `whrm_users_v4`, `systemUsers` | (คงไว้) | `app_user` + `/auth/login` |
| `whrm_printq_v4` | KV sync | `print_job` |
| `whrm_audit_*`, `whrm_rma_audit_v1`, `whrm_sync_audit_v1` | KV sync | `audit_log` |
| `whrm_qa_issues_v1` (ขอปลดล็อก PRP) | KV sync | `qa_issue` |
| `whrm_v4_cancel_blacklist_v1`, `whrm_v4_cancel_done_log_v1` | KV sync (ทุกสถานีรู้ RU ที่ยกเลิก) | `return_request.status=CANCELLED`, `cancel_done_*` |
| `whrm_rma_audit_v1` | KV sync + **server ดู `RMA_CANCELLED` แล้วส่ง `RMA_CANCEL_RU`** | `audit_log` |
| `whrm_dev_audit_v1` | KV sync | `audit_log` |
| `whrm_cfg_v3`, `whrm_filter_presets_v4`, `whrm_v4_active_mode` | **ไม่ sync** (ค่าเฉพาะเครื่อง) | — |

**การ merge เมื่อชน (Phase A):** key ที่เป็น array ของ record ที่มี id (`ro_status`, `return_requests`, `audit`) → merge ราย id โดยยึด `updatedAt` ล่าสุด; key อื่น → last-writer-wins + log ใน `audit_log`

---

## 8. Non-functional

| หัวข้อ | เป้า |
|---|---|
| Scan/บันทึก → UI อัปเดต | < 1s (LAN) |
| ค่าน้ำหนักจาก agent | < 500ms |
| Backup | `pg_dump` รายวัน + WAL archive; RPO ≤ 24h (pilot) → ตกลงกับลูกค้า |
| Offline | bridge เก็บ outbox ใน IndexedDB เมื่อ WS หลุด แล้ว replay; server dedupe ด้วย `msgId` |
| Security | password/PIN เป็น bcrypt hash, JWT อายุสั้น, HTTPS ใน LAN (self-signed/mkcert), re-auth สำหรับ override/cancel/reject |
| Observability | request_id ทุก request, structured log, หน้า Sync Health ใน V4 อ่านจาก `/health` |

---

## 9. ความเสี่ยงและเรื่องที่ต้องตัดสินใจ

1. **Phase A ยังใช้ logic ใน browser** — ถ้า 2 เครื่องแก้ RO เดียวกันพร้อมกันอาจทับกัน → demo ได้, แต่ production ต้องถึง Phase B
2. **Write storm** — WH13 มี timer/observer จำนวนมากที่อาจ `setItem` ซ้ำ → bridge ต้อง debounce + เทียบ hash
3. **Patch ใหม่ใน WH13 (เช่น PRP)** ที่เพิ่ม key ใหม่ → ต้องเพิ่มใน mapping §7 ทุกครั้ง (กำหนดเป็น checklist ของ dev)
4. **คำถามลูกค้า:** จำนวนสถานีชั่ง/เครื่อง, ยี่ห้อ-รุ่นเครื่องชั่งและ printer, ต้องการ offline แค่ไหน, deploy ใน LAN หรือ cloud, ข้อมูลเก่าใน localStorage ต้อง migrate หรือไม่
5. **Master data** — `inventoryDB` ใน V4 มีแค่ 8 รายการ → ต้อง import จาก "Inventory code Update 29012024.xlsx" เข้า `product`

---

## 10. ลำดับงานที่แนะนำ

| ลำดับ | งาน | ผลที่ลูกค้าเห็น |
|---|---|---|
| A1 | API skeleton + static host V4/WH13 + `/health` | เปิดผ่าน URL เดียว แทน server.ps1 |
| A2 | Bus relay (WebSocket) + bridge | V4 กับ WH13 คนละเครื่องคุยกันได้ |
| A3 | KV sync + hydrate snapshot | ปิด browser/เปลี่ยนเครื่อง ข้อมูลยังอยู่ |
| A4 | 6 endpoint ที่ V4 เรียกอยู่แล้ว | ประวัติชั่งเก็บที่ server |
| B1 | Master + Auth (รวม user) | login ด้วยบัตรเดียวทุกหน้าจอ |
| B2 | Inventory ledger + Stock Card API | balance ถูกต้องราย Lot |
| B3 | RO/QA approve-reject + HOLD/R3 | Lot ที่ไม่ผ่าน QA จ่ายไม่ได้จริง |
| B4 | Stock out / เบิก / โอน + FEFO | ระบบแนะนำ Lot, กันของไม่พอ |
| B5 | RU/RMA + checks ที่ server | RMA ครบ loop |
| C1 | Scale agent + Printer | ชั่งจริง พิมพ์ label จริง |
