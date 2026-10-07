// FILM 393 Over/Under Test Planner — live sync between laptops.
// One "room" per group link. Clients send field patches or full replacements;
// everyone else in the room gets them instantly over Server-Sent Events.
// No dependencies. State is kept in memory and written to DATA_DIR as JSON.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://cfacontact.github.io,http://localhost:8399,http://localhost:8400').split(',');
const MAX_BODY = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('data dir', e.message); }

const rooms = new Map(); // id -> { v, data, clients:Set<res>, saveT }

function room(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { v: 0, data: null, clients: new Set(), saveT: null };
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id + '.json'), 'utf8'));
      r.v = raw.v || 0; r.data = raw.data || null;
    } catch (e) { /* new room */ }
    rooms.set(id, r);
  }
  return r;
}
function persist(id, r) {
  clearTimeout(r.saveT);
  r.saveT = setTimeout(() => {
    const f = path.join(DATA_DIR, id + '.json');
    fs.writeFile(f + '.tmp', JSON.stringify({ v: r.v, data: r.data, savedAt: new Date().toISOString() }), err => {
      if (err) return console.error('save', id, err.message);
      fs.rename(f + '.tmp', f, e => e && console.error('rename', id, e.message));
    });
  }, 800);
}
function setPath(obj, p, val) {
  const ks = String(p).split('.');
  if (ks.some(k => BAD_KEYS.has(k) || k === '')) return false;
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
  return true;
}
// ---- join merge: shared copy wins; a joining laptop only fills empty boxes; lists are combined ----
const clone = o => JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isEmptyV = v => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
function fillMerge(a, b) {
  if (isEmptyV(a)) return b === undefined ? null : clone(b);
  if (isObj(a) && isObj(b)) { const r = clone(a); for (const k in b) { if (BAD_KEYS.has(k)) continue; r[k] = fillMerge(a[k], b[k]); } return r; }
  if (Array.isArray(a) && Array.isArray(b)) { const r = clone(a); for (let i = 0; i < b.length; i++) r[i] = fillMerge(a[i], b[i]); return r; }
  return clone(a);
}
function uniq(arr, key) { const seen = new Set(), out = []; for (const x of arr) { const k = key(x); if (!k || seen.has(k)) continue; seen.add(k); out.push(clone(x)); } return out; }
function unionLists(m, a, b) {
  const am = (a.group && a.group.members) || [], bm = (b.group && b.group.members) || [];
  if (m.group) { const mem = uniq([...am, ...bm], x => String((x && x.name) || '').trim().toLowerCase()); while (mem.length < 3) mem.push({ name: '', role: '' }); m.group.members = mem; }
  if (a.rules || b.rules) m.rules = uniq([...(a.rules || []), ...(b.rules || [])], x => String(x || '').trim());
  if (m.map) m.map.markers = uniq([...((a.map && a.map.markers) || []), ...((b.map && b.map.markers) || [])], x => x && (x.label + '|' + x.reading + '|' + x.x + '|' + x.y));
  return m;
}
function send(res, ev) { try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) {} }
function broadcast(r, ev) { for (const c of r.clients) send(c, ev); }
function presence(r) { broadcast(r, { type: 'presence', n: r.clients.size }); }

function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes(o) || ORIGINS.includes('*'))) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { fail(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
  if (parts[0] !== 'room' || !ID_RE.test(parts[1] || '')) return json(res, 404, { error: 'not found' });
  const id = parts[1], r = room(id), sub = parts[2];

  try {
    if (req.method === 'GET' && !sub) return json(res, 200, { v: r.v, data: r.data, n: r.clients.size });

    if (req.method === 'GET' && sub === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      r.clients.add(res);
      send(res, { type: 'hello', v: r.v, n: r.clients.size });
      presence(r);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(hb); r.clients.delete(res); presence(r); });
      return;
    }

    if (req.method === 'PUT' && !sub) {
      const b = await body(req);
      if (!b || typeof b.data !== 'object') return json(res, 400, { error: 'data required' });
      // ifEmpty: only the first laptop may seed a room; later ones get 409 + the room's data and merge instead
      if (b.ifEmpty && r.data && Object.keys(r.data).length) return json(res, 409, { v: r.v, data: r.data });
      if (process.env.DEBUG_OPS) console.log('PUT', id, b.client, b.ifEmpty);
      r.data = b.data; r.v++;
      broadcast(r, { type: 'replace', v: r.v, data: r.data, client: b.client || '' });
      persist(id, r);
      return json(res, 200, { v: r.v });
    }

    if (req.method === 'POST' && sub === 'join') {
      const b = await body(req);
      if (!b || !isObj(b.data)) return json(res, 400, { error: 'data required' });
      const before = JSON.stringify(r.data || null);
      r.data = isEmptyV(r.data) ? clone(b.data) : unionLists(fillMerge(r.data, b.data), r.data, b.data);
      if (JSON.stringify(r.data) !== before) {
        r.v++;
        if (process.env.DEBUG_OPS) console.log('JOIN changed', id, b.client);
        broadcast(r, { type: 'replace', v: r.v, data: r.data, client: b.client || '' });
        persist(id, r);
      }
      return json(res, 200, { v: r.v, data: r.data });
    }

    if (req.method === 'POST' && sub === 'patch') {
      const b = await body(req);
      if (!Array.isArray(b.ops)) return json(res, 400, { error: 'ops required' });
      if (!r.data) r.data = {};
      if (process.env.DEBUG_OPS) console.log('PATCH', id, b.client, JSON.stringify(b.ops).slice(0,300));
      const applied = b.ops.filter(op => op && typeof op.p === 'string' && setPath(r.data, op.p, op.v));
      r.v++;
      broadcast(r, { type: 'patch', v: r.v, ops: applied, client: b.client || '' });
      persist(id, r);
      return json(res, 200, { v: r.v });
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  json(res, 405, { error: 'method not allowed' });
}).listen(PORT, () => console.log('film393 sync listening on', PORT, 'data', DATA_DIR))
  // Can't serve at all (port taken): exit so Railway restarts it, rather than the handlers below keeping it alive.
  .on('error', e => { console.error('server error', e.message); process.exit(1); });

// Any other stray error would otherwise kill the process: every group's live connection drops, edits still on the
// 800ms save timer are lost, and Railway emails "Deployment crashed". Log it and keep serving, as the CFA bots do.
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.stack || e));

// A deploy stops the old container with SIGTERM. Without a handler node died by the signal, npm exited non-zero, and
// Railway (volume = no overlap) emailed "Deployment crashed" (9/29). It also dropped any edit still on persist()'s
// 800ms timer. Write those now, synchronously, close the SSE streams (clients rejoin the new container), exit 0.
process.on('SIGTERM', () => {
  let saved = 0;
  for (const [id, r] of rooms) {
    if (!r.saveT) continue;
    clearTimeout(r.saveT);
    const f = path.join(DATA_DIR, id + '.json');
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify({ v: r.v, data: r.data, savedAt: new Date().toISOString() }));
      fs.renameSync(f + '.tmp', f);
      saved++;
    } catch (e) { console.error('save on SIGTERM', id, e.message); }
  }
  for (const r of rooms.values()) for (const c of r.clients) { try { c.end(); } catch { /* already gone */ } }
  console.log('SIGTERM: saved', saved, 'room(s); exiting');
  process.exit(0);
});
