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
  {
    id: 'LG02-REJECTED-NO-LOAD-QUEUE',
    kind: 'fix',
    files: ['LG02.html'],
    since: '2026-10-31',
    why: 'ปฏิเสธงานเปลี่ยนสถานะเฉพาะคิว Logistic แต่คิวโหลดอ่านจากใบโอน → ใบที่ปฏิเสธยังขึ้นให้โหลด · ไม่แสดงใบที่คิวเป็น REJECTED',
    find: /(function eligibleToLoad\(\) \{\s*return getDocs\(\)\.filter\(function \(d\) \{ return isLogistic\(d\) && !d\.departedAt && )/,
    replace: "$1!(function (q) { return q && (q.status === 'REJECTED' || (q.lg && q.lg.status === 'Rejected')); })(findQueue(d)) && ",
  },
  {
    id: 'LG02-REJECTED-NO-LOAD-CONFIRM',
    kind: 'fix',
    files: ['LG02.html'],
    since: '2026-10-31',
    why: 'คู่กับ LG02-REJECTED-NO-LOAD-QUEUE — เครื่องที่เปิดหน้าโหลดค้างไว้ก่อนอีกเครื่องปฏิเสธ กดยืนยันแล้วจะตัด Stock → ตรวจซ้ำตอนกดยืนยัน',
    find: /(function confirmLoadAndDepart\(\) \{[\s\S]{0,400}?if \(d\.departedAt\) \{[^\n]*\n)/,
    replace: "$1    var __rejQ = findQueue(d); if (__rejQ && (__rejQ.status === 'REJECTED' || (__rejQ.lg && __rejQ.lg.status === 'Rejected'))) { toast('รายการนี้ถูกปฏิเสธแล้ว ไม่สามารถโหลดได้'); showLoadForm(); return; }\n",
  },
  {
    id: 'LG02-V4-URL',
    kind: 'fix',
    files: ['LG02.html'],
    since: '2026-10-31',
    why: 'ปุ่มส่งชั่ง V4 เปิด V4(1).html (ชื่อไฟล์บนเครื่องทีม UI) → 404 · ระบบเราใช้ V4.html',
    find: /V4\(1\)\.html/g,
    replace: 'V4.html',
  },
  {
    id: 'LG02-REJECT-BY-LOGIN',
    kind: 'fix',
    files: ['LG02.html'],
    since: '2026-11-01',
    why: 'ปฏิเสธงานบันทึกผู้ทำเป็น "LG" เพราะหน้า LG02 ไม่รู้จักผู้ login → ใช้ผู้ที่ login ระบบจาก bridge',
    find: /rec\.lg\.rejectedBy = user\.id \|\| 'LG';/,
    replace: "rec.lg.rejectedBy = (window.__whrmWho && window.__whrmWho()) || user.id || 'LG';",
  },
  {
    id: 'DBV2-UNITS-BY-LOGIN',
    kind: 'fix',
    files: ['DBV2.0.html'],
    since: '2026-11-01',
    why: 'Units Center บันทึกผู้แก้จากชื่อที่ฝังในหน้า DBV2.0 (ไม่ใช่ผู้ login) → ใช้ผู้ที่ login ระบบจาก bridge',
    find: /\(document\.getElementById\('userNameDisplay'\)\|\|\{\}\)\.innerText\|\|'Local User'/g,
    replace: "(window.__whrmWho&&window.__whrmWho())||'ไม่ทราบผู้ใช้'",
  },
  {
    id: 'WH13-LG-REJECTED-DOC',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'WH13 ไม่รู้จักสถานะปฏิเสธของ LG → เอกสารยังขึ้น "รอ LG รับงาน" · เพิ่มสถานะในรายงาน / Doc Hub',
    find: /(function lgStKey\(rec\)\{[\s\S]{0,300}?)(if \(!lg\.accepted\) return 'LG_WAIT';)/,
    replace: "$1if (s === 'REJECTED' || lg.status === 'Rejected') return 'LG_REJECTED';\n    $2",
  },
  {
    id: 'WH13-LG-REJECTED-LABEL',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-DOC — ป้ายสถานะของ LG_REJECTED',
    find: /LG_WAIT: \['#94a3b8', '🚚 รอ LG รับงาน'\],/,
    replace: "LG_REJECTED: ['#f43f5e', '❌ LG ปฏิเสธงาน'], $&",
  },
  {
    id: 'WH13-LG-REJECTED-META',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-DOC — หัวรายละเอียดเอกสารแสดงเหตุผลและผู้ปฏิเสธแทน "รอ LG กด รับเข้า"',
    find: /: '<span style="color:#94a3b8;font-weight:500">รอ LG กด "รับเข้า"<\/span>'\)\);/,
    replace: ": (lg.status === 'Rejected' || rec.status === 'REJECTED') ? '<span style=\"color:#f43f5e;font-weight:700\">LG ปฏิเสธ: ' + esc(lg.rejectReason || '-') + ' · ' + esc(lg.rejectedBy || '-') + '</span>' : '<span style=\"color:#94a3b8;font-weight:500\">รอ LG กด \"รับเข้า\"</span>'));",
  },
  {
    id: 'WH13-LG-REJECTED-CHIP',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-DOC — ป้ายในรายการ / หน้าสถานะ / Print Queue ใช้ info() ตัวเดียวกัน',
    find: /if \(!lg\.accepted\) \{ label = 'รอ LG รับงาน'; color = '#94a3b8'; \}/,
    replace: "var __rej = lg.status === 'Rejected' || r.status === 'REJECTED'; if (__rej) { label = 'LG ปฏิเสธงาน'; color = '#f43f5e'; } else $&",
  },
  {
    id: 'WH13-LG-REJECTED-TIP',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-CHIP — คำอธิบายบนป้าย',
    find: /\} else tip\.push\('ส่งมอบเข้าคิว Logistic แล้ว — รอ LG กด "รับเข้า"'\);/,
    replace: "} else tip.push(__rej ? 'เหตุผล: ' + (lg.rejectReason || '-') + ' · โดย ' + (lg.rejectedBy || '-') : 'ส่งมอบเข้าคิว Logistic แล้ว — รอ LG กด \"รับเข้า\"');",
  },
  {
    id: 'WH13-LG-REJECTED-DETAIL',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-CHIP — กล่องรายละเอียดหน้าติดตามใบโอนแสดงเหตุผลและผู้ปฏิเสธ',
    find: /: '<div style="color:#94a3b8">ยังไม่มีการรับงานจาก LG<\/div>'\) \+/,
    replace: ": (lg.status === 'Rejected' || i.rec.status === 'REJECTED') ? row('เหตุผลที่ปฏิเสธ', lg.rejectReason || '-') + row('ผู้ปฏิเสธ', lg.rejectedBy || '-') : '<div style=\"color:#94a3b8\">ยังไม่มีการรับงานจาก LG</div>') +",
  },
  {
    id: 'WH13-LG-REJECTED-TIME',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'คู่กับ WH13-LG-REJECTED-CHIP — ใบที่ LG ปฏิเสธไม่มีรถออก ช่องกรอบเวลาไม่ควรขึ้น "รอรถออก"',
    find: /if \(deadlineMs\(d\) === Infinity\) return '<span style="font-size:10\.5px;font-weight:800;color:#38bdf8"><i class="fa-solid fa-truck"><\/i> รอรถออก/,
    replace: "var __lgr = d.logisticNo && window.__lgLink && window.__lgLink.rec(d.logisticNo); if (deadlineMs(d) === Infinity && __lgr && (__lgr.status === 'REJECTED' || (__lgr.lg && __lgr.lg.status === 'Rejected'))) return '<span style=\"font-size:10.5px;font-weight:800;color:#f87171\"><i class=\"fa-solid fa-ban\"></i> LG ปฏิเสธงาน — ไม่มีรถออก</span>';\n    $&",
  },
  {
    id: 'BD02-SBO-NUMBER-SERVER',
    kind: 'fix',
    files: ['BD02.html'],
    since: '2026-11-01',
    why: 'RC-01: เลข SBO นับแยกแต่ละเครื่อง → ชนกันได้ · ขอเลขจาก server (ติดต่อไม่ได้ = ไม่สร้างออเดอร์)',
    find: /const seq = peekSeq\(\);\s*const saleOrderId = `SO-\$\{yyyymmdd\(\)\}-\$\{String\(seq\)\.padStart\(3, '0'\)\}`;\s*const internal = \{\s*sale_order_id: saleOrderId,\s*sbo_number:\s+generateSBO\(\),/,
    replace: "const __no = window.__whrmNextSbo();\n      const internal = {\n        sale_order_id: __no.saleOrderId,\n        sbo_number:    __no.sboNumber,",
  },
  {
    id: 'BD02-SBO-STORE-EXPOSE',
    kind: 'fix',
    files: ['BD02.html'],
    since: '2026-11-01',
    why: 'RC-01: ออเดอร์อยู่ใน Map ของหน้าจอ → เปิดให้ bridge อัปเดตเมื่ออีกเครื่องเปลี่ยนสถานะ',
    find: /const store = loadStore\(\);/,
    replace: 'const store = loadStore(); global.__sboStore = store;',
  },
  {
    id: 'BD02-QT-NUMBER-SERVER',
    kind: 'fix',
    files: ['BD02.html'],
    since: '2026-11-01',
    why: 'เลขใบเสนอราคาหาเลขถัดไปจากข้อมูลในเครื่อง → ชนกันได้ · ขอเลขจาก server',
    find: /function generateQTId\(\) \{/,
    replace: 'function generateQTId() { return window.__whrmNextQt();',
  },
  {
    id: 'WH13-SBO-CLAIM',
    kind: 'fix',
    files: ['WH13.html'],
    since: '2026-11-01',
    why: 'RC-01: เครื่องที่รับแล้วจำแยกแต่ละเครื่อง → WH13 หลายเครื่องจะเข้า Info Center ซ้ำ · ให้ server ตัดสินเครื่องแรก (ติดต่อไม่ได้ = รอบใหม่)',
    find: /(if \(!Array\.isArray\(o\.line_items\) \|\| !o\.line_items\.length\) \{[\s\S]{0,160}?return;\s*\}\s*)(state\.ingested\[item\.id\] = o\.sbo_number;[\s\S]{0,320}?)deliverToInfoCenter\(toIcMessage\(o, item\)\);/,
    replace: "$1var __claim = window.__whrmClaimSbo(item.id); if (__claim === null) return;\n        $2if (__claim) deliverToInfoCenter(toIcMessage(o, item));",
  },
  {
    id: 'BD02-EMPTY-CART-BLOCK',
    kind: 'fix',
    files: ['BD02.html'],
    since: '2026-11-01',
    why: 'RC-01 / TC-BD02-02: ตะกร้าว่างกดยืนยันแล้วไปเรียกฟอร์มเดิม → สร้างออเดอร์สินค้าตัวอย่าง SKU-003 จำนวน 1,000 · ต้องบล็อก',
    find: /(\/\* Call original as fallback \*\/\s*)if \(typeof _origSubmit === 'function'\)\{\s*return _origSubmit\.apply\(this, arguments\);\s*\}/,
    replace: '$1',
  },
  // เอาออกแล้ว (ลูกค้าแก้ใน WH13 26 ต.ค.): WH13-FGT-SUBMIT-STUB (ปุ่มยืนยัน FGT) · WH13-REQ-PANEL-WIDTH (แท็บเบิก/คืนเบียด)
  //              (31 ต.ค.): SEC-WH13-DCSUP-PIN + WH13-DCSUP-LOGIN-SERVER — ลูกค้าลบบัญชี DC_SUP · ปลดล็อกใบโอนใช้ __drm.checkUser (ผ่าน bridge)
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
