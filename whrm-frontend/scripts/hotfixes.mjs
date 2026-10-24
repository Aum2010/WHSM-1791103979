// Hotfix ตอน build — แก้ bug ในหน้าเว็บของลูกค้าชั่วคราว โดยไม่แตะไฟล์ใน ui/ (dist/raw/ ยังเป็นต้นฉบับ)
// แต่ละข้อหาข้อความที่ระบุ ถ้าไม่เจอ (ลูกค้าแก้แล้ว / เปลี่ยนโค้ด) → ข้ามพร้อมเตือน ไม่ทำให้ build พัง
// เมื่อทีม UI แก้ต้นทางแล้ว ลบรายการออกจากที่นี่
export const HOTFIXES = [
  {
    id: 'WH13-FGT-SUBMIT-STUB',
    file: 'WH13.html',
    since: '2026-10-23',
    why: 'patch "แยกหน่วย / Sub-row" (WH13 22 ต.ค.) เขียนทับ handleFGTSubmit ด้วยตัวที่แค่ขึ้น toast "สำเร็จ" + ล้างฟอร์ม ' +
      'ไม่เรียก _origFGTSubmit → ใบ FGT ไม่เข้าคิว ไม่ถาม login · แก้: เรียกตัวเดิม (FGT-B: login → ออกเลข → คิว)',
    find: /if \(typeof showToast === 'function'\) showToast\(`✅ ส่งคำขอ FGT สำเร็จ! \(\$\{items\.length\} รายการ\)`\);\s*if \(typeof clearFGTForm === 'function'\) clearFGTForm\(\);\s*else tbody\.innerHTML = '';/,
    replace: "return _origFGTSubmit.call(this, e); /* whrm-hotfix WH13-FGT-SUBMIT-STUB */",
  },
  {
    id: 'WH13-RETURN-DUP-SEARCH',
    file: 'WH13.html',
    since: '2026-10-24',
    why: 'แท็บ "2. คืน" มีปุ่ม "ค้นหาใน DB" 2 ปุ่ม (ReturnFlow retQuickSearch + SearchDB v1) · patch Fix-v14c ของลูกค้าลบด้วย rAF watchdog ' +
      'แต่ถูก patch "RAF HARD KILL" / "FGA-Final-Kill" หยุด → ปุ่มซ้ำค้าง · แก้: ซ่อนปุ่ม retQuickSearch ด้วย CSS (คง SearchDB v1 ตามที่ Fix-v14c ตั้งใจ)',
    find: /<\/head>/i,
    replace: '<style data-whrm-hotfix="WH13-RETURN-DUP-SEARCH">#reqPanel-return button[onclick^="retQuickSearch"]{display:none!important}</style></head>',
  },
  {
    id: 'WH13-REQ-PANEL-WIDTH',
    file: 'WH13.html',
    since: '2026-10-24',
    why: 'WH13 22 ต.ค. ขยายแท็บ "3. นำส่ง (FGT)" เป็นเต็มจอ (max-w-4xl → w-full) แต่แท็บ "1. เบิก" / "2. คืน" ยังกว้างสุด ~900px ' +
      '→ ตารางรายการ 8 คอลัมน์เบียด ต้องเลื่อนซ้ายขวา ชื่อสินค้าถูกตัด · แก้: ให้กว้างเต็มเหมือน FGT',
    find: /<\/head>/i,
    replace: '<style data-whrm-hotfix="WH13-REQ-PANEL-WIDTH">#reqPanel-issue,#reqPanel-return{max-width:none!important;width:100%!important}</style></head>',
  },
]

export function applyHotfixes(file, html) {
  let out = html
  for (const h of HOTFIXES) {
    if (h.file !== file) continue
    if (h.find.test(out)) { out = out.replace(h.find, h.replace); console.log(`hotfix ${h.id} → ${file}`) }
    else console.warn(`hotfix ${h.id}: ไม่พบโค้ดที่ต้องแก้ใน ${file} (ลูกค้าอาจแก้แล้ว) — ข้าม`)
  }
  return out
}
