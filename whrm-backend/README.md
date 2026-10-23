# whrm-backend

API + WebSocket bus + PostgreSQL ของระบบ WH-RM (โรงงานหมูปิ้งแช่แข็ง)
หน้าเว็บ (V4 สถานีชั่ง / WH13 คลัง-QA) อยู่อีกโปรเจกต์: [whrm-frontend](../whrm-frontend/README.md)

> ออกแบบตาม [BACKEND-DESIGN.md](../BACKEND-DESIGN.md) · API ดู [docs/03-api.md](../docs/03-api.md) · ตาราง [docs/02-erd.md](../docs/02-erd.md)

## รันบนเครื่อง

**แบบ Docker (แนะนำ)** — จากโฟลเดอร์ `Archive/` รันทั้ง db + backend + frontend:
```bash
docker compose up -d --build
curl http://localhost:3000/api/v1/health
```

**แบบ npm (แก้โค้ด backend)** — ต้องมี Postgres อยู่แล้ว (ใช้ตัวใน compose ได้: `docker compose up -d db` เปิดที่ `localhost:5433`)
```bash
cd whrm-backend
npm install
npm run dev            # http://localhost:3000 · reload เองเมื่อแก้ไฟล์
```

| env | ค่าเริ่มต้น | ใช้ทำอะไร |
|---|---|---|
| `PORT` | `3000` | port ของ API + WebSocket |
| `DATABASE_URL` | `postgres://whrm:whrm_dev_pw@localhost:5433/whrm` | Postgres (migration รันเองตอนเริ่ม) |
| `CORS_ORIGINS` | `http://localhost:8080,http://127.0.0.1:8080` | origin ที่ browser เรียก API ตรงได้ (คั่นด้วย `,`) · ใช้ `*` ในชื่อ host ได้ เช่น `https://whrm-*.vercel.app` · `*` ตัวเดียว = ทุก origin (dev เท่านั้น) · เรียกผ่าน proxy ของ frontend ไม่ต้องตั้ง |
| `TRUST_PROXY` | เปิด | อ่าน IP / https จาก `X-Forwarded-*` (อยู่หลัง Railway / nginx) · ตั้ง `0` ถ้าเปิด port ตรงสู่ internet |
| `LOG_LEVEL` | `info` | ระดับ log |
| `WHRM_ADMIN_USER` / `WHRM_ADMIN_PASSWORD` | `admin` / — | ผู้ดูแลคนแรก สร้างเมื่อยังไม่มี ADMIN · production ต้องตั้งรหัส (dev ใช้ `admin1234` ถ้าไม่ตั้ง) |
| `SESSION_TTL_HOURS` | `12` | อายุ session (ต่ออายุเองเมื่อใช้งานอยู่) |

## Login
- ทุก `/api/v1/*` และ WebSocket `/bus` **ต้อง login** ยกเว้น `GET /api/v1/health` และ `POST /api/v1/auth/login`
- **โดเมนเดียวกับหน้าเว็บ** (docker / proxy): cookie `whrm_session` (HttpOnly, SameSite=Lax)
- **คนละโดเมน** (Vercel + Railway): `POST /auth/login` ส่ง `returnToken: true` → ใช้ `Authorization: Bearer <token>` · WebSocket ใช้ `/bus?token=<token>` — frontend เลือกโหมดเองตาม `API_BASE`
- รหัสผ่านเก็บแบบ scrypt · session เก็บเฉพาะ hash · ใส่ผิด 5 ครั้ง → ล็อก 5 นาที · ปิดบัญชี/รีเซ็ตรหัส → session เดิมหลุดทันที
- role: `ADMIN`, `WH_SUPERVISOR`, `WH_STAFF`, `QA`, `WEIGH_OPERATOR`, `PRODUCTION` — ตอนนี้แยกสิทธิ์เฉพาะจัดการผู้ใช้ (ADMIN) ที่เหลือ login แล้วใช้ได้ทุกหน้า (แยกสิทธิ์ราย action ใน Phase B)
- login เดิมที่อยู่ในแอป (เปิดใช้งานการชั่งของ V4 / login ของ WH13) ยังทำงานเหมือนเดิม

| | |
|---|---|
| `POST /api/v1/auth/login` · `/logout` · `GET /auth/me` | เข้า / ออก / ผู้ใช้ปัจจุบัน |
| `POST /api/v1/auth/password` | เปลี่ยนรหัสตัวเอง |
| `GET/POST /api/v1/auth/users` | จัดการผู้ใช้แบบเดิม (ADMIN) |
| `/api/v1/users*`, `/api/v1/role-templates*` | จัดการผู้ใช้รายส่วน: CRUD · สิทธิ์ต่อส่วน · template · import/export CSV · ประวัติ (ADMIN) — [docs/08](../docs/08-user-management.md) |

## Endpoint หลัก
| | |
|---|---|
| `GET /` | ชื่อ + เวอร์ชัน |
| `GET /api/v1/health` · `/status` | สถานะ DB / bus / เครื่องที่ต่ออยู่ |
| `GET /api/v1/sync/snapshot` · `PUT /api/v1/sync/kv/:key` | sync ค่า `whrm_*` + master ของ DBV2.0 (`pmp_master_v66` ฯลฯ) ของหน้าเว็บ (optimistic lock ด้วย version) · กู้ค่าเก่า: `POST /sync/kv/:key/restore` |
| `WS /bus` | relay BroadcastChannel `whrm-bus` ข้ามเครื่อง + replay เมื่อ reconnect |
| `POST /api/v1/weighing/*`, `/wms/send`, `/audit/override`, `/users/save` | endpoint ที่ V4 `apiCall()` เรียก |
| `GET /api/v1/weighing/reports`, `/bus/messages`, `/audit`, `/ru-cancels` | ดูข้อมูล |
| `GET /api/v1/fgt?status=`, `/fga/reports` | คิว FGT / รายงาน FGA จาก WH13 + เลขเอกสารที่ออกซ้ำ (`duplicates`) |

## โครงสร้าง
```
src/
  server.js          Fastify + CORS + WebSocket
  db.js              pool + migration runner
  bus.js             WebSocket hub (relay, replay, ส่งงานยกเลิก RU ค้างให้ V4)
  weighing.js        ข้อมูลชั่ง V4 → DB · แปลง BBF/EXP (พ.ศ.) · PRP
  rucancel.js        ยกเลิก RU: audit RMA_CANCELLED → RMA_CANCEL_RU → รอ DONE
  auth.js            login / session / บังคับเปลี่ยนรหัส / ล็อก
  routes/users.js    จัดการผู้ใช้รายส่วน (CRUD · template · CSV · ประวัติ)
  routes/sync.js     KV sync + history + restore
  routes/v4.js       endpoint ของ V4
  routes/query.js    health / status / รายงาน
  migrations/*.sql   001 init · 002 BBF/PRP/ยกเลิก RU · 003 auth · 004 สิทธิ์รายส่วน
test/e2e.mjs         E2E 102 ข้อ (login + เปิด browser จำลองหลายเครื่อง + FGT, BD02, ฝ่ายผลิต)
```

## ทดสอบ
```bash
npm run test:e2e       # ต้องเปิด docker compose ไว้ · FRONT / API / E2E_USER / E2E_PASS เปลี่ยนได้ด้วย env
```
> **อย่ารัน E2E กับระบบที่มีคนเปิดใช้อยู่** — test ส่งข้อความ (เช่น ยกเลิก RU) ไปทุกหน้าจอที่ต่ออยู่ และเขียนข้อมูลทดสอบลง DB
> รันแยก: สร้าง DB `whrm_e2e` แล้วเปิด backend อีกตัว `PORT=3100 DATABASE_URL=…/whrm_e2e CORS_ORIGINS=http://localhost:8181 node src/server.js`
> + frontend `API_BASE=http://127.0.0.1:3100 npm run build && PORT=8181 npm run serve` → `FRONT=http://localhost:8181 API=http://127.0.0.1:3100 npm run test:e2e` (ทดสอบโหมดคนละโดเมนแบบ Vercel + Railway ไปด้วย)
```bash
```

## Deploy ขึ้น Railway
ดู [docs/05-deploy-railway-vercel.md](../docs/05-deploy-railway-vercel.md) — สรุป: Root Directory = `whrm-backend` (อ่าน `railway.json` + `Dockerfile`) · เพิ่ม PostgreSQL · ตั้ง `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`, `WHRM_ADMIN_PASSWORD`, `CORS_ORIGINS=https://<project>.vercel.app,https://<project>-*.vercel.app`

## Backup / restore
```bash
docker exec whrm-db-1 pg_dump -U whrm -Fc whrm > whrm-$(date +%Y%m%d).dump
docker exec -i whrm-db-1 pg_restore -U whrm -d whrm --clean < whrm-20261003.dump
```

## ข้อจำกัด (Phase A)
- login แล้วใช้ได้ทุกหน้า — สิทธิ์ราย action (เช่น ปลด HOLD = QA เท่านั้น) มาพร้อมกฎธุรกิจใน Phase B
- ขึ้น cloud ต้องใช้ HTTPS (cookie ตั้ง `Secure` เองเมื่อมาทาง https)
- bus เก็บ connection ในหน่วยความจำ → รัน **1 instance**
- กฎธุรกิจ (ยอดราย Lot, HOLD, FEFO) ยังอยู่ในหน้าเว็บ — Phase B ย้ายมาที่นี่
