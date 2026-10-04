import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export function createPool(connectionString) {
  return new pg.Pool({ connectionString, max: 10 })
}

export async function withTx(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// รอ DB พร้อม (ตอน docker compose ขึ้นพร้อมกัน)
export async function waitForDb(pool, log, attempts = 30) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      log.warn(`DB not ready (${i}/${attempts}): ${err.message}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error('Database not reachable')
}

export async function migrate(pool, log) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const { rows } = await pool.query('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.name))
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
    await withTx(pool, async (c) => {
      await c.query(sql)
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
    log.info(`migration applied: ${file}`)
  }
}
