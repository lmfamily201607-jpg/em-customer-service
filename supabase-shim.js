/* ตัวเชื่อมให้หน้าเว็บทำงานบน Supabase แทน claude.ai
   ทำให้มี window.claude.use('db' | 'user' | 'sample' | 'downloads') เหมือนเดิม */
(function () {
  const cfg = window.EM_CONFIG || {};
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  const css = 'position:fixed;inset:0;z-index:1000;background:#f5f7f6;display:flex;align-items:center;justify-content:center;padding:24px;font:14px -apple-system,BlinkMacSystemFont,"Noto Sans Thai",sans-serif;color:#111';
  const card = 'background:#fff;border:1px solid #d7dedb;border-radius:12px;padding:24px;max-width:380px;width:100%;box-shadow:0 4px 18px rgba(0,0,0,.06)';
  const inp = 'width:100%;box-sizing:border-box;padding:10px;margin:4px 0 12px;border:1px solid #bbb;border-radius:8px;font:inherit';
  const btn = 'width:100%;padding:11px;border:0;border-radius:8px;background:#0a7d4a;color:#fff;font:inherit;font-weight:600;cursor:pointer';

  if (!/^https:\/\/.+\.supabase\.co/.test(cfg.supabaseUrl || '') || /YOUR-/.test(cfg.supabaseAnonKey || '')) {
    window.claude = { use: () => new Promise(() => {}) };
    window.addEventListener('DOMContentLoaded', () => document.body.appendChild(el(
      `<div style="${css}"><div style="${card}"><h2 style="margin:0 0 8px">ยังไม่ได้ตั้งค่า Supabase</h2><p>เปิดไฟล์ config.js แล้วใส่ Project URL และ anon public key</p></div></div>`)));
    return;
  }

  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const errOf = (e) => ({ code: /JWT|permission|policy|42501|401|403/i.test(e?.message || e?.code || '') ? 'invalid_argument' : (e?.status === 429 ? 'resource_exhausted' : 'unavailable'), message: e?.message });
  const first = (p) => p.split('/')[0];
  const PAGE = 40;

  /* ---------- database ---------- */
  let active = 0; const waitQ = [];
  const qrun = async (fn) => { if (active >= 2) await new Promise((r) => waitQ.push(r)); active++; try { return await fn(); } finally { active--; const n = waitQ.shift(); if (n) n(); } };
  async function fetchPage(path, prefix, from) {
    let last;
    for (let i = 0; i < 4; i++) {
      const { data, error } = await sb.from('em_docs').select('path,data').eq('coll', first(path)).like('path', prefix + '%').order('path').range(from, from + PAGE - 1);
      if (!error) return data;
      last = error; console.warn('em fetch retry', path, from, error.message);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
    throw errOf(last);
  }
  async function fetchColl(path) {
    const out = []; const prefix = path + '/';
    for (let from = 0; ; from += PAGE) {
      const data = await qrun(() => fetchPage(path, prefix, from));
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out.filter((r) => !r.path.slice(prefix.length).includes('/'));
  }
  const snapOf = (rows) => ({ docs: rows.map((r) => ({ id: r.path.split('/').pop(), exists: true, data: () => r.data })), size: rows.length, empty: !rows.length });
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function applyQuery(rows, q) {
    let r = rows;
    q.wh.forEach(([f, op, v]) => { r = r.filter((x) => { const a = x.data?.[f]; return op === '==' ? a === v : op === '!=' ? a !== v : op === 'in' ? (v || []).includes(a) : true; }); });
    if (q.order) { const [f, dir] = q.order; r = r.slice().sort((x, y) => (dir === 'desc' ? -1 : 1) * cmp(x.data?.[f] ?? '', y.data?.[f] ?? '')); }
    if (q.lim) r = r.slice(0, q.lim);
    return r;
  }

  const listeners = new Set();
  let channel = null;
  function ensureChannel() {
    if (channel) return;
    let t = null;
    channel = sb.channel('docs-live').on('postgres_changes', { event: '*', schema: 'public', table: 'em_docs' }, (p) => {
      const path = (p.new && p.new.path) || (p.old && p.old.path) || '';
      clearTimeout(t); t = setTimeout(() => listeners.forEach((l) => l.match(path) && l.run()), 250);
    }).subscribe();
  }

  function colRef(path) {
    const q = { wh: [], order: null, lim: null };
    const api = {
      orderBy(f, dir) { q.order = [f, dir || 'asc']; return api; },
      limit(n) { q.lim = n; return api; },
      where(f, op, v) { q.wh.push([f, op, v]); return api; },
      async get() { return snapOf(applyQuery(await fetchColl(path), q)); },
      onSnapshot(cb, onErr) {
        const run = async () => { try { cb(await api.get()); } catch (e) { onErr && onErr(e); } };
        const l = { match: (p) => p.startsWith(path + '/'), run };
        listeners.add(l); ensureChannel(); run();
        return () => listeners.delete(l);
      },
      async add(data) { const id = uuid(); await docRef(path + '/' + id).set(data); return docRef(path + '/' + id); }
    };
    return api;
  }
  function docRef(path) {
    const read = async () => {
      const { data, error } = await sb.from('em_docs').select('path,data').eq('path', path).maybeSingle();
      if (error) throw errOf(error);
      return { id: path.split('/').pop(), exists: !!data, data: () => (data ? data.data : undefined) };
    };
    const api = {
      get: read,
      async set(data) { const { error } = await sb.from('em_docs').upsert({ path, coll: first(path), data }); if (error) throw errOf(error); },
      async update(patch) { const s = await read(); await api.set({ ...(s.exists ? s.data() : {}), ...patch }); },
      async delete() { const { error } = await sb.from('em_docs').delete().eq('path', path); if (error) throw errOf(error); },
      onSnapshot(cb, onErr) {
        const run = async () => { try { cb(await read()); } catch (e) { onErr && onErr(e); } };
        const l = { match: (p) => p === path, run };
        listeners.add(l); ensureChannel(); run();
        return () => listeners.delete(l);
      }
    };
    return api;
  }
  const db = {
    collection: colRef,
    doc: docRef,
    async nextCounter(key) { const { data, error } = await sb.rpc('em_next_counter', { k: key }); if (error) throw errOf(error); return data; }
  };

  /* ---------- user ---------- */
  let me = null;
  const avatar = (n) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="#0a7d4a"/><text x="24" y="31" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">${(n || '?').trim().charAt(0).toUpperCase()}</text></svg>`);
  const user = {
    async me() { return me; },
    async can() { return me.level === 'interact' || me.level === 'admin'; },
    async search(q) {
      const s = String(q || '').replace(/[%,()]/g, ' ').trim();
      const { data } = await sb.from('profiles').select('id,name,email').or(`name.ilike.%${s}%,email.ilike.%${s}%`).limit(15);
      return (data || []).map((r) => ({ id: r.id, name: r.name || r.email, email: r.email || '' }));
    },
    async pending() {
      const { data } = await sb.from('profiles').select('id,name,email').eq('level', 'none').limit(50);
      return (data || []).map((r) => ({ id: r.id, name: (r.name || '') + (r.email ? ' · ' + r.email : '') }));
    },
    async invite(email, data) {
      const e = String(email || '').trim().toLowerCase();
      const { error } = await sb.from('em_docs').upsert({ path: 'invites/' + e, coll: 'invites', data: data || {} });
      if (error) throw errOf(error);
    },
    async profiles(ids) {
      const { data } = await sb.from('profiles').select('id,name,email').in('id', ids);
      const o = {}; (data || []).forEach((r) => { o[r.id] = { name: r.name || r.email }; }); return o;
    },
    async approve(id) { const { error } = await sb.rpc('set_level', { uid: id, lvl: 'interact' }); if (error) throw errOf(error); }
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };

  /* ---------- sign in / registration gate ---------- */
  let gate = null;
  const show = (html) => { if (gate) gate.remove(); gate = el(`<div style="${css}"><div style="${card}">${html}</div></div>`); document.body.appendChild(gate); return gate; };
  const hide = () => { if (gate) { gate.remove(); gate = null; } };

  function loginForm() {
    return new Promise((resolve) => {
      let signup = false;
      const draw = (msg) => {
        const g = show(`<h2 style="margin:0 0 4px">EM MOTOR Customer Service</h2><p style="margin:0 0 16px;color:#555">เข้าสู่ระบบเพื่อใช้งาน</p>
          ${signup ? `<label>ชื่อที่ใช้แสดง</label><input id="lg-name" style="${inp}" placeholder="เช่น ฝน">` : ''}
          <label>อีเมล</label><input id="lg-mail" type="email" style="${inp}" autocomplete="username">
          <label>รหัสผ่าน (อย่างน้อย 8 ตัว)</label><input id="lg-pw" type="password" style="${inp}" autocomplete="${signup ? 'new-password' : 'current-password'}">
          <div id="lg-msg" style="color:#b3261e;min-height:20px;margin-bottom:8px">${msg || ''}</div>
          <button id="lg-go" style="${btn}">${signup ? 'สมัครใช้งาน' : 'เข้าสู่ระบบ'}</button>
          <p style="text-align:center;margin:14px 0 0"><a href="#" id="lg-sw">${signup ? 'มีบัญชีแล้ว เข้าสู่ระบบ' : 'ยังไม่มีบัญชี สมัครใช้งาน'}</a></p>`);
        g.querySelector('#lg-sw').onclick = (e) => { e.preventDefault(); signup = !signup; draw(''); };
        const go = async () => {
          const email = g.querySelector('#lg-mail').value.trim(), password = g.querySelector('#lg-pw').value, name = (g.querySelector('#lg-name') || {}).value || '';
          const m = g.querySelector('#lg-msg');
          if (!email || password.length < 8) { m.textContent = 'กรอกอีเมลและรหัสผ่านอย่างน้อย 8 ตัว'; return; }
          if (signup && !name.trim()) { m.textContent = 'กรอกชื่อที่ใช้แสดง'; return; }
          g.querySelector('#lg-go').disabled = true; m.style.color = '#555'; m.textContent = 'กำลังดำเนินการ…';
          const r = signup ? await sb.auth.signUp({ email, password, options: { data: { name: name.trim() } } }) : await sb.auth.signInWithPassword({ email, password });
          if (r.error) { draw(/Invalid login/i.test(r.error.message) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : r.error.message); return; }
          if (!r.data.session) { draw('สมัครแล้ว กรุณายืนยันอีเมล (ถ้าไม่ต้องการ ให้ผู้ดูแลปิด Confirm email ใน Supabase) แล้วเข้าสู่ระบบ'); return; }
          resolve();
        };
        g.querySelector('#lg-go').onclick = go;
        g.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
      };
      draw('');
    });
  }

  async function loadMe(session) {
    const { data, error } = await sb.from('profiles').select('id,name,email,level').eq('id', session.user.id).maybeSingle();
    if (error || !data) return null;
    return { id: data.id, name: data.name || data.email, email: data.email, level: data.level, canEdit: data.level === 'admin', avatarUrl: avatar(data.name || data.email) };
  }

  const ready = (async () => {
    for (;;) {
      let { data: { session } } = await sb.auth.getSession();
      if (!session) { await loginForm(); ({ data: { session } } = await sb.auth.getSession()); if (!session) continue; }
      me = await loadMe(session);
      if (!me) { await sb.auth.signOut(); continue; }
      if (me.level === 'none') {
        // registered but not yet approved: wait here, re-check every 10 seconds
        const approved = await new Promise((resolve) => {
          const g = show(`<h2 style="margin:0 0 8px">รอผู้ดูแลอนุมัติ</h2><p>${me.name}</p><p style="color:#555">บัญชีของคุณสมัครแล้ว แต่ยังไม่ได้รับสิทธิ์ใช้งาน กรุณาแจ้งผู้ดูแลระบบ (แนน) ให้เพิ่มชื่อคุณในเมนู "จัดการผู้ใช้" หน้านี้จะเปิดเองเมื่อได้รับอนุมัติ</p><button id="lg-out" style="${btn};background:#666">ออกจากระบบ</button>`);
          g.querySelector('#lg-out').onclick = async () => { await sb.auth.signOut(); resolve(false); };
          const t = setInterval(async () => { const m2 = await loadMe(session); if (m2 && m2.level !== 'none') { clearInterval(t); me = m2; resolve(true); } }, 10000);
          g.addEventListener('DOMNodeRemoved', () => clearInterval(t));
        });
        if (!approved) continue;
      }
      hide();
      // sign-out link in the header
      window.addEventListener('DOMContentLoaded', () => {});
      setTimeout(() => {
        const who = document.getElementById('who');
        if (who && !document.getElementById('lg-logout')) { const b = document.createElement('button'); b.id = 'lg-logout'; b.type = 'button'; b.textContent = 'ออกจากระบบ'; b.style.marginLeft = '8px'; b.onclick = async () => { await sb.auth.signOut(); location.reload(); }; who.after(b); }
        if (who && !document.getElementById('lg-pw')) {
          const p = document.createElement('button'); p.id = 'lg-pw'; p.type = 'button'; p.textContent = 'เปลี่ยนรหัสผ่าน'; p.style.marginLeft = '8px';
          p.onclick = () => {
            const g = el(`<div style="${css}"><div style="${card}"><h2 style="margin:0 0 12px;color:#111">เปลี่ยนรหัสผ่าน</h2>
              <input id="pw1" type="password" placeholder="รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:8px;border:1px solid #bbb;border-radius:8px;background:#fff;color:#111">
              <input id="pw2" type="password" placeholder="พิมพ์รหัสผ่านใหม่อีกครั้ง" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:8px;border:1px solid #bbb;border-radius:8px;background:#fff;color:#111">
              <div id="pwm" style="min-height:20px;color:#b00020;margin-bottom:8px"></div>
              <div style="display:flex;gap:8px"><button id="pws" type="button" style="flex:1;padding:10px;background:#0a7d4a;color:#fff;border:0;border-radius:8px;cursor:pointer">บันทึกรหัสใหม่</button><button id="pwc" type="button" style="padding:10px;border:1px solid #bbb;background:#fff;color:#111;border-radius:8px;cursor:pointer">ยกเลิก</button></div></div></div>`);
            document.body.appendChild(g);
            const m = g.querySelector('#pwm');
            g.querySelector('#pwc').onclick = () => g.remove();
            g.querySelector('#pws').onclick = async () => {
              const a = g.querySelector('#pw1').value, c = g.querySelector('#pw2').value;
              if (a.length < 8) { m.textContent = 'รหัสผ่านต้องมีอย่างน้อย 8 ตัว'; return; }
              if (a !== c) { m.textContent = 'รหัสผ่านสองช่องไม่ตรงกัน'; return; }
              m.style.color = '#555'; m.textContent = 'กำลังบันทึก...';
              const { error } = await sb.auth.updateUser({ password: a });
              if (error) { m.style.color = '#b00020'; m.textContent = 'เปลี่ยนไม่สำเร็จ: ' + error.message; return; }
              m.style.color = '#0a7d4a'; m.textContent = 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว'; setTimeout(() => g.remove(), 1500);
            };
          };
          document.getElementById('lg-logout').before(p);
        }
      }, 1500);
      return;
    }
  })();

  window.claude = {
    async use(name) {
      await ready;
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'downloads') return downloads;
      return null; // sample (Claude assistant) is not available outside claude.ai
    }
  };
})();
