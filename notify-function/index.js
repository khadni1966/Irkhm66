// Khedni notification service (Cloud Run function, HTTP). The app calls it right after an action;
// it checks who is asking, works out who should hear about it, and sends a phone notification.
// Self-contained: needs only @google-cloud/functions-framework (already in the default package.json),
// and works whether the project is set up as CommonJS or as an ES module.
const req0 = process.getBuiltinModule('node:module').createRequire(process.cwd() + '/');
const functions = req0('@google-cloud/functions-framework');
const crypto = process.getBuiltinModule('node:crypto');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'khedni-df08b';
const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
const ORIGINS = ['https://khedni.app', 'https://www.khedni.app', 'https://khadni1966.github.io'];
const REACH = 5000, SLACK = 90 * 60000;

// ---- Google access token for this service (Firestore + FCM) ----
let tok = { v: '', exp: 0 };
async function gtoken() {
  if (tok.v && Date.now() < tok.exp - 60000) return tok.v;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.v;
}
async function api(url, opt) {
  opt = opt || {};
  const r = await fetch(url, { method: opt.method || 'GET', headers: { Authorization: 'Bearer ' + await gtoken(), 'Content-Type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}

// ---- Firebase sign-in check (ID token sent by the app) ----
let certs = { m: null, exp: 0 };
async function getCerts() {
  if (certs.m && Date.now() < certs.exp) return certs.m;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const cc = r.headers.get('cache-control') || '', m = /max-age=(\d+)/.exec(cc);
  certs = { m: await r.json(), exp: Date.now() + (m ? +m[1] : 3600) * 1000 };
  return certs.m;
}
function b64(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
async function verifyIdToken(t) {
  const p = String(t || '').split('.');
  if (p.length !== 3) throw new Error('bad token');
  const h = JSON.parse(b64(p[0]).toString()), c = JSON.parse(b64(p[1]).toString());
  if (h.alg !== 'RS256') throw new Error('alg');
  const pem = (await getCerts())[h.kid];
  if (!pem) throw new Error('kid');
  const ok = crypto.createVerify('RSA-SHA256').update(p[0] + '.' + p[1]).verify(crypto.createPublicKey(pem), b64(p[2]));
  const now = Date.now() / 1000;
  if (!ok || c.aud !== PROJECT || c.iss !== 'https://securetoken.google.com/' + PROJECT || !c.sub || c.exp < now || c.iat > now + 300) throw new Error('invalid');
  return c.sub;
}

// ---- Firestore REST helpers ----
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return fields(v.mapValue.fields);
  if ('geoPointValue' in v) return { lat: v.geoPointValue.latitude, lng: v.geoPointValue.longitude };
  return null;
}
function fields(f) { const o = {}; for (const k in (f || {})) o[k] = val(f[k]); return o; }
async function getDoc(path) {
  const r = await api(FS + '/' + path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('read ' + path + ' ' + r.status);
  return fields(r.j.fields);
}
async function openRides() {
  const r = await api(FS + ':runQuery', { method: 'POST', body: { structuredQuery: { from: [{ collectionId: 'rides' }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'open' } } } } } });
  if (!r.ok) throw new Error('rides ' + r.status);
  return (r.j || []).filter(x => x.document).map(x => fields(x.document.fields));
}

// ---- route maths ----
function decode(s) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let r = 0, sh = 0, b;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const v = r & 1 ? ~(r >> 1) : r >> 1;
      if (k === 0) lat += v; else lng += v;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}
function hav(a, b) {
  const R = 6371000, t = Math.PI / 180, dl = (b.lat - a.lat) * t, dg = (b.lng - a.lng) * t;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// nearest point on the route: distance to it, and how far along the route it is
function near(path, p) {
  const kx = Math.cos(p.lat * Math.PI / 180) * 111320, ky = 110540;
  let best = { d: 1e12, c: 0 }, cum = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], seg = hav(a, b);
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? -(ax * dx + ay * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, c: cum + t * seg };
    cum += seg;
  }
  best.total = cum || 1;
  return best;
}
function area(t) { const p = String(t || '').split('،'); return (p[p.length - 1] || '').trim() || t; }

// ---- send a phone notification to every device of one user ----
async function send(uid, title, body, tag) {
  const d = await getDoc('tokens/' + uid);
  const t = (d && d.t) || [];
  if (!t.length) return 0;
  let n = 0; const bad = [];
  for (const token of t) {
    const r = await api('https://fcm.googleapis.com/v1/projects/' + PROJECT + '/messages:send', { method: 'POST', body: { message: {
      token, data: { title, body, url: 'https://khedni.app/', tag: tag || '' },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    } } });
    if (r.ok) n++;
    else {
      const e = JSON.stringify(r.j || '');
      if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(e)) bad.push(token);
      else console.error('fcm', r.status, e);
    }
  }
  if (bad.length) await api(FS.replace(/\/documents$/, '/documents:commit'), { method: 'POST', body: { writes: [{ transform: {
    document: 'projects/' + PROJECT + '/databases/(default)/documents/tokens/' + uid,
    fieldTransforms: [{ fieldPath: 't', removeAllFromArray: { values: bad.map(s => ({ stringValue: s })) } }]
  } }] } });
  return n;
}

functions.http('notify', async (req, res) => {
  const o = req.get('origin');
  if (ORIGINS.includes(o)) res.set('Access-Control-Allow-Origin', o);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');
  let me;
  try { me = await verifyIdToken((req.get('authorization') || '').replace(/^Bearer /, '')); }
  catch (e) { return res.status(401).send('sign in'); }
  try {
    const { kind, id } = req.body || {};
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return res.status(400).send('bad id');

    if (kind === 'req' || kind === 'status' || kind === 'msg') {
      const q = await getDoc('requests/' + id);
      if (!q) return res.status(404).send('no request');
      if (me !== q.riderId && me !== q.driverId) return res.status(403).send('not yours');
      const toDriver = me === q.riderId, to = toDriver ? q.driverId : q.riderId, from = (toDriver ? q.riderName : q.driverName) || '';
      const trip = (q.rideFrom || '') + ' ← ' + (q.rideTo || '');
      let title, body;
      if (kind === 'msg') { title = 'رسالة جديدة · خدني'; body = from + ' بعتلك رسالة'; }
      else if (toDriver) {
        if (q.status === 'pending') { title = 'طلب جديد · خدني'; body = from + ' بدّو يطلع معك: ' + trip; }
        else if (q.status === 'accepted') { title = 'تأكيد · خدني'; body = from + ' أكّد إنّو طالع معك'; }
        else if (q.status === 'cancelled') { title = 'إلغاء · خدني'; body = from + ' لغى الحجز'; }
        else return res.send('nothing to send');
      } else {
        if (q.status === 'accepted') { title = 'انقبل طلبك · خدني'; body = from + ' قبل، ومقعدك مأكّد'; }
        else if (q.status === 'offered') { title = 'عرض جديد · خدني'; body = from + (q.wantId ? ' شاف طلبك وعرض ياخدك. افتح وأكّد' : ' اقترح نقطة طلعة. افتح وأكّد'); }
        else if (q.status === 'rejected') { title = 'خدني'; body = from + ' ما قدر ياخدك هالمرّة. فتّش على مشوار تاني'; }
        else if (q.status === 'cancelled') { title = 'إلغاء · خدني'; body = from + ' لغى المشوار'; }
        else if (q.status === 'rerouted') { title = 'تغيير طريق · خدني'; body = from + ' غيّر طريقه. افتح واختار نقطة جديدة'; }
        else return res.send('nothing to send');
      }
      const n = await send(to, title, body, id);
      return res.send('sent ' + n);
    }

    if (kind === 'want') {
      const w = await getDoc('wants/' + id);
      if (!w) return res.status(404).send('no want');
      if (w.riderId !== me || w.status !== 'open') return res.status(403).send('not yours');
      const rides = await openRides();
      const drivers = new Set();
      for (const R of rides) {
        if (R.driverId === me || drivers.has(R.driverId) || !(R.seatsLeft > 0)) continue;
        if (R.only && R.only.length && !R.only.includes(w.grp || '')) continue;
        if (Math.abs(R.dep - w.at) > 6 * 3600000) continue;
        const path = decode(R.poly || '');
        if (path.length < 2 || !w.from || !w.to) continue;
        const a = near(path, w.from), b = near(path, w.to);
        if (a.d > REACH || b.d > REACH || b.c - a.c < 300) continue;
        const at = R.dep + a.c / a.total * (R.dur || 0) * 1000;
        if (Math.abs(at - w.at) > SLACK) continue;
        drivers.add(R.driverId);
        if (drivers.size >= 20) break;
      }
      for (const u of drivers) await send(u, 'حدا طالب مشوار عطريقك · خدني', (w.riderName || '') + ' بدّو يطلع من ' + area(w.fromText) + '. افتح خدني واعرض عليه', 'want' + id);
      return res.send('drivers ' + drivers.size);
    }
    return res.status(400).send('unknown kind');
  } catch (e) {
    console.error(e);
    return res.status(500).send('error');
  }
});
