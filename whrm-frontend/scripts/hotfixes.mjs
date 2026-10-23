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
