// Khedni notification service (Cloud Run function, HTTP). The app calls it right after an action;
// it checks who is asking, works out who should hear about it, and sends a phone notification.
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const ORIGINS = ['https://khedni.app', 'https://www.khedni.app', 'https://khadni1966.github.io'];
const REACH = 5000, SLACK = 90 * 60000;

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

async function send(uid, title, body, tag) {
  const s = await db.doc('tokens/' + uid).get();
  const t = (s.exists && s.data().t) || [];
  if (!t.length) return 0;
  const r = await admin.messaging().sendEachForMulticast({
    tokens: t,
    data: { title, body, url: 'https://khedni.app/', tag: tag || '' },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } }
  });
  const bad = [];
  r.responses.forEach((x, i) => { const c = (x.error && x.error.code) || ''; if (!x.success && /not-registered|invalid-registration|invalid-argument/.test(c)) bad.push(t[i]); });
  if (bad.length) await db.doc('tokens/' + uid).update({ t: admin.firestore.FieldValue.arrayRemove(...bad) });
  return r.successCount;
}

functions.http('notify', async (req, res) => {
  const o = req.get('origin');
  if (ORIGINS.includes(o)) res.set('Access-Control-Allow-Origin', o);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).send('POST only');
  let me;
  try { me = (await admin.auth().verifyIdToken((req.get('authorization') || '').replace(/^Bearer /, ''))).uid; }
  catch (e) { return res.status(401).send('sign in'); }
  try {
    const { kind, id } = req.body || {};
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return res.status(400).send('bad id');

    if (kind === 'req' || kind === 'status' || kind === 'msg') {
      const s = await db.doc('requests/' + id).get();
      if (!s.exists) return res.status(404).send('no request');
      const q = s.data();
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
      const s = await db.doc('wants/' + id).get();
      if (!s.exists) return res.status(404).send('no want');
      const w = s.data();
      if (w.riderId !== me || w.status !== 'open') return res.status(403).send('not yours');
      const rides = await db.collection('rides').where('status', '==', 'open').get();
      const drivers = new Set();
      for (const d of rides.docs) {
        const R = d.data();
        if (R.driverId === me || drivers.has(R.driverId) || !(R.seatsLeft > 0)) continue;
        if (R.only && R.only.length && !R.only.includes(w.grp || '')) continue;
        if (Math.abs(R.dep - w.at) > 6 * 3600000) continue;
        const path = decode(R.poly || '');
        if (path.length < 2) continue;
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
