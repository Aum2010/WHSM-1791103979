# 01 — Sequence Diagrams (สถานะปัจจุบัน)

> แสดงสิ่งที่ระบบทำจริง ณ 2 พ.ย. 2026 บน branch `phase0-cleanup` (UI ลูกค้า 31 ต.ค.)  
> ฉบับเดิม (ต.ค.) เป็นแผน "Phase B" ที่ server คุม Stock เอง ดูได้จาก git: `git show 58c88c8:docs/01-sequence-diagrams.md`  
> ส่วนที่ยังไม่ได้ทำดูที่[ข้อ 15](#15-ยังไม่มีในระบบ)

## หลักที่ต้องรู้ก่อนอ่าน

ข้อมูลธุรกิจส่วนใหญ่ยัง**คำนวณที่หน้าจอ** แล้วซิงก์ทั้ง key ผ่าน server · มีเฉพาะงานขาย (BD02) ที่เก็บแยกเป็นตาราง

| ข้อมูล | เก็บที่ | ใครตรวจกติกา |
|---|---|---|
| Stock, RO, ใบโอน, คิวขนส่ง, RA / RMA, คิว QA, PL Queue | `kv_store` หนึ่งแถวต่อ key | หน้าจอ |
| ออเดอร์ SBO, คิวส่ง WH13, ผลตอบกลับ, ใบเสนอราคา | `sbo_order`, `sbo_handoff`, `sbo_decision`, `quotation` | server |
| ผู้ใช้, สิทธิ์, session | `app_user`, `user_access`, `auth_session` | server |
| ผลชั่ง V4 (สำเนาเพื่อค้นหา), Override, ข้อความ Bus, Audit | `weighing_*`, `override_log`, `bus_message`, `audit_log` | server บันทึกอย่างเดียว |

## Participants

| ชื่อใน diagram | คือ |
|---|---|
| `V4` `WH13` `LG02` `BD02` `QA` `PLN` | หน้าจอลูกค้า + `whrm-bridge.js` (QA = QAincoming03, PLN = Production planning301) |
| `Bridge` | `whrm-bridge.js` ในหน้าจอ: ดักการเขียน localStorage และ BroadcastChannel |
| `API` | REST `/api/v1` (Fastify) |
| `Bus` | WebSocket `/bus` ส่งต่อข้อความข้ามเครื่อง และเก็บลง `bus_message` |
| `DB` | PostgreSQL |

## สารบัญ

1. [ภาพรวมการไหลของข้อมูล](#1-ภาพรวมการไหลของข้อมูล)
2. [Login และเปิดหน้าจอ](#2-login-และเปิดหน้าจอ)
3. [ซิงก์ KV และเมื่อสองเครื่องแก้พร้อมกัน](#3-ซิงก์-kv-และเมื่อสองเครื่องแก้พร้อมกัน)
4. [ยืนยันตัวตนในหน้าจอและตรวจสิทธิ์](#4-ยืนยันตัวตนในหน้าจอและตรวจสิทธิ์)
5. [ชั่งน้ำหนัก V4 → WH13](#5-ชั่งน้ำหนัก-v4--wh13)
6. [รับเข้า RO + QA](#6-รับเข้า-ro--qa)
7. [โอนย้าย: สแกนรับที่ปลายทาง](#7-โอนย้าย-สแกนรับที่ปลายทาง)
8. [โอนย้ายผ่าน LG02 (Transfer to Logistic)](#8-โอนย้ายผ่าน-lg02-transfer-to-logistic)
9. [ชั่ง FGT ผ่าน V4](#9-ชั่ง-fgt-ผ่าน-v4)
10. [ออเดอร์ BD02 → WH13 → BD02](#10-ออเดอร์-bd02--wh13--bd02)
11. [ใบเสนอราคาและสิทธิ์](#11-ใบเสนอราคาและสิทธิ์)
12. [จ่ายของ (Dispatch)](#12-จ่ายของ-dispatch)
13. [คืนสินค้า RU → RMA และยกเลิก RU](#13-คืนสินค้า-ru--rma-และยกเลิก-ru)
14. [เน็ตหลุดและกลับมา](#14-เน็ตหลุดและกลับมา)
15. [ยังไม่มีในระบบ](#15-ยังไม่มีในระบบ)

---

## 1. ภาพรวมการไหลของข้อมูล

```mermaid
sequenceDiagram
    autonumber
    participant Page as หน้าจอลูกค้า
    participant Bridge
    participant API
    participant Bus
    participant DB
    participant Other as เครื่องอื่น

    Page->>Bridge: localStorage.setItem (key ที่ซิงก์)
    Bridge->>API: PUT /sync/kv/:key {value, baseVersion}
    API->>DB: kv_store + kv_history
    API->>Bus: kind kv
    Bus-->>Other: ค่าใหม่ → เขียนลง localStorage
    Page->>Bridge: BroadcastChannel.postMessage
    Bridge->>Bus: kind bus {channel, msgId, data}
    Bus->>DB: bus_message
    Bus-->>Other: ส่งต่อให้ BroadcastChannel ของเครื่องนั้น
    Note over Page,Other: งานขายไม่ผ่านเส้นทางนี้ ดูข้อ 10–11
```

---

## 2. Login และเปิดหน้าจอ

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Page as login.html / หน้าจอ
    participant Bridge
    participant API
    participant DB

    User->>Page: ชื่อผู้ใช้ + รหัสผ่าน
    Page->>API: POST /auth/login
    API->>DB: ตรวจ password_hash · นับรหัสผิด
    alt ผิดเกินกำหนด
        API-->>Page: 423 LOGIN_LOCKED
    else สำเร็จ
        API-->>Page: Cookie HttpOnly หรือ token (เมื่อ frontend คนละโดเมน)
    end
    Page->>Bridge: เปิดหน้าจอ · bridge โหลดก่อนสคริปต์ของหน้า
    Bridge->>API: GET /sync/snapshot (รอผล)
    alt 401
        Bridge->>Page: ไปหน้า login
    else ล่ม / ติดต่อไม่ได้
        Bridge->>Page: ใช้ข้อมูลในเครื่อง (Offline)
    else สำเร็จ
        API-->>Bridge: kv ทั้งหมด + busSeq
        Bridge->>Page: เขียนลง localStorage
    end
    opt BD02 หรือ WH13
        Bridge->>API: GET /sales/snapshot?want=bd02 หรือ wh13 (รอผล)
    end
    Bridge->>API: GET /auth/me
    API-->>Bridge: user + access รายส่วน
    alt สิทธิ์ส่วนนี้ = NONE
        Bridge->>Page: แสดง "ไม่มีสิทธิ์ใช้หน้านี้"
    end
    Bridge->>API: WebSocket /bus · hello {deviceId, app, lastSeq}
```

---

## 3. ซิงก์ KV และเมื่อสองเครื่องแก้พร้อมกัน

```mermaid
sequenceDiagram
    autonumber
    participant A as เครื่อง A
    participant API
    participant DB
    participant B as เครื่อง B

    A->>API: PUT /sync/kv/k {baseVersion 5}
    API->>DB: lock ราย key · version 5 → 6
    API-->>A: version 6
    API-->>B: kind kv version 6
    B->>API: PUT /sync/kv/k {baseVersion 5}
    API-->>B: 409 VERSION_CONFLICT + ค่าปัจจุบัน
    B->>B: merge 3 ทาง (base / เครื่องนี้ / server)
    B->>API: PUT /sync/kv/k {baseVersion 6, ค่าที่รวมแล้ว}
    API-->>B: version 7
    Note over B: ค่าเดี่ยวที่แก้ทั้งสองฝั่ง ใช้ค่าของเครื่องที่กำลังส่ง
    Note over A,API: กู้ค่าเก่าได้ด้วย POST /sync/kv/:key/restore (เก็บ 20 รุ่นล่าสุด)
```

---

## 4. ยืนยันตัวตนในหน้าจอและตรวจสิทธิ์

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Page as WH13 / V4 / BD02 / DBV2.0
    participant Bridge
    participant API

    User->>Page: กรอกรหัสในหน้าต่างของหน้าจอ
    Page->>Bridge: ดักปุ่มยืนยัน หรือเรียก __whrmCredOk
    Bridge->>API: POST /auth/verify {username, password, module, minLevel}
    alt ไม่ผ่าน
        API-->>Bridge: ok false
        Bridge-->>Page: แสดงข้อความ · ไม่ดำเนินการ
    else ผ่าน
        API-->>Bridge: user + level + alias
        Bridge->>Page: ใส่รหัสใช้ครั้งเดียวให้ตัวตรวจเดิมของหน้าจอ
        Page-->>User: ทำงานในนามผู้ใช้นั้น
    end
    Note over Page,API: คำสั่งล้างข้อมูลตรวจ role ADMIN ที่หน้าจอ (__whrmAdminOnly) ยังไม่ได้บังคับที่ API
```

---

## 5. ชั่งน้ำหนัก V4 → WH13

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant V4
    participant API
    participant Bus
    participant WH13

    Operator->>V4: เลือกประเภทและสินค้า · ชั่ง Auto หรือ Manual
    opt ต้องแก้น้ำหนัก
        V4->>API: POST /audit/override
    end
    V4->>API: POST /weighing/items (สำเนาลงตาราง)
    Operator->>V4: บันทึกเที่ยว และนำส่ง WMS
    V4->>API: POST /weighing/save-trip · POST /wms/send
    V4->>Bus: TRIP_SAVED {reportId, items}
    alt WH13 เปิดอยู่
        Bus-->>WH13: TRIP_SAVED
    else WH13 ปิดอยู่
        Bus-->>WH13: ตอนเปิด ส่งรายงานเก่าซ้ำ (replay) ตาม hello
    end
    WH13->>WH13: Bridge ตัดรายการที่เคยรับแล้ว (กันซ้ำ)
    WH13->>Bus: TRIP_IMPORTED / TRIP_ITEMS_DELETED / TRIP_REJECTED
    Bus-->>V4: อัปเดตสถานะ WMS
```

---

## 6. รับเข้า RO + QA

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor QAUser as QA
    participant WH13
    participant KV as kv_store
    participant QA

    WH->>WH13: นำเข้ารายการ เลือกประเภทตรวจ
    WH13->>KV: whrm_ro_status_v6 (RO)
    opt รายการต้องตรวจ QA
        WH13->>KV: whrm_qa_incoming_v1
        WH13-->>QA: QA_INCOMING_ISSUE
        QAUser->>QA: ผ่าน หรือ ไม่ผ่าน
        QA->>KV: whrm_qa_incoming_result_v1
        QA-->>WH13: QA_INCOMING_RESULT
    end
    WH->>WH13: ยืนยันรับเข้า
    WH13->>WH13: ตรวจเงื่อนไข · คำนวณ Stock ที่หน้าจอ
    WH13->>KV: whrm_warehouse_data_v1 (stockCards)
    Note over WH13,KV: server ไม่ตรวจยอด เก็บผลจากหน้าจอ
```

---

## 7. โอนย้าย: สแกนรับที่ปลายทาง

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor Recv as ผู้รับ
    participant WH13
    participant API
    participant KV as kv_store

    WH->>WH13: เลือกต้นทาง ปลายทาง รายการ · เลือกโหมด
    WH13->>API: POST /auth/verify (ผู้ยืนยัน)
    WH13->>KV: whrm_dc_transfer_v1 สถานะรอผู้รับ
    Note over WH13: เริ่มนับกรอบเวลารับ ยังไม่ตัด Stock
    Recv->>WH13: สแกนรับทีละรายการ (บัตร หรือรหัส)
    WH13->>API: POST /auth/verify (ผู้รับ)
    WH13->>KV: ตัดต้นทาง + รับเข้าปลายทาง เฉพาะรายการที่รับ
    alt เลยกำหนด
        WH13->>KV: สถานะ LOCKED
        WH->>WH13: ปลดล็อกโดยผู้มีสิทธิ์
        WH13->>API: POST /auth/verify
    end
```

---

## 8. โอนย้ายผ่าน LG02 (Transfer to Logistic)

ทดสอบกดจริงแล้ว · ตัด Stock เมื่อรับปลายทาง ตามคำตอบลูกค้า 2 พ.ย. ([12-customer-decisions.md](12-customer-decisions.md) ข้อ 4)

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor LG
    participant WH13
    participant KV as kv_store
    participant LG02

    WH->>WH13: โอนไป WHDC · Transfer to Logistic · ยืนยัน 2 คน
    WH13->>KV: whrm_dc_transfer_v1 + whrm_logistic_queue_v1
    WH13-->>LG02: LOGISTIC_HANDOFF
    alt ปฏิเสธ (ยังไม่รับงาน + เหตุผล ≥ 3 ตัวอักษร)
        LG->>LG02: ปฏิเสธ
        LG02->>KV: คิว REJECTED · บันทึกผู้ login
        LG02-->>WH13: LOGISTIC_REJECTED
        WH13->>WH13: แสดง "LG ปฏิเสธงาน" + ปุ่มยกเลิกใบ
        WH->>WH13: WH002 ยกเลิกใบ
        WH13->>KV: CANCELLED · หายจากตารางรอผู้รับ · ไม่เคลื่อน Stock
    else รับงาน
        LG->>LG02: รับเข้า LG
        LG02-->>WH13: LOGISTIC_ACCEPTED
        LG->>LG02: Loading / Transit · ยืนยันโหลดและรถออก
        LG02->>LG02: ตรวจซ้ำว่าใบไม่ถูกปฏิเสธ · ตรวจ Stock ต้นทาง
        LG02->>KV: บันทึก departedAt และแผนตาม Supplier · ยังไม่ตัด Stock
        Note over LG02,KV: เริ่มกรอบเวลา 72 ชั่วโมง · ไม่มีการกันยอด ของบนรถยังนับอยู่ที่ต้นทาง
        LG->>LG02: FGT รับเข้าปลายทาง · กรอกผู้รับ (รับทีละส่วนได้)
        alt Stock ต้นทางไม่พอ
            LG02-->>LG: ไม่ให้รับเข้า ให้ตรวจกับคลังต้นทาง
        else ปกติ
            LG02->>KV: ตัดต้นทาง + รับเข้าปลายทาง ตามจำนวนที่รับ
            LG02-->>WH13: FGT_RECEIPT_UPDATED / FGT_RECEIPT_COMPLETED
        end
        opt เลย 72 ชั่วโมงและรับไม่ครบ
            WH13->>KV: LOCKED · LG02 ปิดปุ่มรับเข้า
            WH->>WH13: ผู้มีสิทธิ์ปลดล็อก · ต่อเวลาตามที่ตั้งไว้
        end
    end
```

---

## 9. ชั่ง FGT ผ่าน V4

```mermaid
sequenceDiagram
    autonumber
    actor LG
    participant LG02
    participant KV as kv_store
    participant V4
    participant API

    LG->>LG02: FGT รับเข้าปลายทาง · ส่งชั่ง V4
    LG02->>KV: whrm_fgt_v4_requests_v1
    LG02-->>V4: V4_FGT_WEIGH_REQUEST
    LG02->>V4: เปิดแท็บ V4.html
    alt บัญชี V4 = NONE และ LOGISTICS ≥ USE
        V4->>V4: ซ่อนเมนูอื่น · ไม่มีคำขอ = แสดงหน้ารอ
        V4->>API: POST /auth/verify {module V4, scope FGT}
    else ไม่มีสิทธิ์ทั้งสองส่วน
        V4-->>LG: ไม่มีสิทธิ์ใช้หน้านี้
    end
    LG->>V4: เริ่มชั่ง (ระบบเติมสินค้าและ Lot) · บันทึกผล
    V4->>KV: whrm_fgt_v4_results_v1
    V4-->>LG02: V4_FGT_WEIGH_RESULT
    LG02->>KV: อัปเดตใบโอน
```

---

## 10. ออเดอร์ BD02 → WH13 → BD02

ทดสอบกดจริง: สร้างออเดอร์, ยกเลิก, Accept to WH, Need to PLN และ PLN ตอบรับ  
ขั้นตอนใน Dispatch: กดจริงไม่ครบ ผลการจ่ายทดสอบโดยตั้งสถานะ IO เป็น COMPLETE โดยตรง

```mermaid
sequenceDiagram
    autonumber
    actor Sale
    actor WH
    participant BD02
    participant API
    participant DB
    participant WH13
    participant PLN

    Sale->>BD02: ยืนยันและส่งเข้าคลัง
    alt ตะกร้าว่าง
        BD02-->>Sale: แจ้งเตือน ไม่สร้างออเดอร์
    else ติดต่อ server ไม่ได้
        BD02-->>Sale: แจ้งเตือน ไม่สร้างออเดอร์
    else ปกติ
        BD02->>API: POST /sales/sbo-numbers (รอผล)
        API->>DB: doc_seq +1
        API-->>BD02: SBO + SO
        BD02->>API: PUT /sales/orders/:sbo · POST /sales/handoffs (ผ่าน outbox)
        API->>DB: sbo_order + sbo_handoff (1 SBO ส่งได้ครั้งเดียว)
    end
    loop ทุก 2 วินาที
        WH13->>API: GET /sales/snapshot?want=wh13
    end
    WH13->>API: POST /sales/handoffs/:id/claim (รอผล)
    alt เครื่องแรก
        API-->>WH13: claimed true · เข้า Info Center
    else เครื่องอื่นรับแล้ว
        API-->>WH13: claimed false · ไม่เข้าซ้ำ
    end
    WH->>WH13: Info Center · ดำเนินการ (ต้องเป็นผู้ดูแล WH13)
    alt Cancelled
        WH13->>API: POST /sales/decisions REJECT
    else Accept to WH
        WH13->>API: POST /sales/decisions ACCEPT
        Note over WH13: สร้าง IO ไปศูนย์จ่ายออก ดูข้อ 12
    else Need to PLN
        WH13->>API: POST /sales/decisions TRANSFER_PL
        WH13-->>PLN: PL_TRANSFER_REQUEST
        PLN-->>WH13: PL_STATUS_UPDATE (ตอบรับ / ยกเลิก / เรียกคืน)
        WH13->>API: POST /sales/decisions PLN_*
    end
    API->>DB: sbo_decision (ผลซ้ำจากหลายเครื่องเก็บครั้งเดียว)
    loop ทุก 2 วินาที
        BD02->>API: GET /sales/snapshot?want=bd02
    end
    BD02->>BD02: ใช้ผลกับออเดอร์
    BD02->>API: POST /sales/decisions/consume · PUT /sales/orders/:sbo
```

---

## 11. ใบเสนอราคาและสิทธิ์

```mermaid
sequenceDiagram
    autonumber
    actor Sale
    actor Admin
    participant BD02
    participant API
    participant DB

    Sale->>BD02: สร้างใบเสนอราคา
    BD02->>API: POST /sales/quotation-numbers
    API-->>BD02: QT-YYYYMM-NNN
    Sale->>BD02: บันทึก Draft หรือ Ready
    BD02->>API: PUT /sales/quotations/:id (ผ่าน outbox)
    alt BD02 ระดับ USE ขึ้นไป
        API->>DB: quotation
        API-->>BD02: version
    else VIEW หรือไม่มีสิทธิ์
        API-->>BD02: 403 FORBIDDEN_MODULE · audit DENIED
    end
    Admin->>API: PUT /users/:username (ถอนสิทธิ์ BD02)
    BD02->>API: GET /sales/snapshot?want=bd02
    API-->>BD02: 403
    BD02->>BD02: ลบใบเสนอราคาออกจากเครื่อง
    Note over BD02,API: ลบใบ = deleted_at ในตาราง · ใบเสนอราคาไม่อยู่ใน kv_store
```

---

## 12. จ่ายของ (Dispatch)

อ่านจากโค้ด: ขั้นตรวจ, ชั่ง และ AI ยังไม่ได้กดทดสอบครบ

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor Recv as ผู้รับ
    participant WH13
    participant KV as kv_store
    participant LG02
    participant API

    WH->>WH13: IO Queue · ตรวจสอบ · เลือกคลัง / Lot
    WH->>WH13: ชั่ง (V4 หรือ AutoWeight) · ตรวจด้วย AI · สร้าง RA
    WH->>WH13: ยืนยันจ่าย · เลือกโหมด · ผู้อนุมัติ login
    alt Released (ค่าเริ่มต้นของ IO)
        WH13->>KV: ตัด Stock ทันที · COMPLETE
    else Wait for receiver (ค่าเริ่มต้นของ EO / SO)
        WH13->>KV: RA = WAIT_RECEIVER ยังไม่ตัด Stock
        Recv->>WH13: สแกนรับของ
        WH13->>KV: ตัด Stock · COMPLETE
    else Transfer to Logistic (EO / SO)
        WH13->>KV: ตัด Stock ทันที · เข้า whrm_logistic_queue_v1
        WH13-->>LG02: LOGISTIC_HANDOFF
    end
    opt IO มาจากออเดอร์ BD02
        WH13->>API: POST /sales/decisions DISPATCH
    end
```

หมายเหตุ: โหมด Transfer to Logistic ของ **Dispatch ตัด Stock ทันที** แต่ของ**ใบโอน (ข้อ 8) ตัดเมื่อรับปลายทาง** ลูกค้ายืนยันว่าตั้งใจให้ต่างกัน

---

## 13. คืนสินค้า RU → RMA และยกเลิก RU

```mermaid
sequenceDiagram
    autonumber
    actor WH
    actor QAUser as QA
    participant WH13
    participant KV as kv_store
    participant V4
    participant API
    participant Bus

    WH->>WH13: แบบฟอร์มคืน · เปิดตรวจ
    WH13->>KV: whrm_rma_queue_v2 + whrm_rma_v4_request
    WH13-->>V4: RMA_WEIGH_REQUEST
    V4->>V4: ชั่งหรือนับจริง
    V4->>KV: whrm_rma_v4_result
    V4-->>WH13: RMA_WEIGH_RESULT
    WH13->>WH13: ตรวจเงื่อนไข · QA ตัดสินรายรายการ
    WH13->>KV: Stock + รายงาน RMA
    opt ยกเลิก RU
        QAUser->>WH13: ยกเลิก RMA Session
        WH13->>API: PUT /sync/kv/whrm_rma_audit_v1 (RMA_CANCELLED)
        API->>API: พบรายการใหม่ · บันทึก ru_cancel
        API->>Bus: RMA_CANCEL_RU
        alt V4 ออนไลน์
            Bus-->>V4: RMA_CANCEL_RU
        else V4 ปิดอยู่
            Bus-->>V4: ส่งซ้ำตอน V4 ต่อเข้ามา
        end
        V4->>Bus: RMA_CANCEL_RU_DONE
        Bus-->>WH13: แสดงว่า V4 ล้างแล้ว
    end
```

---

## 14. เน็ตหลุดและกลับมา

```mermaid
sequenceDiagram
    autonumber
    participant Page as หน้าจอ
    participant Bridge
    participant API
    participant Bus

    Note over Page,Bus: เน็ตหลุด
    Page->>Bridge: เขียน KV ต่อได้
    Bridge->>Bridge: จำ key ค้างส่ง · ป้าย Offline
    Page->>Bridge: งานขาย
    alt ออกเลข SBO / ใบเสนอราคา หรือ WH13 claim
        Bridge-->>Page: ไม่สำเร็จ · ไม่สร้างเอกสาร (claim ลองรอบหน้า)
    else ผลตอบกลับ หรือการบันทึกอื่น
        Bridge->>Bridge: เก็บใน __whrm_sales_outbox
    end
    Note over Page,Bus: เน็ตกลับ
    Bridge->>Bus: hello {lastSeq}
    Bus-->>Bridge: replay ข้อความที่พลาด
    Bridge->>API: PUT /sync/kv ที่ค้าง (ชนกันใช้ merge ตามข้อ 3)
    Bridge->>API: ส่ง outbox ตามลำดับ
    alt 5xx หรือเน็ตล่ม
        Bridge->>Bridge: เก็บไว้ลองใหม่
    else 4xx
        Bridge-->>Page: แจ้งเตือนแล้วทิ้งรายการ
    end
```

---

## 15. ยังไม่มีในระบบ

| เรื่อง | สถานะจริง | แผนงาน |
|---|---|---|
| `/receiving/*`, `/inventory/*`, `/requisitions`, `/approvals`, `/qa/*`, `/returns/*`, `/prp/*`, `/print/jobs`, `/doc-sequences` | ไม่มี API เหล่านี้ งานทำที่หน้าจอ + `kv_store` | ทยอยตามเฟสย้ายระบบ |
| Server คุมยอด Stock (`stock_movement`, `stock_balance`, FEFO, HOLD) | ไม่มี | เฟส 2–3 |
| ใบโอนและคิวขนส่งในตาราง | อยู่ใน `kv_store` | เฟส 1 |
| กันการลบ `kv_store` ตามสิทธิ์ | ผู้ที่ login เขียนหรือลบได้ทุก key ที่อนุญาต | ควรทำก่อนใช้จริง |
| Agent เครื่องชั่ง / เครื่องพิมพ์ฝั่ง server | ไม่มี | ยังไม่กำหนด |
| PRP และคำขอปลดล็อก | ทำงานที่หน้าจอ ไม่มี API เฉพาะ จึงไม่ได้วาดแยก | ทยอยตามเฟส |
