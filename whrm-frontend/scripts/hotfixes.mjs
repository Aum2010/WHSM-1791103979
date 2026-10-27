// Hotfix ของหน้าเว็บลูกค้า — 2 ชนิด
//   security : ลบรหัสผ่านจริงของพนักงานที่ฝังในโค้ด (WHAUTH / BD02) → ใช้ทั้งตอนนำไฟล์เข้า ui/ (scripts/import-ui.mjs) และตอน build
//              ไฟล์ใน ui/ (ขึ้น git) และ dist/ (ขึ้น Vercel) จึงไม่มีรหัสจริง · login ไปตรวจที่ server แทน (bridge)
//   fix      : แก้ bug ของหน้าเว็บชั่วคราวตอน build (ไม่แตะ ui/)
// แต่ละข้อหาข้อความที่ระบุ ถ้าไม่เจอ (ลูกค้าแก้แล้ว / เปลี่ยนโค้ด) → ข้ามพร้อมเตือน · เมื่อทีม UI แก้ต้นทางแล้ว ลบรายการออก
// หลังแก้แล้ว assertNoSecrets() ตรวจซ้ำ — ยังเหลือรหัส → build / import ล้มทันที (กันหลุดขึ้น git / Vercel)
export const HOTFIXES = [
  {
    id: 'SEC-WHAUTH-PINS',
    kind: 'security',
    files: ['WH13.html', 'V4.html'],
    since: '2026-10-26',
    why: 'WHAUTH ฝังรหัสบัตร + PIN จริงของพนักงานทั้งโรงงาน (Authorized list) ในตัวแปร RAW → ลบ PIN ออก (เหลือ "") · login ตรวจที่ server',
    find: /var RAW = \[[\s\S]*?\];/g,
    replace: (block) => block.replace(/\[("[^"\\]*"),\s*"[^"\\]*"/g, '[$1,""'),
  },
  {
    id: 'SEC-WH13-DCSUP-PIN',
    kind: 'security',
    files: ['WH13.html'],
    since: '2026-10-26',
    why: 'บัญชีเปิดใบโอนที่ล็อก (DC_SUP WH002) ฝัง PIN จริง → ลบรหัส + ตัวตรวจ (checkSup) ไปตรวจที่ server',
    find: /(var DC_SUP = \{ 'WH\d+': \{ password: )'[^']*'/g,
    replace: "$1''",
  },
  {
    id: 'WH13-DCSUP-LOGIN-SERVER',
    kind: 'security',
    files: ['WH13.html'],
    since: '2026-10-26',
    why: 'คู่กับ SEC-WH13-DCSUP-PIN',
    find: /var s = DC_SUP\[u\]; if \(s && String\(s\.password\) === p\)/g,
    replace: "var s = DC_SUP[u]; if (s && (window.__whrmCredOk ? window.__whrmCredOk(u, p, 'WH13') : String(s.password) === p))",
  },
  {
    id: 'SEC-BD02-PINS',
    kind: 'security',
    files: ['BD02.html'],
    since: '2026-10-26',
    why: 'BD02 ฝังรหัสจริงของฝ่ายขาย (BD001–BD003) ใน USERS 7 ชุด → ลบรหัสออก',
    find: /('BD\d+'\s*:\s*\{\s*password\s*:\s*)'[^']*'/g,
    replace: "$1''",
  },
  {
    id: 'SEC-PIN-HINTS',
    kind: 'security',
    files: ['BD02.html', 'WH13.html', 'V4.html'],
    since: '2026-10-26',
    why: 'ข้อความช่วยจำ / log บอก PIN จริง (รายชื่อ "รหัสบัตร/PIN" ใน console.log และคำอธิบายของ DC-supervisor) → แทนด้วย ••••',
    find: /\b((?:BD|WH|DC)\d{3})(\s*\/\s*)\d{4,8}\b/g,
    replace: '$1$2••••',
  },
  {
    id: 'BD02-LOGIN-SERVER',
    kind: 'security',
    files: ['BD02.html'],
    since: '2026-10-26',
    why: 'รหัสใน BD02 ถูกลบแล้ว → ตัวตรวจ login ทุกชุด (user.password !== p) ส่งไปตรวจที่ server ผ่าน bridge (window.__whrmCredOk)',
    find: /user\.password !== p\b/g,
    replace: "!(window.__whrmCredOk ? window.__whrmCredOk(u, p, 'BD02') : user.password === p)",
  },
  {
    id: 'SEC-WH13-DEMO-8888',
    kind: 'security',
    files: ['WH13.html'],
    since: '2026-10-26',
    why: 'บัญชีสาธิต Tom/8888 (Info Center DEV_PASS + โค้ดกู้บัญชี Tom) — Tom = สิทธิ์สูงสุดในหน้าจอ · รหัสที่ใครก็รู้ → ลบ (ผู้ดูแลใช้บัญชีตัวเองผ่าน server)',
    find: /((?:DEV_PASS|password)\s*:\s*)'8888'/g,
    replace: "$1''",
  },
  {
    id: 'WH13-IC-LOGIN-SERVER',
    kind: 'security',
    files: ['WH13.html'],
    since: '2026-10-26',
    why: 'Info Center / Dev Gate (__icDevOn, __wh13DevOn, หน้าต่าง Developer Login) เทียบกับ Tom/8888 → ตรวจที่ server เฉพาะผู้มีสิทธิ์ WH13 ระดับผู้ดูแล',
    find: /if \(String\(u\) ?!== ?CFG\.DEV_USER \|\| String\(p\) ?!== ?CFG\.DEV_PASS\)/g,
    replace: "if (!(window.__whrmCredOk ? window.__whrmCredOk(u, p, 'WH13', 'ADMIN') : (!!CFG.DEV_PASS && String(u) === CFG.DEV_USER && String(p) === CFG.DEV_PASS)))",
  },
  {
    id: 'WH13-IC-FIX-LOGIN-SERVER',
    kind: 'security',
    files: ['WH13.html'],
    since: '2026-10-26',
    why: 'คู่กับ WH13-IC-LOGIN-SERVER — หน้าต่าง icLoginModalFix ตกไปใช้ 8888 เมื่อ DEV_PASS ว่าง',
    find: /if \(user !== \(CFG\.DEV_USER\|\|'Tom'\) \|\| pass !== \(CFG\.DEV_PASS\|\|'8888'\)\)\{/g,
    replace: "if (!(window.__whrmCredOk && window.__whrmCredOk(user, pass, 'WH13', 'ADMIN'))){",
  },
  {
    id: 'SEC-DBV2-LOGIN',
    kind: 'security',
    files: ['DBV2.0.html'],
    since: '2026-10-26',
    why: 'Login สำหรับ Edit / Delete สเปก: รหัส qa_manager/123456 ฝังในโค้ด + กรอกไว้ให้ในช่อง → ลบค่าที่กรอกไว้',
    find: /(<input type="(?:text|password)" id="login(?:User|Pass)") value="[^"]+"/g,
    replace: '$1 value="" placeholder="ชื่อผู้ใช้ / รหัสผ่านของผู้ดูแล" autocomplete="off"',
  },
  {
    id: 'DBV2-LOGIN-SERVER',
    kind: 'security',
    files: ['DBV2.0.html'],
    since: '2026-10-26',
    why: 'คู่กับ SEC-DBV2-LOGIN — แก้ / ลบสเปกได้เฉพาะผู้มีสิทธิ์ DBV2 ระดับผู้ดูแล (ตรวจที่ server) · ล้างช่องรหัสทุกครั้ง (หน้าต่างไม่ล้างเอง — คนถัดไปจะเห็นรหัสค้าง)',
    find: /if \(u !== 'qa_manager' \|\| p !== '123456'\)/g,
    replace: "if ((document.getElementById('loginPass').value = '', !(window.__whrmCredOk && window.__whrmCredOk(String(u).trim(), p, 'DBV2', 'ADMIN'))))",
  },
  {
    id: 'WH13-RETURN-DUP-SEARCH',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-10-24',
    why: 'แท็บ "2. คืน" มีปุ่ม "ค้นหาใน DB" 2 ปุ่ม (ReturnFlow retQuickSearch + SearchDB v1) · patch Fix-v14c ของลูกค้าลบด้วย rAF watchdog ' +
      'แต่ถูก patch "RAF HARD KILL" / "FGA-Final-Kill" หยุด → ปุ่มซ้ำค้าง · แก้: ซ่อนปุ่ม retQuickSearch ด้วย CSS (คง SearchDB v1 ตามที่ Fix-v14c ตั้งใจ)',
    find: /<\/head>/i,
    replace: '<style data-whrm-hotfix="WH13-RETURN-DUP-SEARCH">#reqPanel-return button[onclick^="retQuickSearch"]{display:none!important}</style></head>',
  },
  // เอาออกแล้ว (ลูกค้าแก้ใน WH13 26 ต.ค.): WH13-FGT-SUBMIT-STUB (ปุ่มยืนยัน FGT) · WH13-REQ-PANEL-WIDTH (แท็บเบิก/คืนเบียด)
]

// รหัสจริงที่ยังเหลือ = build / import ล้ม
const SECRET_PATTERNS = [
  { re: /var RAW = \[[^;]*?\["[^"]*",\s*"[^"]+"/, what: 'WHAUTH RAW มี PIN' },
  { re: /'BD\d+'\s*:\s*\{\s*password\s*:\s*'[^']+'/, what: 'BD02 USERS มีรหัส' },
  { re: /var DC_SUP = \{[^}]*password: '[^']+'/, what: 'DC_SUP มี PIN' },
  { re: /DEV_PASS\s*:\s*'[^']+'|password\s*:\s*'8888'/, what: 'รหัส Tom/8888 (Info Center)' },
  { re: /id="loginPass" value="[^"]+"|p !== '123456'/, what: 'DBV2 รหัส qa_manager' },
]
export function assertNoSecrets(file, html) {
  for (const p of SECRET_PATTERNS) if (p.re.test(html)) throw new Error(`[security] ${file}: ${p.what} — ห้าม build / commit (เพิ่ม hotfix ใน scripts/hotfixes.mjs)`)
}

export function applyHotfixes(file, html, { only } = {}) {
  let out = html
  for (const h of HOTFIXES) {
    if (!h.files.includes(file) || (only && h.kind !== only)) continue
    h.find.lastIndex = 0
    const next = out.replace(h.find, h.replace)
    if (next !== out) { out = next; console.log(`hotfix ${h.id} → ${file}`) }
    else if (h.kind === 'fix') console.warn(`hotfix ${h.id}: ไม่พบโค้ดที่ต้องแก้ใน ${file} (ลูกค้าอาจแก้แล้ว) — ข้าม`)
    // security ที่ไม่เปลี่ยนอะไร = ไฟล์ใน ui/ ลบรหัสแล้ว (import-ui.mjs) — ปกติ
  }
  assertNoSecrets(file, out)
  return out
}
