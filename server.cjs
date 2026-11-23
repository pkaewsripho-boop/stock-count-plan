'use strict';
// แผนการตรวจนับสต็อก — Server
// - เสิร์ฟหน้าเว็บ (public/index.html) และ API เก็บข้อมูลแผน/ผลนับ
// - ตั้ง DATABASE_URL (เช่น Neon) → เก็บใน PostgreSQL ตาราง stockcount_docs (ข้อมูลไม่หายเมื่อ Render รีสตาร์ต)
// - ไม่ตั้ง DATABASE_URL → เก็บเป็นไฟล์ data/stockcount.json (ใช้ในออฟฟิศ / ทดสอบในเครื่อง)
// - ตั้ง EDIT_PIN → ต้องใส่ PIN ก่อนแก้ไข/นำเข้า (ดูอย่างเดียวไม่ต้องใช้ PIN)
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 3010;
const EDIT_PIN = String(process.env.EDIT_PIN || '').trim();
const PUBLIC = path.join(__dirname, 'public');
const COLS = new Set(['counts', 'plans', 'slocs', 'config']);
const ID_RE = /^[\w.:@+~-]{1,120}$/;
const MAX_BODY = 30 * 1024 * 1024;

let lastTs = 0;
const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));

/* ---------------- storage ---------------- */
async function pgStore(url) {
  let pg;
  try { pg = require('pg'); } catch { throw Error('ตั้ง DATABASE_URL แล้วแต่ไม่พบแพ็กเกจ pg — Build command ต้องเป็น npm install'); }
  const local = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000, ssl: local ? false : { rejectUnauthorized: false } });
  pool.on('error', e => console.error('Database: การเชื่อมต่อหลุด (จะเชื่อมใหม่อัตโนมัติ):', e.message));
  const q = async (sql, args) => {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await pool.query(sql, args); }
      catch (e) { last = e; if (!/ECONNRESET|ETIMEDOUT|terminat|Connection|timeout|57P01/i.test(String(e.code) + e.message)) break; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
    }
    throw last;
  };
  await q(`CREATE TABLE IF NOT EXISTS stockcount_docs (
    col text NOT NULL, id text NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
    updated_at bigint NOT NULL, PRIMARY KEY (col, id))`);
  await q('CREATE INDEX IF NOT EXISTS stockcount_docs_upd ON stockcount_docs (updated_at)');
  const mx = await q('SELECT COALESCE(MAX(updated_at),0) AS m FROM stockcount_docs');
  lastTs = Math.max(lastTs, Number(mx.rows[0].m));
  return {
    kind: 'PostgreSQL (DATABASE_URL)',
    async since(ts) {
      const { rows } = await q('SELECT col,id,data,deleted FROM stockcount_docs WHERE updated_at > $1 AND (deleted = false OR $1 > 0)', [ts]);
      return rows;
    },
    async write(ops) {
      const ts = nextTs();
      const sets = ops.filter(o => o.op === 'set'), dels = ops.filter(o => o.op === 'delete');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < sets.length; i += 500) {
          const chunk = sets.slice(i, i + 500).map(o => ({ c: o.col, i: o.id, d: o.data }));
          await client.query(`INSERT INTO stockcount_docs (col,id,data,deleted,updated_at)
            SELECT x->>'c', x->>'i', x->'d', false, $2 FROM jsonb_array_elements($1::jsonb) x
            ON CONFLICT (col,id) DO UPDATE SET data = EXCLUDED.data, deleted = false, updated_at = EXCLUDED.updated_at`, [JSON.stringify(chunk), ts]);
        }
        for (const o of dels) await client.query('UPDATE stockcount_docs SET data = NULL, deleted = true, updated_at = $3 WHERE col = $1 AND id = $2', [o.col, o.id, ts]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
      return ts;
    },
    async count() { const { rows } = await q('SELECT col, COUNT(*)::int AS n FROM stockcount_docs WHERE deleted = false GROUP BY col'); return Object.fromEntries(rows.map(r => [r.col, r.n])); },
    close: () => pool.end().catch(() => {})
  };
}

async function fileStore() {
  const dir = path.join(__dirname, 'data');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'stockcount.json');
  let db = {};
  try { db = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  for (const k in db) for (const id in db[k]) lastTs = Math.max(lastTs, db[k][id].t || 0);
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(async () => { await fsp.writeFile(file + '.tmp', JSON.stringify(db)); await fsp.rename(file + '.tmp', file); }));
  return {
    kind: 'ไฟล์ data/stockcount.json (ไม่ได้ตั้ง DATABASE_URL)',
    async since(ts) {
      const out = [];
      for (const col in db) for (const id in db[col]) { const r = db[col][id]; if (r.t > ts && (!r.x || ts > 0)) out.push({ col, id, data: r.x ? null : r.d, deleted: !!r.x }); }
      return out;
    },
    async write(ops) {
      const ts = nextTs();
      for (const o of ops) { const c = (db[o.col] ||= {}); c[o.id] = o.op === 'set' ? { d: o.data, t: ts } : { x: 1, t: ts }; }
      await save();
      return ts;
    },
    async count() { const r = {}; for (const c in db) r[c] = Object.values(db[c]).filter(x => !x.x).length; return r; },
    close: async () => {}
  };
}

/* ---------------- http ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra);
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers); res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(Error('ข้อมูลใหญ่เกินไป'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(Error('JSON ไม่ถูกต้อง'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function validOps(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 5000) return 'ops ต้องเป็นรายการ 1–5000 รายการ';
  for (const o of ops) {
    if (!o || !['set', 'delete'].includes(o.op)) return 'op ต้องเป็น set หรือ delete';
    if (!COLS.has(o.col)) return 'col ไม่ถูกต้อง: ' + o.col;
    if (!ID_RE.test(String(o.id || ''))) return 'id ไม่ถูกต้อง: ' + o.id;
    if (o.op === 'set' && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data))) return 'data ต้องเป็น object';
  }
  return null;
}

async function main() {
  const url = String(process.env.DATABASE_URL || '').trim();
  const store = url ? await pgStore(url) : await fileStore();
  console.log('Storage: ' + store.kind + (url ? ' ✓ ข้อมูลไม่หายเมื่อรีสตาร์ต' : ' ⚠️ บน Render ข้อมูลจะหายเมื่อรีสตาร์ต ให้ตั้ง DATABASE_URL'));
  console.log('Edit PIN: ' + (EDIT_PIN ? 'เปิดใช้ (ต้องใส่ PIN ก่อนแก้ไข)' : 'ไม่ได้ตั้ง (ทุกคนที่เปิดลิงก์แก้ไขได้)'));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/health') return send(req, res, 200, { ok: true, storage: store.kind, docs: await store.count() });
      if (u.pathname === '/api/state' && req.method === 'GET') {
        const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
        const docs = await store.since(since);
        return send(req, res, 200, { now: lastTs, pinRequired: !!EDIT_PIN, docs });
      }
      if (u.pathname === '/api/pin' && req.method === 'POST') {
        const b = await readBody(req);
        return send(req, res, (!EDIT_PIN || String(b.pin || '') === EDIT_PIN) ? 200 : 401, { ok: !EDIT_PIN || String(b.pin || '') === EDIT_PIN });
      }
      if (u.pathname === '/api/write' && req.method === 'POST') {
        if (EDIT_PIN && String(req.headers['x-edit-pin'] || '') !== EDIT_PIN) return send(req, res, 401, { error: 'ต้องใส่ PIN สำหรับแก้ไข' });
        const b = await readBody(req);
        const err = validOps(b.ops); if (err) return send(req, res, 400, { error: err });
        const ts = await store.write(b.ops);
        return send(req, res, 200, { ok: true, now: ts, n: b.ops.length });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' });
      // static files
      let p = decodeURIComponent(u.pathname);
      if (p === '/' || !path.extname(p)) p = '/index.html';
      const fp = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
      if (!fp.startsWith(PUBLIC)) return send(req, res, 403, 'forbidden', 'text/plain');
      const data = await fsp.readFile(fp).catch(() => null);
      if (!data) return send(req, res, 404, 'not found', 'text/plain; charset=utf-8');
      const ext = path.extname(fp);
      return send(req, res, 200, data, MIME[ext] || 'application/octet-stream', { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    } catch (e) {
      console.error(req.method, u.pathname, e.message);
      return send(req, res, e.status || 500, { error: e.message });
    }
  });
  server.listen(PORT, () => console.log(`แผนการตรวจนับสต็อก พร้อมใช้งานที่ http://localhost:${PORT}`));
  const stop = () => { server.close(); store.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(e => { console.error('เริ่มระบบไม่สำเร็จ:', e.message); process.exit(1); });
