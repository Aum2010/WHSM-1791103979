// WebSocket hub — ต่อ BroadcastChannel ของ UI ข้ามเครื่อง
//
// client → server
//   { kind: 'hello', deviceId, app, lastSeq }
//   { kind: 'bus', channel, msgId, data }        data = message เดิมที่ UI postMessage
//   { kind: 'ping' }
// server → client
//   { kind: 'welcome', connId, busSeq }
//   { kind: 'bus', channel, msgId, seq, data }   relay ไปทุก connection ยกเว้นผู้ส่ง
//   { kind: 'kv', key, value, version, deviceId, connId }   (จาก sync service)
//   { kind: 'pong' }

import crypto from 'node:crypto'
import { applyBusEvent } from './weighing.js'

const REPLAY_LIMIT = 500
const REPLAY_WINDOW = '24 hours'

export function createBus({ pool, log, ruCancel, auth }) {
  const conns = new Map() // connId → { socket, deviceId, app }

  function send(conn, obj) {
    if (conn.socket.readyState === 1) conn.socket.send(JSON.stringify(obj))
  }

  function broadcast(obj, exceptConnId) {
    const text = JSON.stringify(obj)
    for (const [id, conn] of conns) {
      if (id !== exceptConnId && conn.socket.readyState === 1) conn.socket.send(text)
    }
  }

  async function onHello(conn, msg, req) {
    conn.deviceId = String(msg.deviceId || '').slice(0, 100) || null
    conn.app = String(msg.app || '').slice(0, 20) || null
    if (conn.deviceId) {
      await pool.query(
        `INSERT INTO device (device_id, app, user_agent, ip) VALUES ($1,$2,$3,$4)
         ON CONFLICT (device_id) DO UPDATE SET app = EXCLUDED.app, user_agent = EXCLUDED.user_agent,
           ip = EXCLUDED.ip, last_seen = now()`,
        [conn.deviceId, conn.app, req.headers['user-agent'] || null, req.ip],
      )
    }
    const { rows: [{ max }] } = await pool.query('SELECT COALESCE(MAX(seq), 0)::bigint AS max FROM bus_message')
    send(conn, { kind: 'welcome', connId: conn.id, busSeq: Number(max) })

    // V4 เพิ่งต่อเข้ามา → ส่งงานยกเลิก RU ที่ยังไม่มี V4 ตอบ
    if (conn.app === 'V4' && ruCancel) {
      const n = await ruCancel.resendPending((obj) => send(conn, obj))
      if (n) log.info({ connId: conn.id, count: n }, 'resent pending RU cancels')
    }

    const lastSeq = Number(msg.lastSeq) || 0
    // WH13 เพิ่งเปิดหน้า → ส่งรายงานชั่งที่ V4 นำส่งใน 24 ชม. ก่อนเปิดหน้านี้ (ใบล่าสุดต่อ reportId)
    // ไม่งั้นรายงานที่ส่งตอนไม่มี WH13 เปิดอยู่จะไม่มีวันมาถึง · WH13 ข้ามใบ/รายการที่รับแล้วเอง (whrm_trip_received_v1)
    // เฉพาะ seq ≤ lastSeq — ส่วนที่ใหม่กว่า replay ด้านล่างส่งให้อยู่แล้ว
    if (conn.app === 'WH13' && msg.boot) {
      const { rows: trips } = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (payload->'payload'->>'reportId') seq, msg_id, channel, payload FROM bus_message
           WHERE type = 'TRIP_SAVED' AND device_id IS DISTINCT FROM $1 AND at > now() - $2::interval AND seq <= $3
           ORDER BY payload->'payload'->>'reportId', seq DESC) t
         ORDER BY seq LIMIT $4`,
        [conn.deviceId, REPLAY_WINDOW, lastSeq > 0 ? lastSeq : Number.MAX_SAFE_INTEGER, REPLAY_LIMIT],
      )
      for (const r of trips) {
        send(conn, { kind: 'bus', channel: r.channel, msgId: r.msg_id, seq: Number(r.seq), data: r.payload, replay: true })
      }
      if (trips.length) log.info({ connId: conn.id, count: trips.length }, 'WH13 boot: resent recent trips')
    }

    // replay message ที่พลาดระหว่างหลุด (ไม่รวมของเครื่องตัวเอง)
    if (lastSeq > 0) {
      const { rows } = await pool.query(
        `SELECT seq, msg_id, channel, payload FROM bus_message
         WHERE seq > $1 AND device_id IS DISTINCT FROM $2 AND at > now() - $3::interval
         ORDER BY seq LIMIT $4`,
        [lastSeq, conn.deviceId, REPLAY_WINDOW, REPLAY_LIMIT],
      )
      for (const r of rows) {
        send(conn, { kind: 'bus', channel: r.channel, msgId: r.msg_id, seq: Number(r.seq), data: r.payload, replay: true })
      }
      if (rows.length) log.info({ connId: conn.id, count: rows.length }, 'bus replay')
    }
  }

  async function onBus(conn, msg) {
    const data = msg.data
    if (!data || typeof data !== 'object') return
    const msgId = String(msg.msgId || crypto.randomUUID())
    const channel = String(msg.channel || 'whrm-bus')
    // heartbeat (ทุก 10 วิ ต่อหน้าจอ) — ส่งต่ออย่างเดียว ไม่เก็บลง DB / ไม่ replay
    if (data.type === 'PING' || data.type === 'PONG') {
      broadcast({ kind: 'bus', channel, msgId, data }, conn.id)
      return
    }
    const { rows } = await pool.query(
      `INSERT INTO bus_message (msg_id, channel, type, source, device_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (msg_id) DO NOTHING RETURNING seq`,
      [msgId, channel, data.type ? String(data.type) : null, data.source ? String(data.source) : null,
        conn.deviceId, JSON.stringify(data)],
    )
    if (!rows.length) return // ส่งซ้ำ (เช่นหลัง reconnect) — เคย relay แล้ว
    const seq = Number(rows[0].seq)
    broadcast({ kind: 'bus', channel, msgId, seq, data }, conn.id)
    try {
      await applyBusEvent(pool, data, conn.deviceId)
      if (data.type === 'RMA_CANCEL_RU_DONE' && ruCancel) await ruCancel.onDone(data, conn.deviceId)
    } catch (err) {
      log.error({ err, type: data.type }, 'apply bus event failed')
    }
  }

  function handler(socket, req) {
    const conn = { id: crypto.randomUUID(), socket, deviceId: null, app: null, user: null }

    // ต้อง login (cookie / Bearer) — ไม่ผ่านปิดด้วย 4401 ให้ bridge พาไปหน้า login
    // ตรวจเป็นขั้นแรกของ chain → message ที่มาก่อนตรวจเสร็จรอตามลำดับ
    let chain = (auth ? auth.lookup(auth.wsTokenOf(req)) : Promise.resolve({ username: null })).then((user) => {
      if (!user) { socket.close(4401, 'unauthenticated'); return }
      conn.user = user
      conns.set(conn.id, conn)
      log.info({ connId: conn.id, ip: req.ip, user: user.username, total: conns.size }, 'bus connected')
    }).catch((err) => { log.error({ err }, 'bus auth failed'); socket.close(1011, 'auth error') })
    socket.on('message', (raw) => {
      chain = chain.then(async () => {
        if (!conn.user) return
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        try {
          if (msg.kind === 'hello') await onHello(conn, msg, req)
          else if (msg.kind === 'bus') await onBus(conn, msg)
          else if (msg.kind === 'ping') send(conn, { kind: 'pong' })
        } catch (err) {
          log.error({ err, kind: msg.kind }, 'bus message failed')
        }
      })
    })
    socket.on('close', () => {
      conns.delete(conn.id)
      log.info({ connId: conn.id, total: conns.size }, 'bus disconnected')
    })
    socket.on('error', (err) => log.warn({ err }, 'bus socket error'))
  }

  // keep-alive (proxy / Wi-Fi บางตัวตัด connection ที่เงียบ)
  const timer = setInterval(() => {
    for (const conn of conns.values()) if (conn.socket.readyState === 1) conn.socket.ping()
  }, 25000)
  timer.unref()

  return {
    handler,
    broadcast,
    stats: () => [...conns.values()].map((c) => ({ connId: c.id, deviceId: c.deviceId, app: c.app, user: c.user?.username || null })),
  }
}
