# whrm-frontend

หน้าเว็บของระบบ WH-RM: **WH13** (คลัง / QA / FGT-FGA), **V4** (สถานีชั่ง), **BD02** (ฝ่ายขาย) และ **ฝ่ายผลิต** 3 หน้า จากทีม UI ของลูกค้า + `whrm-bridge.js` ที่ต่อหน้าเว็บเข้ากับ [whrm-backend](../whrm-backend/README.md)
**ไม่แก้ไฟล์ของลูกค้า** — ตอน build แทรก `config.js` + `whrm-bridge.js` ไว้ต้น `<head>` ให้เอง

## รันบนเครื่อง

**แบบ Docker (แนะนำ)** — จากโฟลเดอร์ `Archive/`:
```bash
docker compose up -d --build
# เปิด http://localhost:8080 (เครื่องอื่นใน LAN: http://<IP>:8080)
```

**แบบ npm** — ต้องมี backend รันอยู่ (`http://localhost:3000`):
```bash
cd whrm-frontend
npm start              # build → dist/ แล้วเปิด http://localhost:8080
```

## Login
- เปิดหน้าไหนก็ตาม ถ้ายังไม่ login จะไปที่ `/login.html` แล้วพากลับหน้าเดิมหลัง login
- ผู้ดูแลคนแรก: `admin` / `admin1234` (ตั้งใน docker-compose) — **เปลี่ยนรหัสที่หน้ารวมทันที**
- หน้ารวม (`/`): แสดงผู้ใช้, ออกจากระบบ, เปลี่ยนรหัสผ่าน · ADMIN เพิ่ม/แก้/ปิดผู้ใช้ และรีเซ็ตรหัสได้
- ป้ายสถานะมุมขวาล่างแสดงชื่อผู้ใช้ที่ login อยู่ (แท็บเล็ตใช้ร่วมกันจะรู้ว่าเป็นบัญชีใคร)

## ต่อกับ backend อย่างไร

```
browser ──► frontend :8080 ──┬─ /V4.html, /WH13.html, /whrm-bridge.js   (static)
                             └─ /api/*, /bus (WebSocket) ──► backend :3000   (proxy)
```

| โหมด | ตั้งค่า | เมื่อไหร่ใช้ |
|---|---|---|
| **ผ่าน proxy** (ค่าเริ่มต้น) | `API_BASE` ว่าง · `BACKEND_ORIGIN=http://backend:3000` (Docker) หรือ `http://localhost:3000` (npm) | ปกติ — URL เดียว ไม่ต้องตั้ง CORS · backend ล่มหน้าเว็บก็ยังเปิดได้ (timeout 2 วิ) |
| เรียก backend ตรง (คนละโดเมน) | `API_BASE=https://<backend>` + backend ตั้ง `CORS_ORIGINS` | **Vercel** หรือ static host ที่ทำ proxy ไม่ได้ · login ใช้ **Bearer token** (`localStorage['__whrm_auth_token']`) แทน cookie · WebSocket ใช้ `?token=` · ข้อควรระวัง: ถ้า backend ค้าง (ไม่ตอบ) หน้าเว็บจะรอตอนโหลด |

`config.js` (สร้างตอน build / container เริ่ม):
```js
window.WHRM_CONFIG = { "apiBase": "" }   // ว่าง = same origin → proxy
```

## Deploy ขึ้น Vercel
ดู [docs/05-deploy-railway-vercel.md](../docs/05-deploy-railway-vercel.md) — สรุป: Root Directory = `whrm-frontend` · Framework = Other (ค่า build อ่านจาก `vercel.json`) · ตั้ง `API_BASE=https://<backend>.up.railway.app` (ไม่ตั้ง → build fail ตั้งใจ)

## ลูกค้าส่งหน้าเว็บเวอร์ชันใหม่
1. วางไฟล์ใหม่ทับใน `ui/` ตามโครงเดิมของลูกค้า (โฟลเดอร์ย่อย / ไฟล์ `.js` ได้ · ไม่ต้องใส่ `index.html` ของลูกค้า) — เก็บต้นฉบับที่ได้รับไว้ใน `Archive/<เลขโฟลเดอร์>/` ด้วย
   - ชื่อที่มีเว้นวรรคกลายเป็น `-` ใน URL เช่น `ui/Production module/Preparing.html` → `/Production-module/Preparing.html`
   - หน้ารวมสร้างลิงก์จาก `pages.json` ให้เอง (ตั้งชื่อ/คำอธิบายสวย ๆ ได้ที่ `DESC` ใน `src/index.html`)
2. `docker compose up -d --build frontend`
3. รัน E2E ที่ whrm-backend: `npm run test:e2e` ตรวจว่าไม่มีอะไรพัง
4. เทียบการเปลี่ยนแปลงตามแนว [docs/04-ui-v2-change-review.md](../docs/04-ui-v2-change-review.md)

## โครงสร้าง
```
ui/                    หน้าเว็บของลูกค้า (ต้นฉบับ): WH13, V4, BD02, Production module/, library .js
src/whrm-bridge.js     hook localStorage + BroadcastChannel → backend (sync, bus, merge, offline)
src/whrm-demo-bot.js   ปุ่ม 🤖 Demo Bot ใน V4 — กรอกเที่ยวรถ / เลือกสินค้า / ชั่ง / บันทึกแทนคน (แทรกเฉพาะ V4 · เปิดด้วย DEMO_BOT=1)
src/index.html         หน้ารวม: ลิงก์ V4/WH13 + สถานะ + ผู้ใช้ / จัดการผู้ใช้
src/login.html         หน้าเข้าสู่ระบบ
src/users.html         จัดการผู้ใช้และสิทธิ์รายส่วน (/users.html — ADMIN)
src/guide.html         คู่มือเริ่มต้นใช้งาน (/guide.html — ลิงก์จากหน้ารวม) · แก้เมื่อหน้าจอของลูกค้าเปลี่ยนเมนู/ปุ่ม
scripts/hotfixes.mjs   แก้ bug ในหน้าเว็บของลูกค้าชั่วคราวตอน build (ไม่แตะ ui/ · ไม่เจอโค้ดเป้าหมาย = ข้าม) — ลบรายการเมื่อทีม UI แก้แล้ว
scripts/build.mjs      ui/ + src/ → dist/ (แทรก bridge · dist/raw/ = ไฟล์เดิมไว้เทียบ)
scripts/serve.mjs      server สำหรับ npm (static + proxy /api, /bus)
nginx/                 config nginx สำหรับ Docker (static + proxy)
docker-entrypoint.d/   เขียน config.js จาก env ตอน container เริ่ม
```

## หน้าที่ของ bridge (สรุป)
- โหลดข้อมูลกลางจาก backend ลง localStorage **ก่อน** แอปเริ่ม · backend ล่ม → ใช้ข้อมูลในเครื่อง แล้ว sync เมื่อต่อได้
- `localStorage.setItem('whrm_*')` → ส่งขึ้น backend · ชนกัน → merge 3 ทาง
- `BroadcastChannel('whrm-bus')` → ส่งข้ามเครื่องผ่าน WebSocket · พักข้อความจนแอปโหลดเสร็จ
- timer ทำงานใน Web Worker (WH13 ล้าง timer ทั้งหน้า) · WebSocket ค้างเกิน 8 วิ → ตัดแล้วต่อใหม่
- เลขลำดับเอกสาร (FGT / IO / TRF / PL / TXN) ชนกัน → ใช้ค่ามากสุด · รายการที่มีเลขเอกสาร (`fgtNo`, `plRef` …) รวมตามเลขนั้น
- ค่าเฉพาะเครื่อง (login ในแอป, ค่า dev, ร่างเอกสารแนบ, ค่าหน้าจอ) ไม่ sync — รายการอยู่ที่ `LOCAL_KEYS`
- **กันส่ง/รับรายการชั่งซ้ำ:** V4 ไม่ส่งใบที่ส่งไป WH13 แล้ว (`v4AllowResend` เปิดได้) · WH13 จำรายการที่เคยรับใน `whrm_trip_received_v1` (sync ทุกเครื่อง) — ใบเดิมส่งมาซ้ำ รายการที่รับแล้วไม่กลับเข้า Auto Weighing
- **login ในหน้าจอ WH13 ด้วยบัญชีของตัวเอง:** ดักทุกปุ่มยืนยันในหน้าต่างที่มีช่องรหัส (คลิกหรือ Enter) → ตรวจที่ `POST /auth/verify` → ทำงานในนาม Tom / QA-001 / WH-002 · หน้าจอแสดงเป็น "ผู้ดูแล / QA / พนักงานคลัง" (`relabelAliases`) · หน้าที่ไม่มีสิทธิ์ = 🔒
- master สินค้าของ DBV2.0 (`pmp_master_v66` ฯลฯ — รายการ `SHARED_KEYS`) sync ทุกเครื่อง · ลบ/Hard Reset มีผลเฉพาะเครื่องนั้น
- V4 ส่งรายการชั่งไป WH13 เมื่อกด **นำส่ง WMS** เท่านั้น (กดบันทึกยังไม่ส่ง — ลูกค้ายืนยัน) · กลับแบบเดิม: `WHRM_CONFIG.v4SendOnSave = true`
- BD02 / ฝ่ายผลิต ใช้ key ที่ไม่ขึ้นต้น `whrm_` (`pmp.*`, `wh13_prepare_*`) → ยังทำงานเฉพาะ browser เดียวกัน (รอยืนยันกับลูกค้า)
- ป้ายสถานะมุมขวาล่าง: `● Server` / `รอส่ง n` / `○ Offline` / `⚠ พื้นที่เครื่องใกล้เต็ม` · ดูละเอียดใน console: `__whrmBridge.state()`

## Demo Bot (V4)
ปุ่ม 🤖 มุมซ้ายล่างของ V4: เลือกประเภท (รับ / PRP) + จำนวนรายการ → **ชั่ง + บันทึก** (ส่งเข้า WH13 เลย) หรือ **ชั่งเข้าตะกร้า** (ให้คนกดบันทึกเอง)
บอทใช้ฟังก์ชันเดิมของ V4 ทั้งหมด (ยืนยันตัวตน operator_01, เชื่อมต่อ, หักภาชนะ, Simulator, ชั่ง Manual) — ผลเหมือนพนักงานทำเอง
- docker compose: เปิดเป็นค่าเริ่มต้น (`DEMO_BOT: ${WHRM_DEMO_BOT:-1}`) · ปิดด้วย `WHRM_DEMO_BOT=0`
- Vercel / build เอง: ตั้ง `DEMO_BOT=1` ถ้าต้องการ (ค่าเริ่มต้นปิด) — **ไม่ควรเปิดบนระบบที่ใช้งานจริง**
