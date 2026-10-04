# 01 — Sequence Diagrams (Overview)

> ประกอบ [BACKEND-DESIGN.md](../BACKEND-DESIGN.md) · UI = V4.html / WH13.html (ไม่เปลี่ยนหน้าจอ) · Backend = WH-RM API
> ทุก diagram แสดงสถานะ **Phase B** (server เป็น source of truth) — จุดที่ต่างใน Phase A มีหมายเหตุกำกับ

## Participants

| ชื่อใน diagram | คือ |
|---|---|
| `Operator` / `WH` / `QA` / `Sup` | ผู้ใช้: พนักงานชั่ง / พนักงานคลัง / QA / หัวหน้างาน |
| `V4` | V4.html + whrm-bridge.js (สถานีชั่ง) |
| `WH13` | WH13.html + whrm-bridge.js (WMS + QA Gate) |
| `API` | REST `/api/v1` |
| `Bus` | WebSocket gateway `/bus` (relay message แบบ envelope เดิมของ WHBus) |
| `DB` | PostgreSQL |
| `Agent` | Scale/Printer agent บนเครื่องสถานีชั่ง (Phase C) |

## สารบัญ

1. [ภาพรวม end-to-end](#1-ภาพรวม-end-to-end)
2. [เปิดหน้าจอ + Hydrate + Login](#2-เปิดหน้าจอ--hydrate--login)
3. [ชั่งน้ำหนักและบันทึก Trip (V4 → WH13)](#3-ชั่งน้ำหนักและบันทึก-trip-v4--wh13)
4. [Override น้ำหนัก](#4-override-น้ำหนัก)
5. [Import เป็น RO (Goods Receipt)](#5-import-เป็น-ro-goods-receipt)
6. [QA ตรวจ + Approve RO / Reject → WHSM06](#6-qa-ตรวจ--approve-ro--reject--whsm06)
7. [Stock Out / เบิก / FGT (FEFO + HOLD + ของพอ)](#7-stock-out--เบิก--fgt-fefo--hold--ของพอ)
8. [โอนย้ายระหว่างคลัง](#8-โอนย้ายระหว่างคลัง)
9. [HOLD / Release Lot](#9-hold--release-lot)
10. [คืนสินค้า RU → RMA](#10-คืนสินค้า-ru--rma)
11. [Offline / Reconnect](#11-offline--reconnect)
12. [PRP — เตรียมวัตถุดิบเข้า WHSM07](#12-prp--เตรียมวัตถุดิบเข้า-whsm07)
13. [ขอปลดล็อก PRP (GR → QA)](#13-ขอปลดล็อก-prp-gr--qa)
14. [ยกเลิก RU (WH13 → V4 → DONE)](#14-ยกเลิก-ru-wh13--v4--done)

---

## 1. ภาพรวม end-to-end

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant V4
    participant API
    participant Bus
    participant WH13
    actor QA

    Operator->>V4: ชั่งสินค้า (รับ/คืน/จ่าย)
    V4->>API: POST /weighing/save-trip
    API-->>V4: reportId ROO… + items
    API->>Bus: TRIP_SAVED
    Bus-->>WH13: TRIP_SAVED (เข้า Auto Weighing inbox)
    WH13->>API: POST /receiving/ro (import)
    API->>Bus: TRIP_IMPORTED
    Bus-->>V4: อัปเดตสถานะ WMS = IMPORTED
    QA->>WH13: ตรวจ QA ผ่าน/ไม่ผ่าน
    WH13->>API: POST /receiving/ro/{roNo}/approve
    API->>API: stock_movement IN (ผ่าน→คลังปลายทาง, ไม่ผ่าน→WHSM06+HOLD)
    API->>Bus: STOCK_CHANGED, RO_UPDATED
    Bus-->>WH13: refresh Stock Card
    Note over WH13,API: จากนั้น: เบิก/จ่าย/โอน (FEFO+HOLD), คืน RU→RMA
```

---

## 2. เปิดหน้าจอ + Hydrate + Login

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Browser
    participant API
    participant DB

    User->>Browser: เปิด http://whrm.local/WH13.html
    Browser->>API: GET /WH13.html
    API->>DB: อ่าน snapshot (master, inbox, RO, stock card ล่าสุด)
    API-->>Browser: HTML + inject window.__WHRM_SNAPSHOT + whrm-bridge.js (ก่อน script แอป)
    Browser->>Browser: bridge เขียน snapshot ลง localStorage whrm_*
    Browser->>Browser: แอปเดิม boot อ่าน localStorage ตามปกติ
    Browser->>API: WebSocket /bus (token, deviceId)
    User->>Browser: สแกนบัตร / กรอก user+password
    Browser->>API: POST /auth/login
    API->>DB: ตรวจ card_id / password_hash, roles
    alt สำเร็จ
        API-->>Browser: 200 {accessToken, user, roles, permissions}
        Browser->>Browser: set currentLoggedInUser / currentUser (UI เดิม)
    else ผิด
        API-->>Browser: 401 AUTH_INVALID (ข้อความไทย)
    end
    Note over Browser,API: Phase A: snapshot = kv_store ทั้งก้อน · Phase B: snapshot สร้างจากตาราง domain
```

---

## 3. ชั่งน้ำหนักและบันทึก Trip (V4 → WH13)

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant Agent
    participant V4
    participant API
    participant DB
    participant Bus
    participant WH13

    Operator->>V4: เลือกประเภท (รับ/คืน/จ่าย/PRP), สินค้า, Batch
    V4->>API: POST /doc-sequences/next {prefix: ROO}
    API->>DB: doc_sequence FOR UPDATE +1
    API-->>V4: ROO20261002-0001
    loop ทุกชิ้น/ทุกถุง
        Agent-->>V4: weight {gross, stable} (ws://localhost)
        V4->>V4: auto capture 10s เมื่อ stable / หรือ manual
        V4->>V4: เพิ่มเข้าตะกร้า (currentTripBasket)
    end
    Operator->>V4: บันทึก Trip
    V4->>API: POST /weighing/save-trip {reportId, tripNo, vehicle…, items[]}
    API->>DB: insert weighing_report + weighing_item (wms_status=SENT) + audit_log
    API-->>V4: 201 {reportId, items[].id}
    API->>Bus: TRIP_SAVED {reportId, weighingType, items[]}
    Bus-->>WH13: TRIP_SAVED
    WH13->>WH13: แสดงใน Auto Weighing inbox (badge ประเภท)
    V4->>API: POST /print/jobs {reportId, type: label}
    API-->>Agent: PRINT_JOB (ZPL)
    Agent-->>API: PRINT_DONE / PRINT_FAILED
```

---

## 4. Override น้ำหนัก

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    actor Sup
    participant V4
    participant API
    participant DB

    Operator->>V4: ขอแก้น้ำหนักที่จับได้
    V4->>Sup: ขอยืนยันตัวตน (บัตร/PIN)
    Sup->>V4: สแกนบัตร + PIN + เหตุผล
    V4->>API: POST /weighing/overrides {itemRef, oldNet, newNet, reason, approverCard, pin}
    API->>DB: ตรวจสิทธิ์ WEIGHT_OVERRIDE + นับ override วันนี้ของสถานี
    alt ผ่าน (≤ 20 ครั้ง/วัน)
        API->>DB: insert override_log + audit_log
        API-->>V4: 200 {overrideId, dailyCount}
        V4->>V4: ใช้ค่าใหม่ + badge Override
    else PIN ผิด ≥ 3 ครั้ง
        API-->>V4: 423 OVERRIDE_LOCKED (ล็อก 60s)
    else เกินโควตา
        API-->>V4: 429 OVERRIDE_DAILY_LIMIT
    end
```

---

## 5. Import เป็น RO (Goods Receipt)

```mermaid
sequenceDiagram
    autonumber
    actor WH
    participant WH13
    participant API
    participant DB
    participant Bus
    participant V4

    WH->>WH13: เปิด Auto Weighing → เลือกรายการ → นำเข้า
    WH13->>API: GET /master/inspection-rules
    API-->>WH13: rules (3A000=QA, CHM-05=GR …)
    WH13->>WH13: เติม inspectionType ตาม rule (เปลี่ยนต้อง override)
    WH->>WH13: เลือกคลังปลายทาง + แนบเอกสาร → ยืนยันสร้าง RO
    WH13->>API: POST /receiving/ro {mode, destWh, items[{weighingItemId, code, lot, qty, unit, inspectionType}]}
    API->>DB: BEGIN
    API->>DB: ตรวจ weighing_item ยังไม่ถูก import (unique)
    API->>DB: ตรวจ rule: item ที่ต้อง QA ห้ามเป็น GR (ยกเว้นมี override)
    API->>DB: doc_sequence RO… · insert receive_order + ro_item (qa_status = NA/PENDING)
    API->>DB: upsert lot (product, lot_no) · weighing_item.wms_status = IMPORTED
    API->>DB: COMMIT
    API-->>WH13: 201 {roNo, items}
    API->>Bus: TRIP_IMPORTED {reportId, itemCodes, importedBy}
    Bus-->>V4: อัปเดตคอลัมน์สถานะ WMS
    opt ลบรายการ / Reject จาก inbox
        WH13->>API: POST /weighing/reports/{id}/items/{itemId}/delete
        API->>Bus: TRIP_ITEMS_DELETED
        Bus-->>V4: สถานะ = DELETED
    end
```

---

## 6. QA ตรวจ + Approve RO / Reject → WHSM06

```mermaid
sequenceDiagram
    autonumber
    actor QA
    actor WH
    participant WH13
    participant API
    participant DB
    participant Bus

    QA->>WH13: เปิด RO → รายการที่ต้อง QA
    alt QA ผ่าน
        WH13->>API: POST /qa/ro-items/{id}/approve {remark}
        API->>DB: ro_item.qa_status = APPROVED · insert qa_decision
    else QA ไม่ผ่าน
        QA->>WH13: เลือกปลายทาง Auto (WHSM06) หรือ Manual (re-auth)
        WH13->>API: POST /qa/ro-items/{id}/reject {remark, mode, destWh?}
        API->>DB: ro_item.qa_status = REJECTED, reject_dest_wh · insert qa_decision
    end
    API-->>WH13: 200 ro_item
    WH->>WH13: ยืนยันรับเข้าคลัง
    WH13->>API: POST /receiving/ro/{roNo}/approve
    API->>DB: BEGIN
    API->>DB: ตรวจ: ไม่มี item QA ที่ยัง PENDING (ไม่งั้น 409 RO_HAS_PENDING)
    loop ทุก item
        alt GR หรือ APPROVED
            API->>DB: stock_movement RECEIVE IN → dest_wh
        else REJECTED
            API->>DB: stock_movement QA_REJECT IN → WHSM06 · lot.status = HOLD
        end
        API->>DB: upsert stock_balance
    end
    API->>DB: receive_order.status = CONFIRMED · audit_log · COMMIT
    API-->>WH13: 200 {roNo, approvedQty, rejectedQty}
    API->>Bus: RO_UPDATED, STOCK_CHANGED, LOT_HELD (ถ้ามี reject)
```

---

## 7. Stock Out / เบิก / FGT (FEFO + HOLD + ของพอ)

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor Sup
    participant WH13
    participant API
    participant DB
    participant Bus

    WH->>WH13: เลือกคลัง + สินค้า
    WH13->>API: GET /inventory/balance?wh=WHRM&product=3A000
    API->>DB: stock_balance join lot (status = AVAILABLE, qty > 0) order by exp_date
    API-->>WH13: lots[] เรียง FEFO (แนะนำ lot แรก)
    WH->>WH13: ระบุ lot + qty + ปลายทาง/แผนก → ยืนยัน
    WH13->>API: POST /requisitions {kind: ISSUE, srcWh, dept, items[{product, lotNo, qty, unit, fefoSkipReason?}]}
    API->>DB: BEGIN · SELECT stock_balance FOR UPDATE
    alt Lot HOLD / อยู่ hold zone
        API-->>WH13: 409 LOT_ON_HOLD "Lot … ถูกกักกัน"
    else ของไม่พอ
        API-->>WH13: 409 INSUFFICIENT_STOCK "มี X ต้องการ Y"
    else ข้าม FEFO โดยไม่มีเหตุผล
        API-->>WH13: 422 FEFO_REASON_REQUIRED
    else ผ่าน
        API->>DB: insert requisition (status = PENDING_APPROVAL) + approval
        API->>DB: COMMIT
        API-->>WH13: 201 {reqNo, status}
        API->>Bus: APPROVAL_UPDATED
    end
    Sup->>WH13: หน้า "ติดตามสถานะการอนุมัติ" → อนุมัติ
    WH13->>API: POST /approvals/{id}/approve
    API->>DB: BEGIN · ตรวจ HOLD/balance ซ้ำ · stock_movement ISSUE OUT · stock_balance · COMMIT
    API-->>WH13: 200
    API->>Bus: STOCK_CHANGED, APPROVAL_UPDATED
    Note over WH13,API: Stock Out (ไม่ต้องอนุมัติ) = POST /inventory/stock-out ใช้กฎตรวจเดียวกันแล้วตัดทันที · FGT = kind FGT (OUT ต้นทาง + IN ปลายทาง)
```

---

## 8. โอนย้ายระหว่างคลัง

```mermaid
sequenceDiagram
    autonumber
    actor WH
    participant WH13
    participant API
    participant DB
    participant Bus

    WH->>WH13: เลือกต้นทาง → ปลายทาง + รายการ
    WH13->>API: POST /inventory/transfers {srcWh, destWh, items[]}
    API->>DB: BEGIN · lock stock_balance (src)
    API->>DB: ตรวจ HOLD + ของพอ (ห้ามโอนออกจาก WHSM06 ถ้าไม่มีสิทธิ์ QA)
    API->>DB: TRANSFER_OUT (src) + TRANSFER_IN (dest) · ref = TR…
    API->>DB: COMMIT
    API-->>WH13: 201 {trNo}
    API->>Bus: STOCK_CHANGED (src, dest)
```

---

## 9. HOLD / Release Lot

```mermaid
sequenceDiagram
    autonumber
    actor QA
    actor WH
    participant WH13
    participant API
    participant DB
    participant Bus

    QA->>WH13: สั่ง HOLD lot (เหตุผล)
    WH13->>API: POST /inventory/lots/{lotId}/hold {reason}
    API->>DB: lot.status = HOLD · audit_log
    API->>Bus: LOT_HELD
    WH->>WH13: พยายามจ่าย lot นี้
    WH13->>API: POST /inventory/stock-out …
    API-->>WH13: 409 LOT_ON_HOLD
    API->>DB: audit_log (DENIED, user, lot)
    WH->>WH13: พยายามปลด HOLD
    WH13->>API: POST /inventory/lots/{lotId}/release
    API-->>WH13: 403 FORBIDDEN_ROLE · audit_log UNAUTHORIZED
    QA->>WH13: ปลด HOLD
    WH13->>API: POST /inventory/lots/{lotId}/release {reason}
    API->>DB: lot.status = AVAILABLE · audit_log
    API->>Bus: LOT_RELEASED
```

---

## 10. คืนสินค้า RU → RMA

```mermaid
sequenceDiagram
    autonumber
    actor Dept as แผนกผู้คืน
    actor WH
    actor QA
    participant WH13
    participant API
    participant DB
    participant Bus
    participant V4

    Dept->>WH13: แบบฟอร์มคืน (คลังปลายทาง, แผนก, เหตุผล, รายการ)
    WH13->>API: POST /returns {destWh, dept, refDoc, reason, items[]}
    API->>DB: ตรวจ code/name ตรง master · RU… · return_request PENDING
    API-->>WH13: 201 {ruNo}
    WH->>WH13: คิว RU → เปิดตรวจ (stage INSPECTING)
    WH13->>API: POST /returns/{ruNo}/rma/start
    API->>DB: rma_session stage = INSPECTING
    API->>Bus: RMA_WEIGH_REQUEST {ruNo, items, destWh}
    Bus-->>V4: เข้า RMA mode (กรองเฉพาะสินค้าที่ต้องคืน)
    V4->>API: ACK
    loop ทุกรายการ
        V4->>V4: ชั่ง/นับจริง
    end
    V4->>API: POST /returns/{ruNo}/rma/weigh-result {items[{ref, actualQty}]}
    API->>DB: insert rma_weigh
    API->>Bus: RMA_WEIGH_RESULT
    Bus-->>WH13: เติม actual qty ใน Table 1/2
    WH13->>API: POST /returns/{ruNo}/rma/checks
    API->>DB: รัน 6 checks (Lot มีจริง, คืน ≤ balance, แจ้ง = นับ, code มี, ชื่อตรง, supplier ตรง)
    API-->>WH13: {stage: AI_PASS | AI_FAIL, checks[]}
    API->>Bus: RMA_AI_RESULT
    QA->>WH13: ตัดสิน QA รายรายการ → สร้าง RMA Report
    WH13->>API: POST /returns/{ruNo}/rma/approve {items[{ref, qaResult, destWh}]}
    API->>DB: BEGIN · RMA-… · stock_movement RETURN IN (ผ่าน→destWh, ไม่ผ่าน→WHSM06+HOLD) · stage APPROVED · COMMIT
    API-->>WH13: 201 {rmaNo}
    API->>Bus: STOCK_CHANGED, RO_UPDATED
    opt ยกเลิก
        WH13->>API: POST /returns/{ruNo}/cancel (re-auth)
        API->>Bus: RMA_CANCEL → V4 ออกจาก RMA mode
    end
```

---

## 11. Offline / Reconnect

```mermaid
sequenceDiagram
    autonumber
    participant V4
    participant Outbox as Bridge Outbox (IndexedDB)
    participant Bus
    participant API
    participant DB

    V4-xBus: WebSocket หลุด
    V4->>Outbox: เก็บ message/command พร้อม msgId (UUID)
    Note over V4: UI ยังทำงานต่อ (badge Bus: Offline)
    V4->>Bus: reconnect {token, lastMsgId}
    Bus->>DB: bus_message where id > lastMsgId
    Bus-->>V4: replay message ที่พลาด
    loop ทุกรายการใน Outbox
        V4->>API: ส่งซ้ำพร้อม header Idempotency-Key = msgId
        API->>DB: เคยประมวลผล msgId นี้หรือยัง
        alt เคยแล้ว
            API-->>V4: 200 (ผลเดิม)
        else ยัง
            API->>DB: ประมวลผล + เก็บ msgId
            API-->>V4: 201
        end
        V4->>Outbox: ลบรายการ
    end
```

---

> **เพิ่ม 2 ต.ค. 2026** ตาม UI เวอร์ชัน `1790951454` (ดู [04-ui-v2-change-review.md](04-ui-v2-change-review.md))

## 12. PRP — เตรียมวัตถุดิบเข้า WHSM07

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor Operator
    actor Prod as ฝ่ายผลิต
    participant V4
    participant API
    participant DB
    participant Bus
    participant WH13

    Note over WH,V4: วัตถุดิบถูกจ่ายออก (ISU) จากคลังมาแล้ว
    Operator->>V4: ประเภทการชั่ง = PRP · ชั่ง · ใส่ Lot + BBF/EXP (เช่น 31/12/2569)
    V4->>API: POST /weighing/save-trip (reportId PRP…)
    API->>DB: weighing_item · prp_status = PENDING · bbf_exp = 2026-12-31 (R13)
    API->>Bus: TRIP_SAVED (weighingType PRP, items[].bbfExp)
    Bus-->>WH13: badge ม่วง · inspectionType = GR ล็อก · _destWh = WHSM07
    WH->>WH13: นำเข้า → สร้าง RO (prpReportId ติดไปกับ RO item)
    WH13->>API: POST /receiving/ro → approve
    API->>DB: stock_movement PRP_IN → WHSM07 เท่านั้น (R12) · lot.exp_date จาก bbf_exp
    Prod->>WH13: สแกนบาร์โค้ดจาก WHSM07 (Phase B)
    WH13->>API: POST /prp/{reportId}/confirm
    API->>DB: PRP_CONFIRM_OUT จาก WHSM07 · prp_status = CONFIRMED
    API->>Bus: STOCK_CHANGED
```

## 13. ขอปลดล็อก PRP (GR → QA)

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor QA
    participant WH13
    participant API
    participant DB

    WH->>WH13: กดปุ่ม "ปลดล็อก" ที่รายการ PRP
    WH13->>WH13: login gate (__rmaGate) + ระบุเหตุผล (บังคับ)
    Note over WH13,API: Phase A: บันทึกลง whrm_qa_issues_v1 (sync ทุกเครื่อง)
    WH13->>API: POST /qa/issues {type PRP_INSPECTION_CHANGE, subjectRef, reason}
    API->>DB: qa_issue status = PENDING_QA
    QA->>WH13: หน้าคิว QA (Phase B)
    WH13->>API: GET /qa/issues?status=PENDING_QA
    alt QA อนุมัติ
        QA->>WH13: อนุมัติ
        WH13->>API: POST /qa/issues/{id}/approve
        API->>DB: ro_item.inspection_type = QA · inspection_locked = false · qa_status = PENDING
    else QA ไม่อนุมัติ
        WH13->>API: POST /qa/issues/{id}/reject {note}
        API->>DB: qa_issue = REJECTED (ยังเป็น GR)
    end
```

## 14. ยกเลิก RU (WH13 → V4 → DONE)

```mermaid
sequenceDiagram
    autonumber
    actor QA
    participant WH13
    participant API
    participant DB
    participant Bus
    participant V4

    QA->>WH13: ยกเลิก RMA Session (rmaCancelSession)
    WH13->>WH13: ลบออกจากคิว + audit RMA_CANCELLED ใน whrm_rma_audit_v1
    WH13->>API: PUT /sync/kv/whrm_rma_audit_v1 (ผ่าน bridge)
    API->>API: พบ RMA_CANCELLED ใหม่ (ไม่เกิน 1 ชม.)
    API->>DB: ru_cancel (ru_no, cancelled_by) · audit RU_CANCELLED
    API->>Bus: RMA_CANCEL_RU {ruNo, cancelledBy}
    alt V4 ออนไลน์
        Bus-->>V4: RMA_CANCEL_RU
    else V4 ปิดอยู่
        Note over API,V4: เก็บไว้ เมื่อ V4 ต่อเข้ามา (hello) ส่งซ้ำ ภายใน 24 ชม.
        Bus-->>V4: RMA_CANCEL_RU (resend)
    end
    V4->>V4: ยืนยัน → ล้าง request/result/ack ของ RU · blacklist
    V4->>Bus: RMA_CANCEL_RU_DONE {ruNo}
    Bus->>API: บันทึก ru_cancel.done_at · audit RU_CANCEL_DONE
    Bus-->>WH13: ไฮไลต์แถว + ป้าย "V4 ล้างแล้ว" + whrm_v4_cancel_done_log_v1
    Note over API: Phase B: POST /returns/{ruNo}/cancel ตั้ง RU = CANCELLED แล้วส่งข้อความเดียวกัน
```
