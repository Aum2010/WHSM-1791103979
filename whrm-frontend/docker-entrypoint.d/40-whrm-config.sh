#!/bin/sh
# เขียน /config.js จาก env API_BASE
#   ว่าง (ค่าเริ่มต้น) = browser เรียก /api, /bus ที่ frontend นี้ → nginx ส่งต่อไป BACKEND_ORIGIN
#   ใส่ URL      = browser เรียก backend ตรง (ข้าม origin — backend ต้องตั้ง CORS_ORIGINS)
# DEMO_BOT=1 → แสดงปุ่ม 🤖 Demo Bot ใน V4 (กรอก/ชั่งแทนคน สำหรับ demo)
set -e
case "${DEMO_BOT}" in 1|true|TRUE|yes|on) DEMO=true ;; *) DEMO=false ;; esac
cat > /usr/share/nginx/html/config.js <<JS
// สร้างโดย docker-entrypoint — API_BASE=${API_BASE} DEMO_BOT=${DEMO_BOT}
window.WHRM_CONFIG = { "apiBase": "${API_BASE}", "demoBot": ${DEMO} };
JS
echo "whrm-frontend: config.js → ${API_BASE} (demoBot=${DEMO})"
