import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveSync, mergeDeviceDocuments, applyOperations, parseDeviceDocument, nextStamp, DriveSyncError } from '../web/drive-sync.js';

/** In-memory Drive appDataFolder + Google endpoints. */
function fakeGoogle({ pageSize = 1000, user = { sub: 'u1', email: 'a@b.c', name: 'A' } } = {}) {
  const files = new Map(); let seq = 0; const log = []; const failures = [];
  const res = (status, body, text) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => text ?? JSON.stringify(body) });
  async function fetchImpl(url, init = {}) {
    const f = failures.shift(); if (f) return f(url, init);
    const u = new URL(url); const method = init.method || 'GET'; log.push(`${method} ${u.pathname}`);
    if (u.host === 'openidconnect.googleapis.com') return res(200, user);
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q'); let list = [...files.values()];
      const m = q.match(/name contains '(.*)'/); const e = q.match(/name = '(.*)'/);
      if (m) list = list.filter((x) => x.name.includes(m[1])); if (e) list = list.filter((x) => x.name === e[1]);
      const start = Number(u.searchParams.get('pageToken') || 0); const page = list.slice(start, start + pageSize);
      return res(200, { files: page.map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime })), nextPageToken: start + pageSize < list.length ? String(start + pageSize) : undefined });
    }
    const id = decodeURIComponent(u.pathname.split('/').pop());
    if (u.pathname.startsWith('/drive/v3/files/') && method === 'GET') { const x = files.get(id); return x ? res(200, null, x.body) : res(404, {}); }
    if (u.pathname.startsWith('/drive/v3/files/') && method === 'DELETE') { files.delete(id); return res(204, {}); }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') { const x = files.get(id); if (!x) return res(404, {}); x.body = init.body; x.modifiedTime = new Date(++seq * 1000).toISOString(); return res(200, { id }); }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body.split('\r\n')[3]); const body = init.body.split('\r\n')[7]; const nid = `f${++seq}`;
      files.set(nid, { id: nid, name: meta.name, body, modifiedTime: new Date(seq * 1000).toISOString() }); return res(200, { id: nid });
    }
    return res(500, {});
  }
  return { fetchImpl, files, log, failures };
}
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const gisStub = (expiresIn = 3600) => ({ accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() { this.callback({ access_token: 'tok', expires_in: expiresIn }); } }), revoke: (t, cb) => cb() } } });
function client(google, over = {}) {
  let t = 1_000_000; const clock = { now: () => t, advance: (ms) => { t += ms; } };
  let n = 0;
  const api = createDriveSync({ clientId: 'cid', fetchImpl: google.fetchImpl, loadGis: async () => gisStub(over.expiresIn), storage: store(), tabStorage: store(), now: clock.now, newDeviceId: () => over.device || `dev${++n}`, withLock: (f) => f(), persistDeviceId: true, flushDelayMs: 0, sleep: async () => {}, random: () => 0, ...over.deps });
  return { api, clock };
}
const sk = (id, updated, name = id) => ({ id, name, updated, shapes: [] });

test('merge: newest wins, tie goes to higher device, deletes become tombstones', () => {
  const a = { device: 'a', records: { s1: { item: sk('s1', 1, 'old'), at: 10 }, s2: { item: sk('s2', 1), at: 10 } } };
  const b = { device: 'b', records: { s1: { item: sk('s1', 2, 'new'), at: 20 }, s2: { item: null, at: 20 } } };
  const m = mergeDeviceDocuments([a, b]);
  assert.deepEqual(m.items.map((i) => i.name), ['new']);
  assert.deepEqual(m.deletedIds, ['s2']);
  const tie = mergeDeviceDocuments([{ device: 'a', records: { x: { item: { id: 'x', v: 'a' }, at: 5 } } }, { device: 'b', records: { x: { item: { id: 'x', v: 'b' }, at: 5 } } }]);
  assert.equal(tie.items[0].v, 'b');
});
test('nextStamp never goes behind what was already seen (slow clock)', () => { assert.equal(nextStamp(100, 500), 501); assert.equal(nextStamp(900, 500), 900); });
test('parse rejects corrupt and newer files instead of treating them as empty', () => {
  assert.throws(() => parseDeviceDocument({ nope: 1 }), (e) => e.code === 'corrupt-file');
  assert.throws(() => parseDeviceDocument({ version: 9, device: 'x' }), (e) => e.code === 'unsupported-version');
  assert.deepEqual(parseDeviceDocument({ version: 1, device: 'x', records: { a: { at: 1, item: { id: 'a' } }, bad: { at: 'x' } } }).records, { a: { at: 1, item: { id: 'a' } } });
});
test('applyOperations is pure and keeps deletes as tombstones', () => {
  const doc = { version: 1, device: 'd', records: {} };
  const next = applyOperations(doc, [{ type: 'upsert', item: sk('s1', 1) }, { type: 'delete', id: 's2' }], 7);
  assert.deepEqual(doc.records, {}); assert.equal(next.records.s2.item, null); assert.equal(next.records.s1.at, 7);
});

test('sign in, write, and read back through a second device (one file per device)', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' }); const B = client(g, { device: 'B' });
  await A.api.signIn(); await B.api.signIn();
  await A.api.upsert(sk('s1', 1, 'from A')); await B.api.upsert(sk('s2', 1, 'from B'));
  assert.equal(g.files.size, 2);
  const seen = await A.api.loadAll(); assert.deepEqual(seen.items.map((i) => i.name).sort(), ['from A', 'from B']);
});
test('a delete reaches the other device as a tombstone and wins over the older copy', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' }); const B = client(g, { device: 'B' });
  await A.api.signIn(); await B.api.signIn();
  await A.api.upsert(sk('s1', 1)); A.clock.advance(5000);
  await B.api.remove('s1');
  const m = await A.api.loadAll(); assert.deepEqual(m.items, []); assert.deepEqual(m.deletedIds, ['s1']);
});
test('a device with a slow clock still wins with a later edit', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A', expiresIn: 100000 }); const B = client(g, { device: 'B' });
  await A.api.signIn(); await B.api.signIn();
  A.clock.advance(10_000_000); await A.api.upsert(sk('s1', 1, 'first'));
  await B.api.loadAll(); await B.api.upsert(sk('s1', 2, 'second from slow clock'));
  assert.equal((await A.api.loadAll()).items[0].name, 'second from slow clock');
});
test('listing follows pagination', async () => {
  const g = fakeGoogle({ pageSize: 2 }); const A = client(g, { device: 'A' });
  await A.api.signIn();
  for (let i = 0; i < 5; i += 1) g.files.set(`x${i}`, { id: `x${i}`, name: `sirtuti-d${i}.json`, modifiedTime: '2026-01-01T00:00:00Z', body: JSON.stringify({ version: 1, device: `d${i}`, records: { [`s${i}`]: { at: 1, item: sk(`s${i}`, 1) } } }) });
  assert.equal((await A.api.loadAll()).items.length, 5);
});
test('a corrupt or newer file is skipped', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' });
  await A.api.signIn(); await A.api.upsert(sk('s1', 1));
  g.files.set('bad', { id: 'bad', name: 'sirtuti-bad.json', modifiedTime: '2026-01-01T00:00:00Z', body: 'not json' });
  g.files.set('new', { id: 'new', name: 'sirtuti-new.json', modifiedTime: '2026-01-01T00:00:00Z', body: JSON.stringify({ version: 99, device: 'n' }) });
  assert.equal((await A.api.loadAll()).items.length, 1);
});
test('a transient read error fails the whole read instead of merging without that device', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' });
  await A.api.signIn(); await A.api.upsert(sk('s1', 1));
  const orig = g.fetchImpl; let hit = false;
  const flaky = { ...g, fetchImpl: async (url, init) => { if (!hit && url.includes('alt=media')) { hit = true; return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => '' }; } return orig(url, init); } };
  const C = client(flaky, { device: 'C' }); await C.api.signIn();
  await assert.rejects(C.api.loadAll(), (e) => e.status === 403);
});
test('a corrupt own file is left in place and writing continues in a new file', async () => {
  const g = fakeGoogle(); let n = 0; const A = client(g, { device: undefined, deps: { newDeviceId: () => `dev-${++n}` } });
  await A.api.signIn(); await A.api.upsert(sk('s1', 1));
  [...g.files.values()][0].body = 'garbage';
  await A.api.upsert(sk('s2', 1));
  assert.equal(g.files.size, 2); assert.equal([...g.files.values()][0].body, 'garbage');
  assert.deepEqual((await A.api.loadAll()).items.map((i) => i.id), ['s2']);
});
test('429 and 5xx on reads are retried; a 5xx on file creation is not', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' }); await A.api.signIn();
  const orig = g.fetchImpl; let n = 0;
  const flaky = { ...g, fetchImpl: async (url, init) => { if (url.includes('/drive/v3/files?') && n++ < 2) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' }; return orig(url, init); } };
  const B = client(flaky, { device: 'B' }); await B.api.signIn();
  assert.deepEqual((await B.api.loadAll()).items, []); assert.ok(n >= 3);
  const g3 = fakeGoogle(); const o3 = g3.fetchImpl; let posts = 0;
  const bad = { ...g3, fetchImpl: async (url, init) => { if (init && init.method === 'POST') { posts++; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '' }; } return o3(url, init); } };
  const C = client(bad, { device: 'C' }); await C.api.signIn();
  await assert.rejects(C.api.upsert(sk('s1', 1)), (e) => e.status === 503); assert.equal(posts, 1);
});
test('an expired token reports signed out once and never opens a popup in the background', async () => {
  const g = fakeGoogle(); const { api, clock } = client(g, { device: 'A', expiresIn: 3600 });
  const seen = []; api.onAuthChange((u) => seen.push(u && u.uid));
  await api.signIn(); assert.deepEqual(seen, [null, 'u1']);
  clock.advance(3600 * 1000);
  await assert.rejects(api.loadAll(), (e) => e.code === 'signed-out');
  assert.deepEqual(seen, [null, 'u1', null]);
});
test('a token swap for the same user does not re-notify listeners', async () => {
  const g = fakeGoogle(); const { api } = client(g, { device: 'A' }); const seen = [];
  api.onAuthChange((u) => seen.push(u && u.uid)); await api.signIn(); await api.signIn();
  assert.deepEqual(seen, [null, 'u1']);
});
test('offline is reported as offline, not as a sign-out', async () => {
  const g = fakeGoogle(); const { api } = client(g, { device: 'A', deps: { isOnline: () => false } });
  await api.signIn();
  const off = client({ fetchImpl: async () => { throw new TypeError('network'); } }, { device: 'B' });
  await assert.rejects(off.api.signIn(), (e) => e.code === 'offline');
});
test('two tabs without Web Locks keep separate device ids (separate files)', async () => {
  const g = fakeGoogle(); const shared = store(); let n = 0;
  const mk = () => createDriveSync({ clientId: 'c', fetchImpl: g.fetchImpl, loadGis: async () => gisStub(), storage: shared, tabStorage: store(), now: () => 1, newDeviceId: () => `t${++n}`, withLock: (f) => f(), persistDeviceId: false, flushDelayMs: 0, sleep: async () => {} });
  const a = mk(), b = mk(); await a.signIn(); await b.signIn();
  await a.upsert(sk('s1', 1)); await b.upsert(sk('s2', 1)); assert.equal(g.files.size, 2);
});
test('deleteAllSyncedData removes every sync file, revokes access and signs out', async () => {
  const g = fakeGoogle(); const A = client(g, { device: 'A' }); const B = client(g, { device: 'B' });
  await A.api.signIn(); await B.api.signIn(); await A.api.upsert(sk('s1', 1)); await B.api.upsert(sk('s2', 1));
  g.files.set('other', { id: 'other', name: 'unrelated.json', modifiedTime: 'x', body: '{}' });
  await A.api.deleteAllSyncedData();
  assert.deepEqual([...g.files.keys()], ['other']); assert.equal(A.api.user(), null);
  await assert.rejects(A.api.upsert(sk('s3', 1)), (e) => e.code === 'signed-out');
});
test('sign-out cancels queued writes so they are never sent', async () => {
  const g = fakeGoogle(); const { api } = client(g, { device: 'A', deps: { flushDelayMs: 50 } });
  await api.signIn(); const p = api.upsert(sk('s1', 1)); await api.signOut();
  await assert.rejects(p, (e) => e.code === 'signed-out'); assert.equal(g.files.size, 0);
});
test('sign-in is refused when no client id is configured', async () => {
  const { api } = client(fakeGoogle(), { deps: { clientId: '' } });
  const off = createDriveSync({ clientId: '', fetchImpl: async () => { throw new Error('no'); } });
  await assert.rejects(off.signIn(), (e) => e instanceof DriveSyncError && e.code === 'not-configured'); assert.equal(off.isConfigured(), false); void api;
});
