/* Optional sync of sketches to the user's own Google Drive.
 *
 * Data lives in the Drive appDataFolder: a hidden folder that only this OAuth client can read. The
 * browser talks to Google directly; there is no Sirtuti server, so the operator has no copy of anyone's
 * sketches.
 *
 * Each device writes only its own file (sirtuti-<deviceId>.json) and reads all of them, keeping the newest
 * version of each record. Drive v3 has no conditional write, so a single shared file would let two devices
 * silently overwrite each other; with one writer per file there is nothing to overwrite.
 *
 * Ported from the KanDOne reference implementation (src/driveSync.js), without the Android native-auth path
 * and the idle-file compaction. Plain ES module with injected dependencies, so it runs under node --test. */

const FILE_PREFIX = 'sirtuti-';
const DOCUMENT_VERSION = 1;
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email profile';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const LOCK_NAME = 'sirtuti-drive-write';
const SESSION_KEY = 'sirtuti.drive.session';
const DEVICE_KEY = 'sirtuti.drive.device';
const TOKEN_EXPIRY_MARGIN_MS = 60000;
const DEFAULT_FLUSH_DELAY_MS = 1500;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DOWNLOAD_CONCURRENCY = 4;

export class DriveSyncError extends Error {
  constructor(message, { status = 0, code = '', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DriveSyncError';
    this.status = status;
    this.code = code;
  }
}

const offlineError = (cause) => new DriveSyncError('Cannot reach Google Drive.', { code: 'offline', cause });
/** Errors that retrying will not fix, so the file is skipped rather than failing the whole read. */
const isPermanentlyUnreadable = (err) => err?.status === 404 || err?.code === 'corrupt-file' || err?.code === 'unsupported-version';
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const emptyDocument = (device) => ({ version: DOCUMENT_VERSION, device, records: {} });
const isRecordEntry = (e) => isPlainObject(e) && Number.isFinite(e.at) && (e.item === null || isPlainObject(e.item));

/** Validate one device file. Throws instead of returning an empty document: an unreadable file treated as empty would be overwritten. */
export function parseDeviceDocument(raw) {
  if (!isPlainObject(raw) || typeof raw.device !== 'string') {
    throw new DriveSyncError('Drive sync file is not in the expected format.', { code: 'corrupt-file' });
  }
  if (raw.version !== DOCUMENT_VERSION) {
    throw new DriveSyncError('Drive sync file was written by a newer Sirtuti. Update the app.', { code: 'unsupported-version' });
  }
  const records = isPlainObject(raw.records)
    ? Object.fromEntries(Object.entries(raw.records).filter(([, e]) => isRecordEntry(e)))
    : {};
  return { version: DOCUMENT_VERSION, device: raw.device, records };
}

/** Apply queued writes to this device's own document, stamping each with `at`. Deletes stay as tombstones (item: null). */
export function applyOperations(document, operations, at) {
  const records = { ...document.records };
  for (const op of operations) {
    if (op.type === 'upsert') records[String(op.item.id)] = { item: op.item, at };
    else records[String(op.id)] = { item: null, at };
  }
  return { ...document, records };
}

/** Newest entry wins; a tie goes to the higher device id so every reader agrees. */
function newer(current, candidate) {
  if (!current) return candidate;
  if (candidate.at !== current.at) return candidate.at > current.at ? candidate : current;
  return candidate.device > current.device ? candidate : current;
}

const latestStamp = (document) => Math.max(0, ...Object.values(document.records).map((e) => e.at));

/** Stamp for the next write: the wall clock, but never earlier than anything already read (a slow clock would lose every edit). */
export const nextStamp = (now, latestSeen) => Math.max(now, latestSeen + 1);

/** Merge every device's file: the live records, plus the ids whose newest entry is a delete. */
export function mergeDeviceDocuments(documents) {
  const best = {};
  for (const doc of documents) {
    for (const [id, entry] of Object.entries(doc.records)) best[id] = newer(best[id], { ...entry, device: doc.device });
  }
  const entries = Object.entries(best);
  return {
    items: entries.filter(([, e]) => e.item !== null).map(([, e]) => e.item),
    deletedIds: entries.filter(([, e]) => e.item === null).map(([id]) => id),
  };
}

function readJson(storage, key) {
  try { const raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function writeJson(storage, key, value) {
  try { if (value === null) storage && storage.removeItem(key); else storage && storage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked or full */ }
}
function browserStorage(kind = 'localStorage') {
  try { return typeof window !== 'undefined' ? window[kind] : null; } catch (e) { return null; }
}
function loadGisScript() {
  if (typeof window === 'undefined') return Promise.reject(new DriveSyncError('Google sign-in needs a browser.', { code: 'gis-load-failed' }));
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new DriveSyncError('Could not load Google sign-in.', { code: 'gis-load-failed' }));
    document.head.appendChild(s);
  });
}
const hasWebLocks = () => typeof navigator !== 'undefined' && Boolean(navigator.locks && navigator.locks.request);
const withBrowserLock = (task) => (hasWebLocks() ? navigator.locks.request(LOCK_NAME, task) : task());

async function settleWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next; next += 1;
      try { results[index] = { status: 'fulfilled', value: await task(items[index]) }; } catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * @param {object} deps injected so tests run without network, Google's script, timers or real storage.
 * @param {string} deps.clientId OAuth Web client ID; empty disables sync.
 */
export function createDriveSync({
  clientId,
  fetchImpl = (...a) => fetch(...a),
  loadGis = loadGisScript,
  storage = browserStorage(),
  tabStorage = browserStorage('sessionStorage'),
  now = () => Date.now(),
  newDeviceId = () => crypto.randomUUID(),
  withLock = withBrowserLock,
  persistDeviceId = hasWebLocks(),
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  random = Math.random,
  isOnline = () => !(typeof navigator !== 'undefined' && navigator.onLine === false),
} = {}) {
  let session = readJson(storage, SESSION_KEY);
  let gis = null; let gisLoading = null; let tokenClient = null;
  let pendingTokenRequest = null; let expiryTimer = null;
  const listeners = new Set();
  let queue = []; let flushTimer = null; let flushChain = Promise.resolve();
  let ownFileId = null; let latestSeenAt = 0;
  const documentCache = new Map();
  let writeEpoch = 0; let readInFlight = null;
  let device = null;
  const deviceStorage = persistDeviceId ? storage : tabStorage;

  const isConfigured = () => Boolean(clientId);
  const hasValidToken = () => Boolean(session && session.accessToken && session.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now());
  const currentUser = () => (hasValidToken() ? session.user : null);

  function deviceId() {
    if (device) return device;
    device = readJson(deviceStorage, DEVICE_KEY) || newDeviceId();
    writeJson(deviceStorage, DEVICE_KEY, device);
    return device;
  }
  /** Leave an unreadable own file where it is (readers skip it) and continue in a new one; refusing to write forever would strand every later edit. */
  function abandonOwnFile() {
    device = null; writeJson(deviceStorage, DEVICE_KEY, null); ownFileId = null; documentCache.clear();
    return emptyDocument(deviceId());
  }
  const ownFileName = () => `${FILE_PREFIX}${deviceId()}.json`;

  let lastReportedUid = currentUser() ? currentUser().uid : null;
  /** Report only a change of who is connected: a token swap for the same user is not one. */
  function notifyListeners() {
    const user = currentUser();
    const uid = user ? user.uid : null;
    if (uid === lastReportedUid) return;
    lastReportedUid = uid;
    for (const l of listeners) l(user);
  }
  function scheduleExpiryNotice() {
    clearTimeout(expiryTimer);
    if (!hasValidToken()) return;
    expiryTimer = setTimeout(notifyListeners, Math.min(2147483647, session.expiresAt - TOKEN_EXPIRY_MARGIN_MS - now()));
    if (expiryTimer && expiryTimer.unref) expiryTimer.unref();   // Node (tests): do not keep the process alive
  }
  function setSession(next) {
    session = next; writeJson(storage, SESSION_KEY, next); scheduleExpiryNotice(); notifyListeners();
  }
  const expiredSession = () => ({ ...session, accessToken: null, expiresAt: 0 });

  function ensureGis() {
    if (gis) return Promise.resolve(gis);
    gisLoading = gisLoading || loadGis().then((g) => { gis = g; return gis; }).catch((err) => { gisLoading = null; throw err; });
    return gisLoading;
  }
  function getTokenClient() {
    tokenClient = tokenClient || gis.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPES, callback: () => {} });
    return tokenClient;
  }
  /** Opens the popup synchronously when GIS is already loaded, inside the click that called it; later and the browser blocks it. */
  function requestToken() {
    if (pendingTokenRequest) return pendingTokenRequest;
    const run = (loaded) => new Promise((resolve, reject) => {
      gis = loaded;
      const client = getTokenClient();
      client.callback = (response) => {
        if (response.error) reject(new DriveSyncError(response.error_description || response.error, { code: response.error }));
        else if (!response.access_token) reject(new DriveSyncError('Google did not grant access to Drive.', { code: 'access_denied' }));
        else resolve(response);
      };
      client.error_callback = (err) => reject(new DriveSyncError((err && err.message) || 'Google sign-in was closed.', { code: (err && err.type) || 'popup_closed' }));
      client.requestAccessToken({ prompt: '', login_hint: (session && session.user && session.user.email) || '' });
    });
    pendingTokenRequest = (gis ? run(gis) : ensureGis().then(run)).finally(() => { pendingTokenRequest = null; });
    return pendingTokenRequest;
  }
  async function fetchUser(accessToken) {
    const res = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } }).catch((err) => { throw offlineError(err); });
    if (!res.ok) throw new DriveSyncError('Could not read the Google account.', { status: res.status });
    const info = await res.json();
    return { uid: info.sub, email: info.email || '', displayName: info.name || '' };
  }
  async function signIn() {
    if (!isConfigured()) throw new DriveSyncError('Google Drive sync is not configured.', { code: 'not-configured' });
    const response = await requestToken();
    const user = await fetchUser(response.access_token);
    if (!session || !session.user || session.user.uid !== user.uid) { ownFileId = null; documentCache.clear(); latestSeenAt = 0; }
    setSession({ accessToken: response.access_token, expiresAt: now() + Number(response.expires_in) * 1000, user });
    return user;
  }
  /** Never opens a popup (a background save is not a click). An expired token reports "signed out" and the caller offers to reconnect. */
  async function accessToken() {
    if (hasValidToken()) return session.accessToken;
    if (!isOnline()) throw offlineError();
    if (session && session.accessToken) setSession(expiredSession());
    throw new DriveSyncError('Google Drive session expired.', { code: 'signed-out' });
  }

  /** A 429 refused the request, so any request may repeat. A 5xx may have been applied, and repeating a file creation could leave two files. */
  const worthRetrying = (status, method) => RETRYABLE_STATUSES.has(status) && (status === 429 || (method || 'GET') !== 'POST');
  function retryDelayMs(attempt, res) {
    const asked = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
    const backoff = RETRY_BASE_MS * 2 ** attempt * (0.5 + random());
    return Math.min(RETRY_MAX_MS, Math.max(backoff, Number.isFinite(asked) ? asked * 1000 : 0));
  }
  async function driveFetch(url, init = {}, attempt = 0) {
    const token = await accessToken();
    const res = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }).catch((err) => { throw offlineError(err); });
    if (res.status === 401 && session) setSession(expiredSession());
    if (!res.ok && attempt < MAX_ATTEMPTS - 1 && worthRetrying(res.status, init.method)) {
      await sleep(retryDelayMs(attempt, res));
      return driveFetch(url, init, attempt + 1);
    }
    if (!res.ok) throw new DriveSyncError(`Google Drive request failed (${res.status}).`, { status: res.status });
    return res;
  }
  async function listFiles(query, pageToken = '') {
    const params = new URLSearchParams({ spaces: 'appDataFolder', q: query, fields: 'nextPageToken,files(id,name,modifiedTime)', pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await (await driveFetch(`${DRIVE_API}/files?${params}`)).json();
    const files = page.files || [];
    return page.nextPageToken ? [...files, ...await listFiles(query, page.nextPageToken)] : files;
  }
  async function readFile(id) {
    const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
    // Read the body first: a connection dropped mid-download is a network error, not a corrupt file.
    const text = await res.text().catch((err) => { throw offlineError(err); });
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new DriveSyncError('Drive sync file is not valid JSON.', { code: 'corrupt-file' }); }
    const document = parseDeviceDocument(raw);
    return document;
  }
  async function readFileUnlessUnchanged(file) {
    const cached = documentCache.get(file.id);
    if (file.modifiedTime && cached && cached.modifiedTime === file.modifiedTime) return cached.document;
    const document = await readFile(file.id);
    if (file.modifiedTime) documentCache.set(file.id, { modifiedTime: file.modifiedTime, document });
    return document;
  }
  /** Every device's file, merged. Unreadable files are skipped; any other failure (network, rate limit, auth) fails the read, because a merge missing a device's newer edits would let this device re-upload stale copies. */
  async function readMergedFresh() {
    const files = (await listFiles(`name contains '${FILE_PREFIX}'`)).filter((f) => f.name.startsWith(FILE_PREFIX) && f.name.endsWith('.json'));
    const listed = new Set(files.map((f) => f.id));
    for (const id of documentCache.keys()) if (!listed.has(id)) documentCache.delete(id);
    const results = await settleWithConcurrency(files, DOWNLOAD_CONCURRENCY, readFileUnlessUnchanged);
    const fatal = results.find((r) => r.status === 'rejected' && !isPermanentlyUnreadable(r.reason));
    if (fatal) throw fatal.reason;
    const documents = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    latestSeenAt = Math.max(latestSeenAt, ...documents.map(latestStamp));
    return mergeDeviceDocuments(documents);
  }
  /** Concurrent callers share one read; a read started before an upload is never handed to a caller that asked after it. */
  function readMerged() {
    if (!readInFlight || readInFlight.epoch !== writeEpoch) {
      const entry = { epoch: writeEpoch };
      entry.promise = readMergedFresh().finally(() => { if (readInFlight === entry) readInFlight = null; });
      readInFlight = entry;
    }
    return readInFlight.promise;
  }
  async function readOwnDocument() {
    if (!ownFileId) {
      const [file] = await listFiles(`name = '${ownFileName()}'`);
      ownFileId = file ? file.id : null;
    }
    if (!ownFileId) return emptyDocument(deviceId());
    try {
      const own = await readFile(ownFileId);
      latestSeenAt = Math.max(latestSeenAt, latestStamp(own));
      return own;
    } catch (err) {
      if (err.code === 'corrupt-file') return abandonOwnFile();
      if (err.status !== 404) throw err;
      ownFileId = null;            // deleted from Drive's "Manage apps": start a new file
      return emptyDocument(deviceId());
    }
  }
  async function writeOwnDocument(document) {
    const body = JSON.stringify(document);
    writeEpoch += 1;
    if (ownFileId) {
      documentCache.delete(ownFileId);
      await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(ownFileId)}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      writeEpoch += 1;
      return;
    }
    const boundary = `sirtuti-${now()}`;
    const metadata = JSON.stringify({ name: ownFileName(), parents: ['appDataFolder'] });
    const multipart = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', metadata, `--${boundary}`, 'Content-Type: application/json', '', body, `--${boundary}--`, ''].join('\r\n');
    const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    ownFileId = (await res.json()).id;
    writeEpoch += 1;
  }
  async function flush() {
    flushTimer = null;
    const batch = queue; queue = [];
    if (!batch.length) return;
    try {
      await withLock(async () => {
        const own = await readOwnDocument();   // re-read under the lock: another tab shares the file
        const at = nextStamp(now(), latestSeenAt);
        await writeOwnDocument(applyOperations(own, batch.map((e) => e.op), at));
        latestSeenAt = at;
      });
      for (const e of batch) e.resolve();
    } catch (err) { for (const e of batch) e.reject(err); }
  }
  function enqueue(op) {
    if (!session) return Promise.reject(new DriveSyncError('Not connected to Google Drive.', { code: 'signed-out' }));
    return new Promise((resolve, reject) => {
      queue.push({ op, resolve, reject });
      if (!flushTimer) flushTimer = setTimeout(() => { flushChain = flushChain.then(flush); }, flushDelayMs);
    });
  }
  function dropQueuedWrites() {
    clearTimeout(flushTimer); flushTimer = null;
    const dropped = queue; queue = [];
    for (const e of dropped) e.reject(new DriveSyncError('Signed out before sync.', { code: 'signed-out' }));
  }
  function endSession() {
    dropQueuedWrites(); ownFileId = null; latestSeenAt = 0; documentCache.clear(); writeEpoch += 1;
    setSession(null);
  }

  return {
    isConfigured,
    hasSession: () => hasValidToken(),
    user: currentUser,
    /** Reports the connected user on subscribing, then on every change. */
    onAuthChange(callback) {
      listeners.add(callback); scheduleExpiryNotice();
      const user = isConfigured() ? currentUser() : null;
      lastReportedUid = user ? user.uid : null;
      callback(user);
      return () => listeners.delete(callback);
    },
    /** Start loading Google's script so a following click can open the popup synchronously. */
    preload: () => (isConfigured() ? ensureGis().catch(() => {}) : Promise.resolve()),
    signIn,
    signOut: async () => { endSession(); },
    /** Delete every Sirtuti sync file from the user's Drive and revoke this app's access, then sign out. Google must be reachable before anything is deleted. */
    async deleteAllSyncedData() {
      if (!session || !session.user) throw new DriveSyncError('Not connected to Google Drive.', { code: 'signed-out' });
      const loaded = await ensureGis();
      const revoke = (token) => new Promise((resolve) => loaded.accounts.oauth2.revoke(token, resolve));
      await accessToken();
      dropQueuedWrites();
      await flushChain;
      const files = (await listFiles(`name contains '${FILE_PREFIX}'`)).filter((f) => f.name.startsWith(FILE_PREFIX) && f.name.endsWith('.json'));
      await Promise.all(files.map((f) => driveFetch(`${DRIVE_API}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' })));
      await revoke(session.accessToken);
      endSession();
    },
    /** Live records and the ids whose newest version is a delete. */
    loadAll: readMerged,
    upsert: (item) => enqueue({ type: 'upsert', item }),
    remove: (id) => enqueue({ type: 'delete', id }),
    /** Resolves once everything queued so far has landed in Drive. */
    flushed: async () => { if (flushTimer) { clearTimeout(flushTimer); flushChain = flushChain.then(flush); } await flushChain; },
  };
}

/** Which message code to show for a failed "Connect". */
export function signInErrorCode(err) {
  const code = (err && err.code) || '';
  if (code === 'popup_failed_to_open') return 'popup-blocked';
  if (code === 'popup_closed' || code === 'access_denied') return 'cancelled';
  if (code === 'gis-load-failed' || code === 'offline') return 'offline';
  if (code === 'not-configured') return 'not-configured';
  return 'failed';
}
