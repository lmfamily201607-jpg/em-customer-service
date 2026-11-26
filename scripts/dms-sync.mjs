// ดึงเคสจาก API Data Center EM แล้วส่งเข้าแอพ (Supabase em_docs: audit/_dmsfeed/*) — รันโดย GitHub Actions ทุก 30 นาที
// ต้องมี secret: SA_KEY (JSON key ของ service account), APP_PUSH_SECRET (รหัสเดียวกับใน dms-feed-setup.sql)
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'https://api.emmotor.co.th';
const need = (k) => { const v = process.env[k]; if (!v) { console.error('ยังไม่ได้ตั้ง secret: ' + k); process.exit(1); } return v; };
const sa = JSON.parse(need('SA_KEY'));
const PUSH = need('APP_PUSH_SECRET');
const cfg = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const SB_URL = /supabaseUrl:\s*"([^"]+)"/.exec(cfg)[1];
const SB_KEY = /supabaseAnonKey:\s*"([^"]+)"/.exec(cfg)[1];
const b64 = (x) => Buffer.from(x).toString('base64url');

async function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
  const body = b64(JSON.stringify({ iss: sa.client_email, sub: sa.client_email, aud: sa.token_uri, iat: now, exp: now + 3600, target_audience: BASE }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(sa.private_key, 'base64url');
  const r = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  if (!r.ok) throw new Error('ขอ token ไม่ได้ (' + r.status + ') ' + (await r.text()).slice(0, 200));
  return (await r.json()).id_token;
}

let TOKEN;
async function api(path, params) {
  const u = new URL(BASE + path); Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let a = 0; a < 5; a++) {
    const r = await fetch(u, { headers: { authorization: 'Bearer ' + TOKEN } });
    if (r.status === 401 && a === 0) { TOKEN = await idToken(); continue; }
    if (r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path + ' ' + (await r.text()).slice(0, 200));
    return r.json();
  }
  throw new Error('เรียก ' + path + ' ไม่สำเร็จ');
}
async function all(ds, params) {
  const out = []; for (let p = 1; ; p++) {
    const b = await api('/v1/' + ds, { ...params, page: p, page_size: 1000 });
    out.push(...(b.data || [])); if (!b.pagination || !b.pagination.has_next_page) return out;
  }
}
async function push(path, data) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/push_dms_feed', { method: 'POST',
    headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ p_secret: PUSH, p_path: path, p_data: data }) });
  if (!r.ok) throw new Error('ส่งเข้าแอพไม่สำเร็จ (' + r.status + ') ' + (await r.text()).slice(0, 200));
}

const rx = /รอคืนค่า(บริการ|แรง)เคลม/;
const day = (x) => String(x || '').slice(0, 10);
TOKEN = await idToken();
const me = await api('/v1/me'); console.log('แผนก:', me.department);
const claims = (await all('service.claims', {})).filter((c) => rx.test(String(c.current_status || '')));
console.log('เคสสถานะ 10 / รอคืนค่า:', claims.length, '· รูป DMS:', canMedia ? 'มีสิทธิ์' : 'ไม่มีสิทธิ์ service.claim_media');
const ids = claims.map((c) => c.claim_id), parts = {}, hist = {}, media = {};
const canMedia = (me.datasets || []).some((d) => d.name === 'service.claim_media');
for (let i = 0; i < ids.length; i += 300) {
  const q = { claim_id: ids.slice(i, i + 300).join(',') };
  (await all('service.claim_parts', q)).forEach((p) => (parts[p.claim_id] = parts[p.claim_id] || []).push({ s: String(p.good_code || ''), n: String(p.good_name || ''), q: Number(p.qty) || 1, p: Number(p.price) || 0 }));
  if (canMedia) (await all('service.claim_media', q)).forEach((m) => m.url && (media[m.claim_id] = media[m.claim_id] || []).push({ t: String(m.media_type || ''), u: String(m.url) }));
  (await all('service.claim_status_history', q)).forEach((h) => (hist[h.claim_id] = hist[h.claim_id] || []).push({ s: String(h.status || ''), t: String(h.changed_at || '') }));
}
const cases = claims.map((c) => ({
  tk: String(c.claim_id), st: String(c.current_status || ''), ty: c.type === 'claim' ? 'เคลม' : 'สั่งอะไหล่',
  ctype: String(c.claim_type || ''), br: String(c.branch_name || c.dealer_name || ''),
  dn: String(c.dealer_name || ''), dc: String(c.dealer_code || ''), bp: String(c.branch_province || ''),
  v: String(c.vin_no || c.chassis_number || ''), mo: String(c.motor_number || ''), ba: String(c.battery_number || ''),
  m: String(c.model || c.vehicle_model || ''), c: String(c.problem_category || ''), p: String(c.problem_subcategory || ''),
  d: day(c.created_at), parts: parts[c.claim_id] || [], hist: hist[c.claim_id] || [], md: media[c.claim_id] || [],
}));
const SIZE = 100, chunks = Math.ceil(cases.length / SIZE);
for (let i = 0; i < chunks; i++) await push('audit/_dmsfeed/c/' + String(i).padStart(3, '0'), { cases: cases.slice(i * SIZE, (i + 1) * SIZE) });
await push('audit/_dmsfeed/meta', { at: new Date().toLocaleString('sv', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T').slice(0, 16), count: cases.length, chunks });
console.log('ส่งเข้าแอพแล้ว', cases.length, 'เคส', chunks, 'ก้อน');
