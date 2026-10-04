# build: แทรก bridge ลงหน้าเว็บของลูกค้า → serve ด้วย nginx (static + proxy /api, /bus ไป backend)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY ui ./ui
RUN node scripts/build.mjs

FROM nginx:1.27-alpine
# nginx image แทน ${BACKEND_ORIGIN} ใน template → /etc/nginx/conf.d/default.conf ตอน container เริ่ม
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# เขียน config.js จาก env API_BASE ทุกครั้งที่ container เริ่ม · ว่าง = เรียกผ่าน proxy ของ frontend (แนะนำ)
COPY docker-entrypoint.d/40-whrm-config.sh /docker-entrypoint.d/40-whrm-config.sh
# กันไฟล์ถูกแปลงเป็น CRLF บน Windows (ทำให้ shebang หา /bin/sh ไม่เจอ)
RUN tr -d '\r' < /docker-entrypoint.d/40-whrm-config.sh > /tmp/c.sh && mv /tmp/c.sh /docker-entrypoint.d/40-whrm-config.sh && chmod +x /docker-entrypoint.d/40-whrm-config.sh
ENV API_BASE=""
ENV BACKEND_ORIGIN=http://backend:3000
EXPOSE 80
