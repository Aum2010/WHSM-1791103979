# 02 — ERD (PostgreSQL)

> ประกอบ [BACKEND-DESIGN.md](../BACKEND-DESIGN.md) §4 · ชื่อตาราง/คอลัมน์เป็น snake_case · เวลาเป็น `timestamptz`
> จำนวนเป็น `numeric(14,3)` · ทุกตารางธุรกรรมมี `created_at`, `created_by` (ละไว้ใน diagram ถ้าไม่จำเป็น)
> **อัปเดต 2 ต.ค. 2026** ตาม UI เวอร์ชัน `1790951454` — PRP, BBF/EXP, ขอปลดล็อก PRP (`qa_issue`), ยกเลิก RU · ดู [04-ui-v2-change-review.md](04-ui-v2-change-review.md) §7

## สารบัญ
1. [Overview — ความสัมพันธ์ทั้งระบบ](#1-overview)
2. [Master & Security](#2-master--security)
3. [Weighing (V4)](#3-weighing-v4)
4. [Receiving + QA](#4-receiving--qa)
5. [Inventory Ledger](#5-inventory-ledger)
6. [Requisition / Stock Out / Transfer / Approval](#6-requisition--stock-out--transfer--approval)
7. [Return (RU) / RMA](#7-return-ru--rma)
8. [System (sequence, audit, bus, sync, print)](#8-system)
9. [Enums](#9-enums)
10. [Constraints & Indexes สำคัญ](#10-constraints--indexes-สำคัญ)

---

## 1. Overview

```mermaid
erDiagram
    WAREHOUSE ||--o{ STOCK_BALANCE : holds
    PRODUCT ||--o{ LOT : "has lots"
    LOT ||--o{ STOCK_BALANCE : "balance per wh"
    LOT ||--o{ STOCK_MOVEMENT : "ledger"
    WAREHOUSE ||--o{ STOCK_MOVEMENT : "ledger"

    WEIGHING_REPORT ||--|{ WEIGHING_ITEM : contains
    WEIGHING_ITEM ||--o| RO_ITEM : "imported as"
    RECEIVE_ORDER ||--|{ RO_ITEM : contains
    RO_ITEM ||--o{ QA_DECISION : "decided by"
    RO_ITEM }o--|| LOT : "receives into"
    RO_ITEM ||--o{ QA_ISSUE : "unlock request"

    REQUISITION ||--|{ REQUISITION_ITEM : contains
    STOCK_OUT ||--|{ STOCK_OUT_ITEM : contains
    TRANSFER ||--|{ TRANSFER_ITEM : contains
    APPROVAL }o--|| REQUISITION : "approves"

    RETURN_REQUEST ||--|{ RETURN_ITEM : contains
    RETURN_REQUEST ||--o| RMA_SESSION : "inspected in"
    RMA_SESSION ||--o{ RMA_WEIGH : "weighed by V4"
    RMA_SESSION ||--o{ RMA_CHECK : "checked"
    RMA_SESSION ||--o| RMA_REPORT : produces

    APP_USER ||--o{ AUDIT_LOG : performs
    STOCK_MOVEMENT }o--o| RECEIVE_ORDER : "ref"
    STOCK_MOVEMENT }o--o| REQUISITION : "ref"
    STOCK_MOVEMENT }o--o| TRANSFER : "ref"
    STOCK_MOVEMENT }o--o| RMA_REPORT : "ref"
```

> `stock_movement` อ้างเอกสารต้นทางแบบ polymorphic (`ref_type` + `ref_no`) — เส้น "ref" ใน diagram เป็นความสัมพันธ์เชิงตรรกะ ไม่ใช่ FK จริง

---

## 2. Master & Security

```mermaid
erDiagram
    WAREHOUSE {
        varchar code PK "WHRM, WHSM06, WHSM07, WHC ..."
        varchar name
        varchar wh_type "RM, PKG, CHEM, SEMI, PREP, FG, DC, HOLD, OTHER"
        boolean is_hold_zone "WHSM06 = true"
        boolean is_active
    }
    PRODUCT {
        varchar code PK "3A000"
        varchar name "สันนอกหมูสด"
        varchar category "Raw Material, SEMI Product, Finished Product, Waste"
        varchar base_unit "kg, pcs, ไม้"
        int shelf_life_days
        boolean is_active
    }
    UOM_CONVERSION {
        varchar product_code PK,FK
        varchar from_unit PK
        varchar to_unit PK
        numeric factor
    }
    INSPECTION_RULE {
        varchar product_code PK,FK
        varchar required_type "QA, GR"
        varchar reason
        uuid updated_by FK
        timestamptz updated_at
    }
    SUPPLIER {
        varchar code PK "SUP-PIG01"
        varchar name
        varchar tax_id
    }
    CUSTOMER {
        varchar code PK "888"
        varchar name
    }
    DEPARTMENT {
        varchar code PK
        varchar name
    }
    APP_USER {
        uuid id PK
        varchar card_id UK "QA-001"
        varchar username UK
        varchar full_name
        varchar password_hash
        varchar pin_hash "สำหรับ re-auth / override"
        varchar dept_code FK
        varchar status "ACTIVE, INACTIVE"
    }
    ROLE {
        varchar code PK "WEIGH_OPERATOR, WH_STAFF, WH_SUPERVISOR, QA, ADMIN"
        varchar name
    }
    PERMISSION {
        varchar code PK "WEIGHT_OVERRIDE, LOT_RELEASE ..."
        varchar description
    }
    USER_ROLE {
        uuid user_id PK,FK
        varchar role_code PK,FK
    }
    ROLE_PERMISSION {
        varchar role_code PK,FK
        varchar permission_code PK,FK
    }
    DEVICE {
        varchar device_id PK "whrm_device_id"
        varchar station_name
        varchar app "V4, WH13"
        varchar site
        timestamptz last_seen_at
    }

    PRODUCT ||--o{ UOM_CONVERSION : has
    PRODUCT ||--o| INSPECTION_RULE : "rule"
    DEPARTMENT ||--o{ APP_USER : employs
    APP_USER ||--o{ USER_ROLE : has
    ROLE ||--o{ USER_ROLE : assigned
    ROLE ||--o{ ROLE_PERMISSION : grants
    PERMISSION ||--o{ ROLE_PERMISSION : in
```

---

## 3. Weighing (V4)

```mermaid
erDiagram
    WEIGHING_REPORT {
        varchar report_id PK "ROO20261002-0001"
        varchar weighing_type "RECEIVE, RETURN, ISSUE, PRP"
        varchar trip_no
        varchar vehicle_plate
        varchar vehicle_type
        varchar supplier_transport
        varchar customer_code FK
        varchar ru_no FK "ถ้าเป็นการชั่งให้ RMA"
        uuid weighed_by FK
        varchar device_id FK
        timestamptz weighed_at
    }
    WEIGHING_ITEM {
        varchar id PK "_id จาก V4 (bi_...)"
        varchar report_id FK
        varchar product_code FK
        varchar batch_no "เลข Lot ที่ชั่ง"
        numeric gross_weight
        numeric tare_weight
        numeric net_weight
        int pcs_count
        varchar unit
        varchar capture_mode "AUTO, MANUAL, COUNT"
        boolean barcode_passed
        varchar wms_status "SENT, IMPORTED, REJECTED, DELETED"
        varchar bbf_exp_text "ที่พิมพ์ เช่น 31/12/2569"
        date bbf_exp "แปลง พ.ศ. แล้ว (R13)"
        varchar prp_status "PENDING, CONFIRMED (PRP)"
        uuid override_id FK
    }
    OVERRIDE_LOG {
        uuid id PK
        varchar device_id FK
        varchar item_ref
        numeric old_net
        numeric new_net
        varchar reason
        uuid requested_by FK
        uuid approved_by FK
        timestamptz at
    }
    WEIGHING_REPORT ||--|{ WEIGHING_ITEM : contains
    WEIGHING_ITEM |o--o| OVERRIDE_LOG : "overridden by"
```

---

## 4. Receiving + QA

```mermaid
erDiagram
    RECEIVE_ORDER {
        varchar ro_no PK "RO20261002001"
        varchar mode "RECEIVE, RETURN"
        varchar dest_wh FK
        varchar supplier_code FK
        varchar status "PENDING, PARTIAL, CONFIRMED, CANCELLED"
        uuid created_by FK
        timestamptz received_at
        uuid cancelled_by FK
        varchar cancel_reason
    }
    RO_ITEM {
        uuid id PK
        varchar ro_no FK
        varchar weighing_item_id FK,UK "nullable, import ได้ครั้งเดียว"
        varchar product_code FK
        uuid lot_id FK
        numeric qty
        varchar unit
        varchar inspection_type "QA, GR"
        boolean inspection_locked "PRP = true"
        uuid inspection_overridden_by FK
        varchar prp_report_id FK "PRP20261002-0001"
        date bbf_exp
        varchar qa_status "NA, PENDING, APPROVED, REJECTED"
        varchar qa_remark
        varchar reject_dest_wh FK
        varchar reject_mode "AUTO, MANUAL"
    }
    RO_DOCUMENT {
        uuid id PK
        varchar ro_no FK
        varchar doc_type "PO, INVOICE, COA, OTHER"
        varchar doc_ref
        varchar file_key "object storage"
    }
    QA_DECISION {
        bigint id PK
        uuid ro_item_id FK
        varchar decision "APPROVED, REJECTED, RESET"
        varchar remark
        uuid decided_by FK
        timestamptz decided_at
    }
    QA_ISSUE {
        uuid id PK
        varchar type "PRP_INSPECTION_CHANGE"
        varchar status "PENDING_QA, APPROVED, REJECTED"
        varchar subject_type "RO_ITEM, WEIGHING_ITEM"
        varchar subject_ref "reportId / itemId (UI ยังไม่ส่ง)"
        varchar from_type "GR"
        varchar to_type "QA"
        varchar reason
        uuid requested_by FK
        timestamptz requested_at
        uuid decided_by FK "QA"
        timestamptz decided_at
        varchar decision_note
    }
    RECEIVE_ORDER ||--|{ RO_ITEM : contains
    RECEIVE_ORDER ||--o{ RO_DOCUMENT : attaches
    RO_ITEM ||--o{ QA_DECISION : history
    RO_ITEM ||--o{ QA_ISSUE : "unlock request"
```

---

## 5. Inventory Ledger

```mermaid
erDiagram
    LOT {
        uuid id PK
        varchar product_code FK
        varchar lot_no "UK กับ product_code"
        varchar supplier_code FK
        date mfg_date
        date exp_date "ใช้เรียง FEFO — จาก BBF/EXP"
        timestamptz received_at "FIFO เมื่อไม่มี exp_date"
        varchar status "AVAILABLE, HOLD, REJECTED, CONSUMED"
        varchar hold_reason
        uuid hold_by FK
        timestamptz hold_at
    }
    STOCK_MOVEMENT {
        bigint id PK "ลำดับ ledger"
        timestamptz at
        varchar wh_code FK
        varchar product_code FK
        uuid lot_id FK
        varchar unit
        numeric qty_in
        numeric qty_out
        numeric qty_loss
        varchar movement_type "RECEIVE, QA_REJECT, ISSUE, RETURN, FGT_OUT, FGT_IN, TRANSFER_OUT, TRANSFER_IN, STOCK_OUT, RMA_IN, PRP_IN, PRP_CONFIRM_OUT, ADJUST"
        varchar ref_type "RO, REQ, SO, TR, RMA, ADJ"
        varchar ref_no
        varchar counterparty "คลัง/แผนก/ลูกค้า"
        varchar remark
        uuid by_user FK
    }
    STOCK_BALANCE {
        varchar wh_code PK,FK
        varchar product_code PK,FK
        uuid lot_id PK,FK
        varchar unit PK
        numeric qty "CHECK qty >= 0"
        bigint last_movement_id FK
        timestamptz updated_at
    }
    LOT ||--o{ STOCK_MOVEMENT : ledger
    LOT ||--o{ STOCK_BALANCE : balance
    STOCK_MOVEMENT }o--|| STOCK_BALANCE : "projects to"
```

**Stock Card (ที่ UI แสดง)** = view จาก ledger:

```sql
CREATE VIEW v_stock_card AS
SELECT m.*, SUM(m.qty_in - m.qty_out - m.qty_loss)
         OVER (PARTITION BY m.wh_code, m.product_code, m.lot_id, m.unit ORDER BY m.id) AS balance,
       l.lot_no, l.status = 'HOLD' AS hold
FROM stock_movement m JOIN lot l ON l.id = m.lot_id;
```

---

## 6. Requisition / Stock Out / Transfer / Approval

```mermaid
erDiagram
    REQUISITION {
        varchar req_no PK "IO-20261002-001 / FGT-261002-001"
        varchar kind "ISSUE, RETURN, FGT"
        varchar src_wh FK
        varchar dest_wh FK "FGT"
        varchar dept_code FK "ISSUE/RETURN"
        varchar ref_doc
        varchar reason
        varchar status "PENDING_APPROVAL, APPROVED, REJECTED, COMPLETED, CANCELLED"
        uuid requested_by FK
    }
    REQUISITION_ITEM {
        uuid id PK
        varchar req_no FK
        varchar product_code FK
        uuid lot_id FK
        numeric qty
        varchar unit
        varchar fefo_skip_reason
    }
    STOCK_OUT {
        varchar so_no PK "SO-OUT-..."
        varchar wh_code FK
        varchar dest_kind "WAREHOUSE, DEPARTMENT, FREE_TEXT"
        varchar dest
        varchar ref_doc
        uuid by_user FK
    }
    STOCK_OUT_ITEM {
        uuid id PK
        varchar so_no FK
        varchar product_code FK
        uuid lot_id FK
        numeric qty
        varchar unit
    }
    TRANSFER {
        varchar tr_no PK "TR-..."
        varchar src_wh FK
        varchar dest_wh FK
        uuid by_user FK
    }
    TRANSFER_ITEM {
        uuid id PK
        varchar tr_no FK
        varchar product_code FK
        uuid lot_id FK
        numeric qty
        varchar unit
    }
    APPROVAL {
        uuid id PK
        varchar subject_type "REQUISITION, QA, STOCK_OUT"
        varchar subject_no
        varchar status "PENDING, APPROVED, REJECTED"
        uuid decided_by FK
        timestamptz decided_at
        varchar reason
    }
    REQUISITION ||--|{ REQUISITION_ITEM : contains
    STOCK_OUT ||--|{ STOCK_OUT_ITEM : contains
    TRANSFER ||--|{ TRANSFER_ITEM : contains
    REQUISITION ||--o{ APPROVAL : "approval"
```

---

## 7. Return (RU) / RMA

```mermaid
erDiagram
    RETURN_REQUEST {
        varchar ru_no PK "20261002001"
        varchar dest_wh FK
        varchar dept_code FK
        varchar ref_doc
        varchar reason
        varchar status "PENDING, WH_ACCEPTED, IN_RMA, COMPLETE, CANCELLED"
        varchar source "WH13_RETURN_FORM, RMA"
        uuid created_by FK
        uuid cancelled_by FK
        timestamptz cancelled_at
        varchar cancel_reason
        timestamptz cancel_sent_at "ส่ง RMA_CANCEL_RU"
        timestamptz cancel_done_at "V4 ตอบ DONE"
        varchar cancel_done_device
    }
    RETURN_ITEM {
        uuid id PK
        varchar ru_no FK
        int line_no
        varchar product_code FK
        varchar lot_no
        varchar supplier_code FK
        numeric declared_qty
        varchar unit
    }
    RMA_SESSION {
        varchar ru_no PK,FK
        varchar stage "QUEUE, INSPECTING, AI_PASS, AI_FAIL, APPROVED, CANCELLED"
        varchar inspection_type "QA, GR"
        uuid inspection_overridden_by FK
        timestamptz weigh_requested_at
        timestamptz weigh_acked_at
    }
    RMA_WEIGH {
        uuid id PK
        varchar ru_no FK
        uuid return_item_id FK
        numeric actual_qty
        varchar weighing_item_id FK
        uuid weighed_by FK
        varchar device_id FK
        timestamptz at
    }
    RMA_CHECK {
        bigint id PK
        varchar ru_no FK
        uuid return_item_id FK
        varchar dimension "LOT_EXISTENCE, BALANCE_ADEQUATE, DECLARED_VS_ACTUAL, CODE_EXISTS, NAME_MATCHES_CODE, SUPPLIER_MATCH"
        boolean pass
        varchar detail
        int run_no
    }
    RMA_REPORT {
        varchar rma_no PK "RMA-20261002-001"
        varchar ru_no FK,UK
        uuid created_by FK
        timestamptz created_at
    }
    RMA_REPORT_ITEM {
        uuid id PK
        varchar rma_no FK
        uuid return_item_id FK
        numeric qty
        varchar qa_result "APPROVED, REJECTED"
        varchar dest_wh FK
    }
    RETURN_REQUEST ||--|{ RETURN_ITEM : contains
    RETURN_REQUEST ||--o| RMA_SESSION : "inspection"
    RMA_SESSION ||--o{ RMA_WEIGH : weighs
    RMA_SESSION ||--o{ RMA_CHECK : checks
    RMA_SESSION ||--o| RMA_REPORT : produces
    RMA_REPORT ||--|{ RMA_REPORT_ITEM : contains
    RETURN_ITEM ||--o{ RMA_WEIGH : "actual"
```

---

## 8. System

```mermaid
erDiagram
    DOC_SEQUENCE {
        varchar prefix PK "ROO, REE, ISU, PRP, RO, RU, IO, FGT, RMA, TR, SO"
        varchar period PK "YYYYMMDD"
        int last_no
    }
    AUDIT_LOG {
        bigint id PK
        timestamptz at
        uuid user_id FK
        varchar device_id FK
        uuid request_id
        varchar action "RO_APPROVE, LOT_RELEASE, DENIED ..."
        varchar result "OK, DENIED, ERROR"
        varchar entity_type
        varchar entity_id
        jsonb before
        jsonb after
    }
    BUS_MESSAGE {
        bigint id PK "ใช้ replay"
        uuid msg_id UK "idempotency"
        varchar type "TRIP_SAVED ..."
        varchar source "V4, WH13, SERVER"
        varchar device_id FK
        jsonb payload
        timestamptz at
    }
    IDEMPOTENCY_KEY {
        uuid key PK
        varchar endpoint
        int status_code
        jsonb response
        timestamptz at
    }
    KV_STORE {
        varchar key PK "whrm_* (Phase A)"
        jsonb value
        int version "optimistic lock"
        uuid updated_by FK
        varchar device_id FK
        timestamptz updated_at
    }
    RU_CANCEL {
        varchar ru_no PK "Phase A — ใช้ไปก่อนจนมี return_request"
        varchar cancelled_by
        timestamptz cancelled_at
        varchar source_device
        timestamptz sent_at
        int send_count
        timestamptz done_at
        varchar done_device
    }
    PRINT_JOB {
        uuid id PK
        varchar report_id FK
        varchar job_type "LABEL, REPORT"
        varchar device_id FK
        jsonb payload
        varchar status "QUEUED, SENT, DONE, FAILED"
        int attempts
        varchar error
    }
```

---

## 9. Enums

| Enum | ค่า |
|---|---|
| `weighing_type` | RECEIVE (รับ/ROO), RETURN (คืน/REE), ISSUE (จ่าย/ISU), PRP |
| `wms_status` | SENT, IMPORTED, REJECTED, DELETED |
| `inspection_type` | QA, GR |
| `qa_status` | NA, PENDING, APPROVED, REJECTED |
| `ro_status` | PENDING, PARTIAL, CONFIRMED, CANCELLED |
| `lot_status` | AVAILABLE, HOLD, REJECTED, CONSUMED |
| `movement_type` | RECEIVE, QA_REJECT, ISSUE, RETURN, FGT_OUT, FGT_IN, TRANSFER_OUT, TRANSFER_IN, STOCK_OUT, RMA_IN, PRP_IN, PRP_CONFIRM_OUT, ADJUST |
| `requisition_kind` | ISSUE, RETURN, FGT |
| `ru_status` | PENDING, WH_ACCEPTED, IN_RMA, COMPLETE, CANCELLED |
| `rma_stage` | QUEUE, INSPECTING, AI_PASS, AI_FAIL, APPROVED, CANCELLED |
| `prp_status` | PENDING (อยู่ WHSM07 รอฝ่ายผลิต), CONFIRMED (ฝ่ายผลิตสแกนรับ → OUT WHSM07) |
| `qa_issue_status` | PENDING_QA, APPROVED, REJECTED |

## 10. Constraints & Indexes สำคัญ

| ตาราง | Constraint / Index | เหตุผล |
|---|---|---|
| `lot` | `UNIQUE (product_code, lot_no)` | Lot เดียวกันของสินค้าเดียวกันต้องเป็นแถวเดียว |
| `ro_item` | `UNIQUE (weighing_item_id) WHERE weighing_item_id IS NOT NULL` | import รายการชั่งได้ครั้งเดียว (R8) |
| `stock_balance` | `CHECK (qty >= 0)` | ห้ามติดลบ (R2) — กันชั้นสุดท้ายถึงแม้ service พลาด |
| `stock_movement` | `INDEX (wh_code, product_code, lot_id, id)` | Stock Card + running balance |
| `stock_movement` | `INDEX (ref_type, ref_no)` | trace จากเอกสาร |
| `lot` | `INDEX (product_code, exp_date NULLS LAST, received_at) WHERE status = 'AVAILABLE'` | FEFO — Lot ไม่มีวันหมดอายุต่อท้ายแบบ FIFO (R7) |
| `ro_item` | `CHECK (NOT inspection_locked OR inspection_type = 'GR')` เว้นแต่มี qa_issue APPROVED | PRP ล็อก GR (R12) |
| `audit_log`, `stock_movement`, `qa_decision`, `bus_message` | `REVOKE UPDATE, DELETE` จาก app role | append-only (immutable) |
| `audit_log` | `INDEX (at DESC)`, `INDEX (entity_type, entity_id)` | query 30 วัน < 3s |
| `bus_message` | `UNIQUE (msg_id)` | dedupe ตอน reconnect |
| `doc_sequence` | อ่านด้วย `SELECT … FOR UPDATE` | เลขไม่ซ้ำเมื่อหลายเครื่อง (R10) |
