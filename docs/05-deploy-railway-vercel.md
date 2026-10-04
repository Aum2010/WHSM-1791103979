# 05 — Deploy: backend → Railway · frontend → Vercel

> แบบ **B (ยังไม่มีโดเมน)**: ใช้โดเมนฟรีของทั้งสองที่ (`*.up.railway.app`, `*.vercel.app`)
> หน้าเว็บกับ backend อยู่คนละโดเมน → login ใช้ **Bearer token** (cookie ข้ามโดเมนถูก browser บล็อก) · WebSocket ต่อตรงไป Railway
> ทดสอบแล้วในเครื่อง: โหมดข้ามโดเมน E2E 43/43 · โหมด proxy (docker เดิม) 42/42

```
browser ──► https://whrm.vercel.app          (V4 / WH13 / login — static)
   │
   ├─ REST  https://whrm-api.up.railway.app/api/v1/*   Authorization: Bearer <token>
   └─ WS    wss://whrm-api.up.railway.app/bus?token=…
                         │
                  Railway Postgres (private network)
```

## 0. เตรียม repo (ครั้งเดียว)

แนะนำ **repo เดียว** (monorepo) จากโฟลเดอร์ `Implement/Archive`:
```bash
cd Implement/Archive
git init
git add .            # .gitignore กัน node_modules / dist / .env / zip ไว้แล้ว
git commit -m "WH-RM: backend + frontend"
git branch -M main
git remote add origin https://github.com/<account>/whrm.git
git push -u origin main
```
- Railway ใช้โฟลเดอร์ `whrm-backend` · Vercel ใช้โฟลเดอร์ `whrm-frontend` (ตั้ง Root Directory ด้านล่าง)
- push `main` ครั้งต่อไป → ทั้งสองที่ deploy ใหม่เอง

## 1. Backend → Railway

1. railway.com → **New Project** → **Deploy from GitHub repo** → เลือก repo
2. Service ที่ได้ → **Settings**
   - **Root Directory** = `whrm-backend` (Railway อ่าน `railway.json` + `Dockerfile` ในนั้นเอง: health check `/api/v1/health`, 1 replica, restart เมื่อพัง)
   - **Region** = Southeast Asia (Singapore) — ใกล้โรงงานที่สุด
   - **Networking → Generate Domain** → ได้ `https://<ชื่อ>.up.railway.app` (จดไว้ใช้ขั้น 2)
3. ในโปรเจกต์เดียวกัน **+ New → Database → PostgreSQL**
4. Service backend → **Variables**:

   | ชื่อ | ค่า | หมายเหตุ |
   |---|---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | พิมพ์ตามนี้ Railway แทนค่าให้ (ต่อผ่าน private network ไม่ต้อง SSL) |
   | `NODE_ENV` | `production` | |
   | `WHRM_ADMIN_USER` | `admin` | |
   | `WHRM_ADMIN_PASSWORD` | รหัสแข็ง ๆ (12 ตัวขึ้นไป) | **ไม่ตั้ง = server ไม่ยอมเริ่ม** (กันใช้รหัสเริ่มต้นบน internet) |
   | `CORS_ORIGINS` | `https://<project>.vercel.app,https://<project>-*.vercel.app` | ตัวหลัง = preview ของ Vercel (ใส่หลังได้ URL จากขั้น 2) |
   | `SESSION_TTL_HOURS` | `12` | |

   ไม่ต้องตั้ง `PORT` (Railway ใส่ให้) · `TRUST_PROXY` เปิดอยู่แล้วโดยค่าเริ่มต้น
5. Deploy → ดู log ต้องเห็น `migration applied` (ครั้งแรก), `seeded first admin user`, `Server listening`
6. ทดสอบ: เปิด `https://<backend>.up.railway.app/api/v1/health` ต้องได้ `{"ok":true,...}`

## 2. Frontend → Vercel

1. vercel.com → **Add New → Project** → import repo เดียวกัน
2. **Root Directory** = `whrm-frontend` · Framework Preset = **Other** (ค่า build อ่านจาก `vercel.json`: `npm run build` → `dist`)
3. **Environment Variables**:

   | ชื่อ | ค่า |
   |---|---|
   | `API_BASE` | `https://<backend>.up.railway.app` (**ไม่มี / ท้าย**) |

   ลืมตั้ง → build จะ fail พร้อมข้อความบอก (กัน deploy หน้าเว็บที่ต่อ backend ไม่ได้)
4. Deploy → ได้ `https://<project>.vercel.app`
5. กลับไป Railway ใส่ URL นี้ใน `CORS_ORIGINS` (ขั้น 1.4) → backend redeploy เอง
6. เปิด `https://<project>.vercel.app` → login ด้วย admin → **เปลี่ยนรหัสผ่าน** → เพิ่มผู้ใช้ให้ทีม

> `API_BASE` ถูกฝังตอน build — เปลี่ยน URL backend ต้อง **Redeploy** ที่ Vercel

## 3. ตรวจหลัง deploy

| ตรวจ | วิธี | ต้องได้ |
|---|---|---|
| backend | `GET /api/v1/health` | `ok: true` |
| login | เปิดหน้าเว็บ → ไปหน้า login → เข้าได้ | กลับมาหน้ารวม เห็นชื่อผู้ใช้ |
| WebSocket | เปิด V4 → ป้ายมุมขวาล่าง | `● Server · <ชื่อผู้ใช้>` (เขียว) |
| ข้ามเครื่อง | เปิด V4 กับ WH13 คนละเครื่อง → ชั่ง + บันทึก | WH13 เห็นใน Auto Weighing |
| E2E (จากเครื่อง dev) | `cd whrm-backend && FRONT=https://<fe> API=https://<be> E2E_PASS=<รหัส admin> npm run test:e2e` | ผ่านทั้งหมด — **รันกับ production จะเขียนข้อมูลทดสอบลง DB จริง** ใช้กับ preview / staging ดีกว่า |

## 4. Deploy ครั้งต่อไป

```bash
git add . && git commit -m "…" && git push      # Railway + Vercel deploy เอง
```
- ลูกค้าส่ง V4/WH13 ใหม่ → วางทับใน `whrm-frontend/ui/` → รัน E2E ในเครื่อง → push
- migration ใหม่ (`whrm-backend/src/migrations/00N_*.sql`) รันเองตอน backend เริ่ม
- PR บน GitHub → Vercel สร้าง preview URL ให้ (CORS รับ `*-*.vercel.app` ไว้แล้ว)

## 5. ย้ายข้อมูลจากเครื่อง (ถ้าต้องการ)

```bash
# ในเครื่อง
docker exec whrm-db-1 pg_dump -U whrm -Fc whrm > whrm.dump
# Railway: Postgres → Connect → คัดลอก "Public Network" URL (ต้อง SSL)
pg_restore --no-owner --clean -d "postgresql://...railway...?sslmode=require" whrm.dump
```
ข้อมูลจากการทดสอบในเครื่องปนอยู่ — เริ่ม production จาก DB ว่างดีกว่า

## 6. ข้อควรรู้

| เรื่อง | รายละเอียด |
|---|---|
| **เน็ตโรงงานล่ม** | เปิดหน้าเว็บใหม่ไม่ได้ (หน้าเว็บอยู่บน Vercel) · หน้าที่เปิดค้างไว้ใช้ต่อได้และ sync เมื่อเน็ตกลับ — ถ้าต้องทำงานตอนเน็ตล่มจริง (REQ-U-003) ใช้ Linux server ในโรงงาน |
| token เก็บใน browser | `localStorage['__whrm_auth_token']` — JS อ่านได้ (ต่างจาก cookie HttpOnly) · อายุ 12 ชม. ต่อเองเมื่อใช้งาน · ออกจากระบบ / ปิดบัญชี / รีเซ็ตรหัส = token ใช้ไม่ได้ทันที · เมื่อมีโดเมนของบริษัท ย้ายไปแบบ A (cookie) ได้โดยไม่แก้ UI |
| WebSocket ส่ง token ใน URL | อาจไปอยู่ใน log ของ proxy — Railway ไม่เก็บ query string ใน log สาธารณะ · token หมดอายุ/ยกเลิกได้จาก server |
| 1 replica เท่านั้น | bus เก็บ connection ในหน่วยความจำ (`railway.json` ล็อกไว้) |
| ค่าใช้จ่าย | Vercel Hobby ฟรี (ห้ามใช้เชิงพาณิชย์ — งานลูกค้าควรเป็น Pro) · Railway คิดตามการใช้งาน (backend เล็ก + Postgres ≈ $5–10/เดือน) |
| ข้อมูลอยู่ต่างประเทศ | Railway Singapore — ถามลูกค้าว่ารับได้ไหม |

## 7. ตั้งค่ากลับมาใช้ในเครื่อง (docker เดิม) ได้ตลอด

`docker compose up -d --build` ที่ `Implement/Archive` ยังทำงานเหมือนเดิม (โหมด proxy + cookie) — โค้ดชุดเดียวกันเลือกโหมดเองตาม `API_BASE`
