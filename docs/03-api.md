# 03 — API Specification (Overview)

> ประกอบ [BACKEND-DESIGN.md](../BACKEND-DESIGN.md) · Spec เต็ม (schema, request/response) อยู่ที่ [03-openapi.yaml](03-openapi.yaml)
> Flow การเรียกดูที่ [01-sequence-diagrams.md](01-sequence-diagrams.md) · ตารางดูที่ [02-erd.md](02-erd.md)
> **อัปเดต 2 ต.ค. 2026:** PRP, BBF/EXP, `qa_issue`, ยกเลิก RU — ตาม UI `1790951454`

## 1. Conventions

| หัวข้อ | กำหนด |
|---|---|
| Base URL | `https://<host>/api/v1` (pilot: `http://whrm.local/api/v1`) |
| Auth | `Authorization: Bearer <JWT>` ทุก endpoint ยกเว้น `/health`, `/auth/login` |
| Device | header `X-Device-Id: <whrm_device_id>` ทุก request (ใช้ใน audit + override quota) |
| Idempotency | `Idempotency-Key: <uuid>` บังคับสำหรับ `POST` ที่สร้างธุรกรรม (ส่งซ้ำได้ผลเดิม) |
| Re-auth | action อ่อนไหว (override, cancel RO, manual reject, release lot) ส่ง `reauth: {cardId, pin}` ใน body |
| วันที่/เวลา | ISO-8601 UTC (`2026-10-02T03:15:00Z`) — UI แปลงเป็นเวลาไทยเอง |
| จำนวน | number ทศนิยม 3 ตำแหน่ง + `unit` เสมอ |
| Pagination | `?page=1&pageSize=50` → `{ data: [], page, pageSize, total }` |
| ภาษา error | `message` เป็นภาษาไทยพร้อมแสดงผลใน toast ได้ทันที |

### Error format

```json
{
  "error": "LOT_ON_HOLD",
  "message": "ไม่สามารถจ่ายได้ — Lot LOT-2026-01 ถูกกักกัน (HOLD)",
  "details": { "lotNo": "LOT-2026-01", "wh": "WHRM" },
  "requestId": "7b1c…"
}
```

| HTTP | error code | ใช้เมื่อ |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body ไม่ครบ/ผิดรูปแบบ |
| 401 | `AUTH_INVALID`, `TOKEN_EXPIRED` | login ผิด / token หมดอายุ |
| 403 | `FORBIDDEN_ROLE` | ไม่มีสิทธิ์ (log `DENIED` ใน audit) |
| 404 | `NOT_FOUND` | ไม่พบเอกสาร/สินค้า/lot |
| 409 | `LOT_ON_HOLD`, `INSUFFICIENT_STOCK`, `ALREADY_IMPORTED`, `RO_HAS_PENDING`, `INVALID_STATE`, `VERSION_CONFLICT` | ขัดกฎธุรกิจ/สถานะ |
| 422 | `INSPECTION_RULE_VIOLATION`, `FEFO_REASON_REQUIRED`, `MASTER_MISMATCH` | ต้องระบุเหตุผล/override เพิ่ม |
| 423 | `OVERRIDE_LOCKED` | PIN ผิดเกิน 3 ครั้ง |
| 429 | `OVERRIDE_DAILY_LIMIT` | override เกิน 20 ครั้ง/วัน/สถานี |

---

## 2. Endpoint Catalog

ช่อง **Phase**: A = ต้องมีสำหรับ demo หลายเครื่อง · B = กฎธุรกิจ · C = hardware
ช่อง **UI** = จุดใน V4/WH13 ที่ bridge จะเรียก

### 2.1 System & Auth
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| GET | `/health` | A | public | V4 Settings → ทดสอบ API | สถานะ API + DB + bus |
| POST | `/auth/login` | B | public | Login modal (สแกนบัตร / user+pass) | คืน JWT + roles + permissions |
| POST | `/auth/reauth` | B | any | modal "ยืนยันตัวตน" | ตรวจ card+PIN คืน `reauthToken` อายุ 2 นาที |
| GET | `/auth/me` | B | any | badge ผู้ใช้ | ข้อมูลผู้ใช้ปัจจุบัน |
| POST | `/users/save` | A | ADMIN | V4 หน้า Users | (endpoint เดิมของ V4) สร้าง/แก้ user |
| GET | `/users` | B | ADMIN | V4 หน้า Users | รายชื่อผู้ใช้ |

### 2.2 Sync (Phase A)
| Method | Path | Role | คำอธิบาย |
|---|---|---|---|
| GET | `/sync/snapshot?app=V4\|WH13` | any | ค่า `whrm_*` ทั้งหมดที่ต้อง hydrate |
| PUT | `/sync/kv/{key}` | any | `{value, baseVersion}` → 200 `{version}` หรือ 409 `VERSION_CONFLICT` + ค่าล่าสุด |
| DELETE | `/sync/kv/{key}` | any | ลบ key |

### 2.3 Master
| Method | Path | Phase | Role | คำอธิบาย |
|---|---|---|---|---|
| GET | `/master/products?q=&category=` | B | any | สินค้า (แทน `inventoryDB`) |
| GET | `/master/warehouses` | B | any | 14 คลัง + `isHoldZone` |
| GET | `/master/suppliers`, `/master/customers`, `/master/departments` | B | any | dropdown |
| GET | `/master/inspection-rules` | B | any | กฎ QA/GR ต่อสินค้า |
| PUT | `/master/inspection-rules/{productCode}` | B | ADMIN, QA | modal "ตั้งค่ากฎประเภทการตรวจรับ" |
| DELETE | `/master/inspection-rules/{productCode}` | B | ADMIN, QA | ลบกฎ |

### 2.4 Weighing (V4)
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| POST | `/doc-sequences/next` | B | any | `generateReportId()` | `{prefix}` → เลขเอกสารถัดไป |
| POST | `/weighing/items` | A | WEIGH_OPERATOR | `addItemToTripList()` | (endpoint เดิม) รายการที่เพิ่มเข้าตะกร้า → `wms_status=BASKET` |
| POST | `/weighing/save-trip` | A | WEIGH_OPERATOR | `saveEntireTrip()` | (endpoint เดิม) บันทึก trip + publish `TRIP_SAVED` |
| GET | `/weighing/reports?type&from&to&status&q` | B | any | V4 Reports / Logs | ค้นหารายงานชั่ง |
| GET | `/weighing/reports/{reportId}` | B | any | พิมพ์รายงาน | รายละเอียด + items |
| POST | `/weighing/reports/{reportId}/items/{itemId}/delete` | B | WH_STAFF | WH13 inbox ลบ | `wms_status=DELETED` + `TRIP_ITEMS_DELETED` |
| POST | `/weighing/reports/{reportId}/items/{itemId}/reject` | B | WH_STAFF | WH13 inbox reject | `TRIP_REJECTED` |
| POST | `/wms/send` | A | WEIGH_OPERATOR | ปุ่ม "นำส่ง WMS" | (endpoint เดิม) ส่งรายการซ้ำเข้า inbox |
| POST | `/audit/override` | A | WEIGH_OPERATOR | `requestManualOverride()` | (endpoint เดิม) บันทึก override |
| POST | `/weighing/overrides` | B | WH_SUPERVISOR (re-auth) | Override modal | ตรวจสิทธิ์ + quota 20/วัน + lockout |

### 2.5 Receiving + QA (WH13)
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| GET | `/receiving/inbox?type=` | B | WH_STAFF | Auto Weighing modal | รายการชั่งที่ยังไม่ import |
| POST | `/receiving/ro` | B | WH_STAFF | "ยืนยันการสร้าง RO report" | สร้าง RO (ตรวจ rule + import ซ้ำ) |
| GET | `/receiving/ro?status&from&to` | B | any | ตาราง "สถานะการรับเข้า" | รายการ RO |
| GET | `/receiving/ro/{roNo}` | B | any | ขยาย RO | รายละเอียด + items + documents |
| POST | `/receiving/ro/{roNo}/documents` | B | WH_STAFF | "จัดการเอกสารที่เกี่ยวข้อง" | multipart upload |
| POST | `/receiving/ro/{roNo}/approve` | B | WH_STAFF | "ยืนยันรับเข้าคลัง" | ลง ledger (ผ่าน→dest, ไม่ผ่าน→WHSM06+HOLD) |
| POST | `/receiving/ro/{roNo}/cancel` | B | WH_SUPERVISOR (re-auth) | "ยืนยันยกเลิก" | ยกเลิก RO ที่ยังไม่ CONFIRMED |
| POST | `/qa/ro-items/{id}/approve` | B | QA | ปุ่ม "ผ่าน" | qa_status=APPROVED |
| POST | `/qa/ro-items/{id}/reject` | B | QA (manual = re-auth) | "ไม่ผ่าน ➔ RTV" | qa_status=REJECTED + ปลายทาง |
| POST | `/qa/ro-items/{id}/override-type` | B | WH_SUPERVISOR (re-auth) | Override ประเภทตรวจรับ | เปลี่ยน QA↔GR + เหตุผล |
| GET | `/qa/issues?status=PENDING_QA` | B | QA | คิวขอปลดล็อก PRP | รายการ `qa_issue` (Phase A อยู่ใน kv `whrm_qa_issues_v1`) |
| POST | `/qa/issues` | B | WH_STAFF (re-auth) | ปุ่ม "ปลดล็อก" ที่รายการ PRP | `{type: PRP_INSPECTION_CHANGE, subjectRef, reason}` → `PENDING_QA` |
| POST | `/qa/issues/{id}/approve` | B | **QA** | หน้าคิว QA (ใหม่) | ro_item → QA, ปลดล็อก, `qa_status=PENDING` (R12) |
| POST | `/qa/issues/{id}/reject` | B | **QA** | หน้าคิว QA (ใหม่) | ต้องมี note · ยังเป็น GR |

### 2.6 Inventory
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| GET | `/inventory/dashboard` | B | any | view-dashboard | KPI ต่อคลัง (มูลค่า, pending QA, RTV) |
| GET | `/inventory/stock-card?wh&product&lot&from&to` | B | any | แท็บ "Stock Card" | ledger + running balance ราย lot |
| GET | `/inventory/balance?wh&product&includeHold` | B | any | dropdown Lot ตอนจ่าย/เบิก | balance ราย lot เรียง FEFO |
| GET | `/inventory/transactions?wh&from&to` | B | any | แท็บ "ธุรกรรม" | ประวัติธุรกรรม |
| POST | `/inventory/stock-out` | B | WH_STAFF | "ยืนยันจ่ายออก" | ตัดทันที (ตรวจ HOLD/ของพอ/FEFO) |
| POST | `/inventory/transfers` | B | WH_STAFF | "ยืนยันโอนย้าย" | OUT ต้นทาง + IN ปลายทาง |
| GET | `/inventory/lots?product&status` | B | any | — | ค้นหา lot |
| POST | `/inventory/lots/{lotId}/hold` | B | QA, WH_SUPERVISOR | — | HOLD |
| POST | `/inventory/lots/{lotId}/release` | B | **QA เท่านั้น** (re-auth) | — | ปลด HOLD |
| POST | `/inventory/adjustments` | B | WH_SUPERVISOR | — | ปรับยอด (ต้องมีเหตุผล) |

### 2.7 Requisition / Approval
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| POST | `/requisitions` | B | WH_STAFF, PRODUCTION | "ยืนยันขอเบิก / คืน / นำส่ง FGT" | `kind` = ISSUE/RETURN/FGT |
| GET | `/requisitions?kind&status` | B | any | — | รายการ |
| GET | `/approvals?type&status` | B | WH_SUPERVISOR, QA | view-approval | คิวอนุมัติ |
| POST | `/approvals/{id}/approve` | B | WH_SUPERVISOR | ปุ่ม "อนุมัติ" | ตัด stock ตอนอนุมัติ |
| POST | `/approvals/{id}/reject` | B | WH_SUPERVISOR | ปุ่ม "ไม่อนุมัติ" | ต้องมีเหตุผล |

### 2.8 Return (RU) / RMA
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| POST | `/returns` | B | any | แท็บ "การคืนสินค้า" | สร้าง RU |
| GET | `/returns?status` | B | any | คิว RU | รายการ RU + stage |
| GET | `/returns/{ruNo}` | B | any | Inspect modal | รายละเอียด + weigh + checks |
| POST | `/returns/{ruNo}/accept` | B | WH_STAFF | — | WH รับเรื่อง |
| POST | `/returns/{ruNo}/rma/start` | B | WH_STAFF | "Auto Weighing" ใน RMA | publish `RMA_WEIGH_REQUEST` |
| POST | `/returns/{ruNo}/rma/weigh-result` | B | WEIGH_OPERATOR | V4 RMA mode | ผลชั่งจริง → `RMA_WEIGH_RESULT` |
| POST | `/returns/{ruNo}/rma/checks` | B | WH_STAFF, QA | ปุ่มตรวจ AI | รัน 6 checks → `AI_PASS/AI_FAIL` |
| POST | `/returns/{ruNo}/rma/approve` | B | QA | "นำเข้าเพื่อสร้าง RMA Report" | สร้าง RMA + ledger |
| POST | `/returns/{ruNo}/cancel` | B | WH_SUPERVISOR, QA (re-auth) | "ยกเลิก RMA" | RU → `CANCELLED` + ส่ง `RMA_CANCEL_RU` → รอ `RMA_CANCEL_RU_DONE` (R15) · **Phase A:** server ส่งเองเมื่อเห็น audit `RMA_CANCELLED` |

### 2.8b PRP (Preparing Station)
| Method | Path | Phase | Role | UI | คำอธิบาย |
|---|---|---|---|---|---|
| GET | `/prp?status=PENDING` | B | any | — | PRP ที่อยู่ WHSM07 รอฝ่ายผลิต |
| POST | `/prp/{reportId}/confirm` | B | PRODUCTION | สแกนบาร์โค้ดที่ WHSM07 | `prp_status=CONFIRMED` + OUT จาก WHSM07 (R12) |

### 2.9 Reports / Audit / Print
| Method | Path | Phase | Role | คำอธิบาย |
|---|---|---|---|---|
| GET | `/reports/{name}?…&format=json\|csv\|xlsx\|pdf` | B | any | ศูนย์รายงาน (stock-card, receiving, weighing, rma, movement) |
| GET | `/audit?user&action&entity&from&to` | B | ADMIN | audit trail (≤ 30 วัน < 3s) |
| POST | `/print/jobs` | C | any | สร้างงานพิมพ์ label → agent |
| GET | `/print/jobs?status` | C | any | คิวพิมพ์ (V4 Print Queue) |
| POST | `/print/jobs/{id}/retry` | C | any | พิมพ์ซ้ำ |
| GET | `/ru-cancels` | **A** | any | งานยกเลิก RU: ส่งให้ V4 กี่ครั้ง / V4 ตอบ DONE หรือยัง |

---

## 3. WebSocket Bus — `wss://<host>/bus`

**Connect:** `?token=<JWT>&deviceId=<id>&app=V4|WH13&lastMsgId=<n>` → server replay message ที่พลาด

**Envelope (เหมือน WHBus เดิม + `msgId`):**
```json
{ "type": "TRIP_SAVED", "version": 1, "source": "WeighingmodelV4",
  "timestamp": "2026-10-02T03:15:00Z", "msgId": "uuid", "payload": { } }
```

| Type | ทิศทาง | Payload หลัก | ผู้ฟัง |
|---|---|---|---|
| `PING` / `PONG` | ทั้งคู่ | `{at}` | badge "Bus: Live" |
| `TRIP_SAVED` | server → WH13 | `{reportId, weighingType, tripNo, vehicle…, items[]}` | Auto Weighing inbox |
| `TRIP_IMPORTED` | server → V4 | `{reportId, itemCodes[], importedBy, roNo}` | สถานะ WMS ใน Logs |
| `TRIP_ITEMS_DELETED` | server → V4 | `{reportId, itemCodes[], deletedBy}` | 〃 |
| `TRIP_REJECTED` | server → V4 | `{reportId, itemCode, qty, unit, reason}` | 〃 |
| `RMA_WEIGH_REQUEST` | server → V4 | `{ruNo, destWh, items[{ref, code, name, lot, declaredQty, unit}]}` | เข้า RMA mode |
| `RMA_WEIGH_ACK` | V4 → server | `{ruNo, itemCount}` | stage badge |
| `RMA_WEIGH_RESULT` | server → WH13 | `{ruNo, items[{ref, actualQty}]}` | Table 1/2 |
| `RMA_AI_RESULT` | server → WH13 | `{ruNo, stage, checks[]}` | AI section |
| `RMA_CANCEL_RU` | server → V4 | `{ruNo, rmaNo, cancelledBy, items}` | V4 ล้างข้อมูล RU + blacklist (ส่งซ้ำเมื่อ V4 ต่อเข้ามา จนกว่าจะได้ DONE) |
| `RMA_CANCEL_RU_DONE` | V4 → server → WH13 | `{ruNo, rmaNo, clearedAt}` | WH13 ป้าย "V4 ล้างแล้ว" · server บันทึก `done_at` |
| `RO_UPDATED` | server → WH13 | `{roNo, status}` | ตารางสถานะรับเข้า |
| `STOCK_CHANGED` | server → ทุกจอ | `{wh, productCode, lotId, balance}` | refresh Stock Card |
| `LOT_HELD` / `LOT_RELEASED` | server → ทุกจอ | `{lotId, lotNo, by, reason}` | badge Hold |
| `APPROVAL_UPDATED` | server → WH13 | `{id, subjectNo, status}` | view-approval |
| `KV_CHANGED` (Phase A) | server → ทุกจอ | `{key, version, value}` | bridge เขียน localStorage + fire `storage` |
| `PRINT_JOB` / `PRINT_DONE` / `PRINT_FAILED` | server ↔ Agent | `{jobId, zpl \| error}` | Print Queue |
| `SCALE_READING` | Agent → V4 (localhost) | `{gross, unit, stable}` | แทน `simulateWeight()` |

**กฎ:** message ที่เปลี่ยนข้อมูลต้องผ่าน REST เสมอ — bus ใช้แจ้งเหตุการณ์เท่านั้น (server publish หลัง commit) ยกเว้น Phase A ที่ relay message จาก UI ตรง ๆ

---

## 4. Role × Endpoint (สรุป)

| กลุ่ม | WEIGH_OPERATOR | WH_STAFF | WH_SUPERVISOR | QA | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|
| ชั่ง / save-trip / print | ✅ | ✅ | ✅ | — | ✅ |
| Override น้ำหนัก (approve) | — | — | ✅ | — | ✅ |
| สร้าง RO / import / reject inbox | — | ✅ | ✅ | — | ✅ |
| ตัดสิน QA (ผ่าน/ไม่ผ่าน) | — | — | — | ✅ | — |
| Override ประเภทตรวจ, ยกเลิก RO | — | — | ✅ | — | ✅ |
| Approve RO (รับเข้าคลัง) | — | ✅ | ✅ | — | ✅ |
| Stock out / โอน / ขอเบิก | — | ✅ | ✅ | — | ✅ |
| อนุมัติเบิก | — | — | ✅ | — | ✅ |
| HOLD lot | — | — | ✅ | ✅ | — |
| **Release lot** | — | — | — | ✅ | — |
| อนุมัติขอปลดล็อก PRP | — | — | — | ✅ | — |
| ยืนยันรับ PRP (ฝ่ายผลิต) | — | — | — | — | ✅ (+ PRODUCTION) |
| RMA checks / approve | — | ✅ / — | ✅ / — | ✅ / ✅ | — |
| Master / rules / users | — | — | — | rules | ✅ |
| Audit | — | — | — | — | ✅ |
