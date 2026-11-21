// Tailwind ตอน build แทน CDN (cdn.tailwindcss.com — 21 พ.ย. ตรวจความลื่น: WH13 ใช้เวลา ~2.3 จาก 5 วินาทีตอนเปิดหน้าไปกับการสร้าง CSS ในเบราว์เซอร์
//   + คอยดูทุกการเปลี่ยนแปลงบนหน้าจอ · ต้องต่ออินเทอร์เน็ต · Tailwind แจ้งว่าไม่ใช้กับระบบจริง)
//   - เวอร์ชันเดียวกับ CDN (3.4.17) · อ่าน tailwind.config = {…} ของแต่ละหน้า (ตัวสุดท้าย) · สแกนคลาสจากไฟล์หน้าเว็บ (รวม script ในหน้า) + ไฟล์ js ที่แทรก
//   - วาง <style> ท้าย <head> ตำแหน่งเดียวกับที่ CDN วาง (ลำดับ CSS เหมือนเดิม)
//   - แทน <script src=cdn> ด้วยตัวกัน (window.tailwind) — บางหน้าเขียน tailwind.config = … ตรง ๆ จะ error ถ้าไม่มี CDN
//   ปิดได้: WHRM_TAILWIND_CDN=1 (กลับไปใช้ CDN ทั้งหมด)
import vm from 'node:vm'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

export const CDN_RE = /<script\b[^>]*\bsrc=["']https:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*>\s*<\/script>/gi

// ช่วงของ <script>…</script> (ข้ามข้อความใน script ตอนหา </head>)
function scriptRanges(html) {
  const out = [], re = /<script\b[^>]*>/gi
  let m
  while ((m = re.exec(html))) {
    const end = html.toLowerCase().indexOf('</script', re.lastIndex)
    if (end < 0) break
    out.push([m.index, end]); re.lastIndex = end + 8
  }
  return out
}
export function headEnd(html) {
  const rs = scriptRanges(html), re = /<\/head\s*>/gi
  let m
  while ((m = re.exec(html))) if (!rs.some(([a, b]) => m.index > a && m.index < b)) return m.index
  return -1
}

// tailwind.config = { … } → object (วงเล็บสมดุล · ข้ามข้อความในเครื่องหมายคำพูด)
export function extractConfig(html) {
  let cfg = null
  const re = /tailwind\.config\s*=\s*\{/g
  let m
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length - 1
    let depth = 0, i = start, q = null
    for (; i < html.length; i++) {
      const c = html[i]
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
      if (c === '"' || c === "'" || c === '`') q = c
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) break
    }
    try { cfg = vm.runInNewContext('(' + html.slice(start, i + 1) + ')', {}, { timeout: 1000 }) } catch (e) { /* อ่านไม่ได้ → ใช้ตัวก่อนหน้า */ }
  }
  return cfg || {}
}

// โค้ดของลูกค้าประกอบชื่อคลาสสีตอนทำงาน → สแกนไฟล์ไม่เจอ เช่น
//   'bg-' + st[1] + '-500/15' · 'border-' + (ok ? 'emerald' : 'rose') + '-500/30' · `border-${m.text.split('-')[1]}-200`
//   → หาจุดที่ประกอบ แล้วเผื่อเฉพาะ "ชนิด-?-เฉด/ความโปร่งใส" ของจุดนั้น · สี = คำสีที่เขียนไว้ในจุดนั้น หรือ (เป็นตัวแปร) สีที่หน้านั้นใช้ในคลาสจริง
const PALETTE = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose']
const PROP = '((?:hover:)?(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent|decoration))'
export function colorSafelist(src) {
  const pageColors = PALETTE.filter((c) => new RegExp(`(?<![A-Za-z0-9])(?:bg|text|border|ring)-${c}-\\d`).test(src))
  const out = new Set()
  const add = (prop, mid, shade, op) => {
    const lit = PALETTE.filter((c) => new RegExp(`['"\`]${c}['"\`]`).test(mid))
    for (const c of lit.length ? lit : pageColors) out.add(`${prop}-${c}-${shade}${op || ''}`)
  }
  for (const m of src.matchAll(new RegExp(`${PROP}-['"\`]\\s*\\+([\\s\\S]{0,200}?)\\+\\s*['"\`]-(50|[1-9]00|950)(\\/\\d{1,3})?(?![\\d])`, 'g'))) add(m[1], m[2], m[3], m[4])
  for (const m of src.matchAll(new RegExp(`${PROP}-\\$\\{([^}]{0,120})\\}-(50|[1-9]00|950)(\\/\\d{1,3})?(?![\\d])`, 'g'))) add(m[1], m[2], m[3], m[4])
  return [...out]
}

export async function precompileTailwind(html, extraRaw = []) {
  if (process.env.WHRM_TAILWIND_CDN === '1') return { html, css: 0 }
  CDN_RE.lastIndex = 0
  if (!CDN_RE.test(html)) return { html, css: 0 }
  const cfg = extractConfig(html)
  const content = [{ raw: html, extension: 'html' }, ...extraRaw.map((raw) => ({ raw, extension: 'js' }))]
  const safelist = [...(Array.isArray(cfg.safelist) ? cfg.safelist : []), ...colorSafelist(html)]
  const { css } = await postcss([tailwindcss({ ...cfg, content, safelist })]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined })
  CDN_RE.lastIndex = 0
  const rs = scriptRanges(html)
  // แทนเฉพาะแท็กจริง — ข้อความใน script (เช่น template หน้าพิมพ์ที่เปิดหน้าต่างใหม่) คงเดิม
  let out = html.replace(CDN_RE, (tag, at) => rs.some(([a, b]) => at > a && at < b) ? tag
    : '<script>window.tailwind = window.tailwind || { config: {} };   /* [WHRM TAILWIND-BUILD] CSS สร้างตอน build */</script>')
  const at = headEnd(out)
  const tag = '<style data-whrm-tailwind="3.4.17">\n' + css + '\n</style>\n'
  out = at >= 0 ? out.slice(0, at) + tag + out.slice(at) : tag + out
  return { html: out, css: css.length }
}
