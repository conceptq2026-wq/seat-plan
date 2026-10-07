/* এডমিন প্যানেল — সিট প্ল্যান তৈরি, সম্পাদনা ও GitHub-এ প্রকাশ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const nfc = SP.nfc;

  const TOKEN_KEY = 'seatplan_token';
  let repo = SP.repoInfo();
  let token = safeGet(localStorage, TOKEN_KEY) || safeGet(sessionStorage, TOKEN_KEY) || '';

  let data = null;            // এডমিন যে ডেটা নিয়ে কাজ করছেন
  let serverJson = null;      // সর্বশেষ প্রকাশিত ডেটা (তুলনার জন্য)
  let serverSha = null;       // GitHub-এ ফাইলের বর্তমান সংস্করণ
  let conn = { state: 'none', msg: '' };
  let planId = null, sessionId = null;
  let undoStack = [];
  let dragSrc = null, swapFrom = null;
  let lastSeat = { cls: '', sec: SP.NA, shiftOpt: SP.NA, dept: SP.NA, roll: '' };
  let publishing = false;

  /* ================= সহায়ক ================= */
  function safeGet(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function safeSet(store, k, v) { try { v === null ? store.removeItem(k) : store.setItem(k, v); } catch (e) { /* ignore */ } }
  const draftKey = () => `seatplan_draft:${repo.owner || 'local'}/${repo.repo || 'site'}`;
  const isDirty = () => data && JSON.stringify(data) !== serverJson;
  const curPlan = () => data.plans.find(p => p.id === planId);
  const curSession = () => { const p = curPlan(); return p && p.sessions.find(s => s.id === sessionId); };
  const findRoom = id => { const s = curSession(); return s && s.rooms.find(r => r.id === id); };
  const sameNo = (a, b) => SP.bn(nfc(String(a)).trim()) === SP.bn(nfc(String(b)).trim());
  const studentId = s => [s.cls, s.sec || SP.NA, s.shiftOpt || SP.NA, s.dept || SP.NA, SP.num(s.roll)].map(x => nfc(String(x))).join('|');

  function err(msg, code) { const e = new Error(msg); e.code = code; return e; }

  /* ================= GitHub ================= */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  const gh = {
    base() { return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`; },
    filePath() { return repo.dataPath.split('/').map(encodeURIComponent).join('/'); },
    ref() { return repo.branch ? `?ref=${encodeURIComponent(repo.branch)}` : ''; },
    async req(path, opts) {
      opts = opts || {};
      let res;
      try {
        res = await fetch(this.base() + path, Object.assign({}, opts, {
          cache: 'no-store',
          headers: Object.assign({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28'
          }, opts.headers || {})
        }));
      } catch (e) {
        throw err('ইন্টারনেট সংযোগ পাওয়া যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।', 'net');
      }
      return res;
    },
    async fail(res) {
      let m = '';
      try { m = (await res.json()).message || ''; } catch (e) { /* ignore */ }
      if (res.status === 401) return err('টোকেনটি সঠিক নয় বা মেয়াদ শেষ হয়ে গেছে। নতুন টোকেন দিন।', 'auth');
      if (res.status === 403 && /rate limit/i.test(m)) return err('GitHub কিছুক্ষণের জন্য অনুরোধ সীমিত করেছে। কয়েক মিনিট পর চেষ্টা করুন।', 'rate');
      if (res.status === 403) return err('এই টোকেন দিয়ে রিপোতে লেখার অনুমতি নেই। টোকেনে "Contents: Read and write" দিন।', 'auth');
      if (res.status === 404) return err(`রিপো "${repo.owner}/${repo.repo}" পাওয়া যায়নি, অথবা টোকেনে এই রিপো বেছে নেওয়া হয়নি।`, 'auth');
      if (res.status === 409 || res.status === 422) return err('এর মধ্যে সাইটে অন্য পরিবর্তন হয়েছে। আবার প্রকাশ করুন।', 'conflict');
      return err(`GitHub ত্রুটি (${res.status}) ${m}`, 'other');
    },
    async checkRepo() {
      const res = await this.req('');
      if (!res.ok) throw await this.fail(res);
      const j = await res.json();
      if (j.permissions && j.permissions.push === false) throw err('এই অ্যাকাউন্টের রিপোতে লেখার অনুমতি নেই।', 'auth');
      return j;
    },
    /** ফাইলের sha ও কনটেন্ট; ফাইল না থাকলে {sha:null, data:null} */
    async load() {
      const res = await this.req(`/contents/${this.filePath()}${this.ref()}`);
      if (res.status === 404) return { sha: null, data: null };
      if (!res.ok) throw await this.fail(res);
      const j = await res.json();
      let text;
      if (j.content && j.encoding === 'base64') text = b64decode(j.content);
      else {
        const raw = await this.req(`/contents/${this.filePath()}${this.ref()}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
        if (!raw.ok) throw await this.fail(raw);
        text = await raw.text();
      }
      return { sha: j.sha, data: SP.normalizeData(JSON.parse(text)) };
    },
    async sha() {
      const res = await this.req(`/contents/${this.filePath()}${this.ref()}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await this.fail(res);
      return (await res.json()).sha;
    },
    async save(text, sha, message) {
      const body = { message, content: b64encode(text) };
      if (sha) body.sha = sha;
      if (repo.branch) body.branch = repo.branch;
      const res = await this.req(`/contents/${this.filePath()}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw await this.fail(res);
      return (await res.json()).content.sha;
    }
  };

  /* ================= শুরু ================= */
  async function start() {
    bindEvents();
    let loaded = null;
    if (token && repo.owner && repo.repo) {
      try {
        await gh.checkRepo();
        const r = await gh.load();
        serverSha = r.sha;
        loaded = r.data;
        conn = { state: 'ok', msg: '' };
      } catch (e) {
        conn = { state: 'bad', msg: e.message };
      }
    }
    if (!loaded) {
      try { loaded = await SP.loadPublicData(); }
      catch (e) { loaded = SP.normalizeData({ plans: [] }); }
    }
    data = loaded;
    serverJson = JSON.stringify(data);

    // অপ্রকাশিত খসড়া থাকলে ফিরিয়ে আনা
    let draft = null;
    try { draft = JSON.parse(safeGet(localStorage, draftKey()) || 'null'); } catch (e) { draft = null; }
    if (draft && draft.data) {
      const d = SP.normalizeData(draft.data);
      if (JSON.stringify(d) !== serverJson) {
        const serverChanged = serverSha && draft.baseSha && draft.baseSha !== serverSha;
        if (!serverChanged) {
          data = d;
          SP.toast('আগের অপ্রকাশিত খসড়া ফিরিয়ে আনা হয়েছে।', '', 4500);
        } else if (confirm('আপনার এই ডিভাইসে একটি অপ্রকাশিত খসড়া আছে, কিন্তু এর মধ্যে ওয়েবসাইটে নতুন পরিবর্তন প্রকাশ হয়েছে।\n\nOK = খসড়াটি রাখুন (প্রকাশ করলে সাইটের নতুন পরিবর্তন মুছে যাবে)\nCancel = খসড়া বাদ দিয়ে সাইটের সংস্করণ নিন')) {
          data = d;
        } else safeSet(localStorage, draftKey(), null);
      } else safeSet(localStorage, draftKey(), null);
    }

    if (!data.plans.length) data.plans.push(SP.newPlan('নতুন পরীক্ষা'));
    let view = {};
    try { view = JSON.parse(safeGet(localStorage, 'seatplan_admin_view') || '{}'); } catch (e) { /* ignore */ }
    planId = data.plans.some(p => p.id === view.planId) ? view.planId : data.plans[0].id;
    sessionId = view.sessionId;
    fillStaticSelects();
    render();
    if (conn.state === 'bad') SP.toast('GitHub সংযোগে সমস্যা: ' + conn.msg, 'bad', 7000);
  }

  function fillStaticSelects() {
    $('aSec').innerHTML = SP.optionsHtml(SP.SECTIONS, 'ক', true);
    $('aShift').innerHTML = SP.optionsHtml(SP.SHIFT_OPTS, SP.NA, true);
    $('aDept').innerHTML = SP.optionsHtml(SP.DEPTS, SP.NA, true, true);
    $('aCls').innerHTML = SP.optionsHtml(SP.CLASSES, '');
  }

  /** শিক্ষার্থীর পাতা শুরুতে যে পরীক্ষা খোলে: এডমিনের বেছে দেওয়াটি, নাহলে তালিকার প্রথম প্রকাশিতটি */
  function effectiveDefault() {
    const pub = data.plans.filter(p => p.published);
    return pub.find(p => p.id === data.settings.defaultPlanId) || pub[0] || null;
  }
  const countPublished = () => data.plans.filter(p => p.published).length;

  /* ================= পরিবর্তন সংরক্ষণ ================= */
  function commit(fn) {
    const before = JSON.stringify(data);
    const result = fn();
    if (result === false) return false;
    if (JSON.stringify(data) === before) { render(); return true; }
    undoStack.push(before);
    if (undoStack.length > 30) undoStack.shift();
    const p = curPlan();
    if (p) p.updatedAt = new Date().toISOString();
    saveDraft();
    render();
    return true;
  }
  function saveDraft() {
    if (isDirty()) safeSet(localStorage, draftKey(), JSON.stringify({ data, baseSha: serverSha, savedAt: new Date().toISOString() }));
    else safeSet(localStorage, draftKey(), null);
  }
  function undo() {
    if (!undoStack.length) return;
    data = SP.normalizeData(JSON.parse(undoStack.pop()));
    if (!curPlan()) planId = data.plans[0].id;
    saveDraft();
    render();
    SP.toast('শেষ পরিবর্তন ফিরিয়ে নেওয়া হয়েছে।');
  }

  /* ================= কক্ষের তালিকা (ভাঁজ করা) ================= */
  let openRooms = new Set((() => { try { return JSON.parse(safeGet(localStorage, 'seatplan_admin_open') || '[]'); } catch (e) { return []; } })());
  let roomFilter = '';
  let printAll = false;
  const saveOpen = () => safeSet(localStorage, 'seatplan_admin_open', JSON.stringify([...openRooms].slice(-300)));

  function renderRooms(se, printHead, actions) {
    if (!se.rooms.length) {
      $('rooms').innerHTML = '<div class="empty-state">এই সেশনে এখনো কোনো কক্ষ নেই। উপরের "নতুন কক্ষ যোগ করুন" থেকে কক্ষ যোগ করুন।</div>';
      return;
    }
    const colors = data.settings.classColors;
    $('rooms').innerHTML = SP.roomListHtml(se.rooms, {
      colors, title: '🏫 কক্ষসমূহ', filterValue: roomFilter,
      isOpen: id => printAll || openRooms.has(id),
      card: r => SP.renderRoom(r, { admin: true, colors, printHead, actionsHtml: actions, highlight: swapFrom && swapFrom.roomId === r.id ? swapFrom.key : null })
    });
    applyRoomFilter();
  }

  const applyRoomFilter = () => SP.applyRoomFilter($('rooms'), roomFilter);

  /* ================= রেন্ডার ================= */
  function render() {
    if (!curPlan()) planId = data.plans[0].id;
    const plan = curPlan();
    if (!plan.sessions.length) plan.sessions.push(SP.newSession('সকালের পরীক্ষা', '☀'));
    if (!plan.sessions.some(s => s.id === sessionId)) sessionId = plan.sessions[0].id;
    const se = curSession();
    safeSet(localStorage, 'seatplan_admin_view', JSON.stringify({ planId, sessionId }));

    $('schoolName').textContent = data.settings.schoolName;
    $('planTitleHead').textContent = plan.title + (plan.published ? '' : ' (শিক্ষার্থীদের কাছে লুকানো)');
    $('sessionTabs').innerHTML = SP.sessionTabsHtml(plan, sessionId, '<button class="shift-btn add" id="btnAddSession" type="button" title="নতুন সেশন">➕ সেশন</button>');

    const startPlan = effectiveDefault();
    $('planSelect').innerHTML = data.plans.map(p => `<option value="${SP.esc(p.id)}"${p.id === planId ? ' selected' : ''}>${p.published ? '🟢' : '⚪'} ${SP.esc(p.title)}${p === startPlan && countPublished() > 1 ? ' ⭐' : ''}</option>`).join('');
    // একাধিক পরীক্ষা প্রকাশিত থাকলে কোনটি শুরুতে খুলবে
    $('defaultBox').hidden = !plan.published || countPublished() < 2;
    $('defaultSlot').innerHTML = plan === startPlan
      ? '<span class="pill ok">⭐ শিক্ষার্থীরা শুরুতে এটি দেখবে</span>'
      : '<button class="btn btn-sm" type="button" id="btnMakeDefault">⭐ শুরুতে এটি দেখান</button>';
    if (document.activeElement !== $('planTitle')) $('planTitle').value = plan.title;
    $('planPublished').checked = plan.published;

    $('sesIcon').value = se.icon || '📝';
    $('sesName').value = se.name;
    $('sesTime').value = se.time || '';
    $('sesClasses').value = se.classes || '';

    const prevRoom = $('aRoom').value;
    $('aRoom').innerHTML = se.rooms.map(r => `<option value="${SP.esc(r.id)}"${r.id === prevRoom ? ' selected' : ''}>কক্ষ ${SP.bn(SP.esc(r.no))}</option>`).join('') || '<option value="">— আগে কক্ষ যোগ করুন —</option>';

    const printHead = SP.printHead(data.settings, plan, se);
    const actions = `
      <button class="btn btn-sm" type="button" data-act="edit">✏ সম্পাদনা</button>
      <button class="btn btn-sm" type="button" data-act="clear">🧹 খালি করুন</button>
      <button class="btn btn-doc btn-sm" type="button" data-act="word">📄 Word</button>
      <button class="btn btn-danger btn-sm" type="button" data-act="delete">🗑 মুছুন</button>`;
    renderRooms(se, printHead, actions);
    if (swapFrom) {
      const c = document.querySelector(`#room-${CSS.escape(swapFrom.roomId)} [data-seat="${swapFrom.key}"]`);
      if (c) { c.classList.remove('seat-found'); c.classList.add('swap-source'); }
    }
    renderStatus();
  }

  function renderStatus() {
    const pill = $('connPill');
    if (conn.state === 'ok') {
      pill.className = 'pill ok';
      pill.innerHTML = `🔗 ${SP.esc(repo.owner)}/${SP.esc(repo.repo)} <button type="button" data-conn>বদলান</button>`;
    } else if (conn.state === 'bad') {
      pill.className = 'pill bad';
      pill.innerHTML = `⚠ GitHub সংযোগ ব্যর্থ <button type="button" data-conn>ঠিক করুন</button>`;
    } else {
      pill.className = 'pill warn';
      pill.innerHTML = `🔌 GitHub-এ সংযুক্ত নয় <button type="button" data-conn>সংযোগ করুন</button>`;
    }
    const dirty = isDirty();
    $('changePill').className = 'pill ' + (dirty ? 'warn' : 'ok');
    $('changePill').textContent = dirty ? '● অপ্রকাশিত পরিবর্তন আছে' : '✔ সব প্রকাশিত';
    $('btnDiscard').hidden = !dirty;
    $('btnPublish').disabled = publishing || !dirty;
    $('undoCount').textContent = SP.bn(undoStack.length);
    $('btnUndo').disabled = !undoStack.length;
  }

  /* ================= মডাল ================= */
  function modal(opts) {
    closeModal();
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.id = 'modal';
    bd.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="${opts.width ? 'max-width:' + opts.width + 'px' : ''}">
      <div class="modal-head"><span>${opts.title}</span><button class="modal-close" type="button" data-close aria-label="বন্ধ">×</button></div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-foot">${(opts.buttons || []).map((b, i) => b === 'spacer' ? '<span class="spacer"></span>' : `<button class="btn btn-sm ${b.cls || ''}" type="button" data-btn="${i}" ${b.id ? `id="${b.id}"` : ''}>${b.label}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(bd);
    bd.addEventListener('click', async e => {
      if (e.target === bd || e.target.closest('[data-close]')) return closeModal();
      const btn = e.target.closest('[data-btn]');
      if (!btn) return;
      const b = opts.buttons[+btn.dataset.btn];
      if (!b.onClick) return closeModal();
      btn.disabled = true;
      try {
        const keep = await b.onClick(bd);
        if (keep !== false) closeModal();
      } finally { btn.disabled = false; }
    });
    bd.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file') {
        const primary = bd.querySelector('.btn-primary[data-btn]');
        if (primary) { e.preventDefault(); primary.click(); }
      }
    });
    const first = bd.querySelector('input:not([type=hidden]):not([type=checkbox]), select');
    if (first) setTimeout(() => first.focus(), 30);
    return bd;
  }
  function closeModal() { const m = $('modal'); if (m) m.remove(); }

  /* ================= GitHub সংযোগ ================= */
  function openConnect(fromPublish) {
    const auto = SP.repoInfo(true);
    const tokenUrl = 'https://github.com/settings/personal-access-tokens/new';
    modal({
      title: '🔗 GitHub-এর সাথে সংযোগ',
      width: 600,
      body: `
        ${fromPublish ? '<div class="note warn">ওয়েবসাইটে প্রকাশ করতে আগে GitHub টোকেন দিয়ে সংযোগ করুন। আপনার পরিবর্তনগুলো এই ডিভাইসে সংরক্ষিত আছে।</div>' : ''}
        <div class="note">টোকেন হলো এডমিনের গোপন চাবি। যার কাছে টোকেন আছে, শুধু সে-ই সাইটে পরিবর্তন প্রকাশ করতে পারবে।
          <ol>
            <li><a href="${tokenUrl}" target="_blank" rel="noopener">এই লিংকে</a> যান (রিপোর মালিকের অ্যাকাউন্টে লগইন করে)</li>
            <li>Token name: <b>seat-plan-admin</b>, Expiration: পছন্দমতো</li>
            <li>Repository access: <b>Only select repositories</b> → এই রিপো</li>
            <li>Permissions → Repository permissions → <b>Contents: Read and write</b></li>
            <li><b>Generate token</b> চেপে টোকেনটি কপি করে নিচে বসান</li>
          </ol>
        </div>
        <div class="field-row">
          <div class="field"><label for="cOwner">GitHub অ্যাকাউন্ট (owner)</label><input type="text" id="cOwner" value="${SP.esc(repo.owner)}" placeholder="${SP.esc(auto.owner || 'যেমন: myschool')}"></div>
          <div class="field"><label for="cRepo">রিপো</label><input type="text" id="cRepo" value="${SP.esc(repo.repo)}" placeholder="${SP.esc(auto.repo || 'seat-plan')}"></div>
        </div>
        <div class="field"><label for="cToken">টোকেন</label><input type="password" id="cToken" value="${SP.esc(token)}" placeholder="github_pat_…" autocomplete="off"></div>
        <label class="check"><input type="checkbox" id="cRemember" ${safeGet(localStorage, TOKEN_KEY) || !token ? 'checked' : ''}> এই ডিভাইসে মনে রাখুন (শুধু নিজের কম্পিউটারে টিক দিন)</label>
        ${conn.state === 'bad' ? `<div class="note warn" style="margin-top:12px">সর্বশেষ ত্রুটি: ${SP.esc(conn.msg)}</div>` : ''}`,
      buttons: [
        ...(token ? [{ label: 'সংযোগ বিচ্ছিন্ন', cls: 'btn-danger', onClick: () => {
          token = ''; safeSet(localStorage, TOKEN_KEY, null); safeSet(sessionStorage, TOKEN_KEY, null);
          conn = { state: 'none', msg: '' }; serverSha = null; renderStatus(); SP.toast('টোকেন মুছে ফেলা হয়েছে।');
        } }] : []),
        'spacer',
        { label: 'বাতিল' },
        { label: 'সংযোগ করুন', cls: 'btn-primary', id: 'btnConnect', onClick: async bd => {
          const owner = bd.querySelector('#cOwner').value.trim();
          const rp = bd.querySelector('#cRepo').value.trim();
          const tk = bd.querySelector('#cToken').value.trim();
          if (!owner || !rp || !tk) { SP.toast('অ্যাকাউন্ট, রিপো ও টোকেন তিনটিই লিখুন।', 'bad'); return false; }
          const oldRepo = repo, oldToken = token;
          repo = Object.assign({}, repo, { owner, repo: rp });
          token = tk;
          try {
            await gh.checkRepo();
            const r = await gh.load();
            // সংযোগ সফল — সেটিংস সংরক্ষণ
            if (owner === auto.owner && rp === auto.repo) safeSet(localStorage, 'seatplan_repo', null);
            else safeSet(localStorage, 'seatplan_repo', JSON.stringify({ owner, repo: rp }));
            const remember = bd.querySelector('#cRemember').checked;
            safeSet(localStorage, TOKEN_KEY, remember ? tk : null);
            safeSet(sessionStorage, TOKEN_KEY, remember ? null : tk);
            conn = { state: 'ok', msg: '' };
            const hadChanges = isDirty();
            serverSha = r.sha;
            if (r.data) {
              serverJson = JSON.stringify(r.data);
              if (!hadChanges) { data = r.data; if (!data.plans.length) data.plans.push(SP.newPlan('নতুন পরীক্ষা')); }
            }
            saveDraft();
            render();
            SP.toast('✔ GitHub-এর সাথে সংযুক্ত হয়েছে।', 'ok');
            if (fromPublish) setTimeout(publish, 50);
          } catch (e) {
            repo = oldRepo; token = oldToken;
            conn = { state: 'bad', msg: e.message };
            renderStatus();
            SP.toast(e.message, 'bad', 7000);
            return false;
          }
        } }
      ]
    });
  }

  /* ================= প্রকাশ ================= */
  async function publish() {
    if (publishing || !isDirty()) return;
    if (!token || !repo.owner || !repo.repo || conn.state !== 'ok') return openConnect(true);
    publishing = true;
    renderStatus();
    $('btnPublish').textContent = '⏳ প্রকাশ হচ্ছে…';
    try {
      const current = await gh.sha();
      if (current && serverSha && current !== serverSha) {
        if (!confirm('এর মধ্যে অন্য কেউ (বা অন্য ডিভাইস থেকে) সাইটে পরিবর্তন প্রকাশ করেছে।\n\nআপনার এই সংস্করণ দিয়ে সেটি প্রতিস্থাপন করবেন?')) return;
      }
      const text = JSON.stringify(data, null, 1);
      const plan = curPlan();
      serverSha = await gh.save(text, current, `সিট প্ল্যান হালনাগাদ: ${plan ? plan.title : ''}`);
      serverJson = JSON.stringify(data);
      saveDraft();
      SP.toast('✔ প্রকাশিত হয়েছে! সাধারণত ১-২ মিনিটের মধ্যে ওয়েবসাইটে দেখা যাবে।', 'ok', 6000);
    } catch (e) {
      if (e.code === 'auth') { conn = { state: 'bad', msg: e.message }; }
      SP.toast(e.message, 'bad', 7000);
    } finally {
      publishing = false;
      $('btnPublish').textContent = '🚀 ওয়েবসাইটে প্রকাশ করুন';
      renderStatus();
    }
  }

  /* ================= প্ল্যান ================= */
  function openNewPlan() {
    modal({
      title: '➕ নতুন সিট প্ল্যান',
      body: `
        <div class="field"><label for="npTitle">পরীক্ষার নাম</label><input type="text" id="npTitle" placeholder="যেমন: অর্ধবার্ষিক পরীক্ষা - ২০২৭"></div>
        <div class="field"><label for="npFrom">শুরু করুন</label>
          <select id="npFrom"><option value="">খালি প্ল্যান (সকাল ও বিকাল সেশন)</option>
            ${data.plans.map(p => `<option value="${SP.esc(p.id)}">"${SP.esc(p.title)}" থেকে কক্ষগুলো কপি</option>`).join('')}</select></div>
        <label class="check"><input type="checkbox" id="npSeats"> শিক্ষার্থীর আসনসহ কপি করুন</label>
        <p class="hint" style="font-size:14px;color:var(--muted);font-weight:600">নতুন প্ল্যান শুরুতে শিক্ষার্থীদের কাছে লুকানো থাকবে। তৈরি হলে "শিক্ষার্থীদের দেখাবে" টিক দিন।</p>`,
      buttons: ['spacer', { label: 'বাতিল' }, { label: 'তৈরি করুন', cls: 'btn-primary', onClick: bd => {
        const title = bd.querySelector('#npTitle').value.trim();
        if (!title) { SP.toast('পরীক্ষার নাম লিখুন।', 'bad'); return false; }
        const from = data.plans.find(p => p.id === bd.querySelector('#npFrom').value);
        const withSeats = bd.querySelector('#npSeats').checked;
        let plan;
        if (from) {
          plan = SP.clone(from);
          plan.id = SP.uid('p');
          plan.title = title;
          plan.published = false;
          plan.sessions.forEach(s => { s.id = SP.uid('s'); s.rooms.forEach(r => { r.id = SP.uid('r'); if (!withSeats) r.seats = {}; }); });
        } else plan = SP.newPlan(title);
        commit(() => { data.plans.unshift(plan); planId = plan.id; sessionId = null; });
        SP.toast('নতুন সিট প্ল্যান তৈরি হয়েছে।', 'ok');
      } }]
    });
  }

  function deletePlan() {
    const plan = curPlan();
    if (!confirm(`"${plan.title}" সিট প্ল্যানটি সম্পূর্ণ মুছে ফেলবেন?`)) return;
    commit(() => {
      data.plans = data.plans.filter(p => p.id !== plan.id);
      if (data.settings.defaultPlanId === plan.id) delete data.settings.defaultPlanId;
      if (!data.plans.length) data.plans.push(SP.newPlan('নতুন পরীক্ষা'));
      planId = data.plans[0].id;
      sessionId = null;
    });
    SP.toast('প্ল্যান মুছে ফেলা হয়েছে। ভুল হলে Undo চাপুন।');
  }

  /* ================= সেশন ================= */
  function openAddSession() {
    modal({
      title: '➕ নতুন সেশন',
      body: `
        <div class="field-row">
          <div class="field" style="flex:0 0 90px;min-width:90px"><label for="nsIcon">চিহ্ন</label><select id="nsIcon"><option>📝</option><option>☀</option><option>🌙</option><option>📅</option><option>⭐</option></select></div>
          <div class="field"><label for="nsName">নাম</label><input type="text" id="nsName" placeholder="যেমন: ২য় দিন - সকাল"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="nsTime">সময়</label><input type="text" id="nsTime" placeholder="১০:০০ - ১:০০"></div>
          <div class="field"><label for="nsClasses">শ্রেণি</label><input type="text" id="nsClasses" placeholder="৬ষ্ঠ - ৮ম"></div>
        </div>`,
      buttons: ['spacer', { label: 'বাতিল' }, { label: 'যোগ করুন', cls: 'btn-primary', onClick: bd => {
        const name = bd.querySelector('#nsName').value.trim();
        if (!name) { SP.toast('সেশনের নাম লিখুন।', 'bad'); return false; }
        const se = SP.newSession(name, bd.querySelector('#nsIcon').value, bd.querySelector('#nsTime').value.trim(), bd.querySelector('#nsClasses').value.trim());
        commit(() => { curPlan().sessions.push(se); sessionId = se.id; });
      } }]
    });
  }

  function saveSession() {
    const name = $('sesName').value.trim();
    if (!name) return SP.toast('সেশনের নাম লিখুন।', 'bad');
    commit(() => {
      const se = curSession();
      se.icon = $('sesIcon').value; se.name = name;
      se.time = $('sesTime').value.trim(); se.classes = $('sesClasses').value.trim();
    });
    SP.toast('সেশনের তথ্য সেভ হয়েছে।', 'ok');
  }

  function deleteSession() {
    const plan = curPlan(), se = curSession();
    if (plan.sessions.length <= 1) return SP.toast('অন্তত একটি সেশন থাকতে হবে।', 'bad');
    const n = se.rooms.reduce((a, r) => a + SP.roomStats(r).assigned, 0);
    if (!confirm(`"${se.name}" সেশন মুছবেন?` + (se.rooms.length ? `\nএতে ${se.rooms.length}টি কক্ষ ও ${n} জন শিক্ষার্থীর আসন আছে।` : ''))) return;
    commit(() => { plan.sessions = plan.sessions.filter(s => s.id !== se.id); sessionId = null; });
  }

  /* ================= কক্ষ ================= */
  function readRoomForm(root, prefix) {
    const no = root.querySelector('#' + prefix + 'No').value.trim();
    const floor = root.querySelector('#' + prefix + 'Floor').value.trim();
    const lv = root.querySelector('#' + prefix + 'Left').value.trim();
    const rv = root.querySelector('#' + prefix + 'Right').value.trim();
    const left = lv === '' ? 8 : SP.num(lv);
    const right = rv === '' ? 8 : SP.num(rv);
    const cap = parseInt(root.querySelector('#' + prefix + 'Cap').value, 10);
    if (!no) throw err('কক্ষ নম্বর লিখুন।');
    if (isNaN(left) || isNaN(right) || left < 0 || right < 0 || left > 60 || right > 60) throw err('বেঞ্চ সংখ্যা ০ থেকে ৬০-এর মধ্যে দিন।');
    if (left + right === 0) throw err('অন্তত একটি বেঞ্চ থাকতে হবে।');
    return { no, floor, left, right, cap };
  }

  function addRoom() {
    let f;
    try { f = readRoomForm(document, 'r'); } catch (e) { return SP.toast(e.message, 'bad'); }
    const se = curSession();
    if (se.rooms.some(r => sameNo(r.no, f.no))) return SP.toast(`কক্ষ ${SP.bn(f.no)} এই সেশনে আগেই আছে। সম্পাদনা করতে কক্ষের "✏ সম্পাদনা" চাপুন।`, 'bad', 6000);
    const room = Object.assign({ id: SP.uid('r'), seats: {} }, f);
    openRooms.add(room.id); saveOpen();
    commit(() => se.rooms.push(room));
    $('rNo').value = '';
    $('aRoom').value = room.id;
    SP.toast(`কক্ষ ${SP.bn(f.no)} যোগ হয়েছে।`, 'ok');
    const el = $('room-' + room.id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function editRoom(room) {
    modal({
      title: `✏ কক্ষ ${SP.bn(SP.esc(room.no))} সম্পাদনা`,
      body: `
        <div class="field-row">
          <div class="field"><label for="eNo">কক্ষ নম্বর</label><input type="text" id="eNo" value="${SP.esc(room.no)}"></div>
          <div class="field"><label for="eFloor">তলা/অবস্থান</label><input type="text" id="eFloor" value="${SP.esc(room.floor || '')}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="eLeft">বাম সারির বেঞ্চ</label><input type="text" id="eLeft" inputmode="numeric" value="${SP.bn(room.left)}"></div>
          <div class="field"><label for="eRight">ডান সারির বেঞ্চ</label><input type="text" id="eRight" inputmode="numeric" value="${SP.bn(room.right)}"></div>
        </div>
        <div class="field"><label for="eCap">প্রতি বেঞ্চে আসন</label><select id="eCap">
          <option value="1"${room.cap === 1 ? ' selected' : ''}>১টি (একক)</option><option value="2"${room.cap === 2 ? ' selected' : ''}>২টি (বাম, ডান)</option><option value="3"${room.cap === 3 ? ' selected' : ''}>৩টি (বাম, মাঝ, ডান)</option></select></div>
        <div class="field"><label for="eMove">অন্য সেশনে সরান</label><select id="eMove">
          ${curPlan().sessions.map(s => `<option value="${SP.esc(s.id)}"${s.id === sessionId ? ' selected' : ''}>${SP.esc(s.icon || '')} ${SP.esc(s.name)}</option>`).join('')}</select></div>`,
      buttons: ['spacer', { label: 'বাতিল' }, { label: 'সেভ করুন', cls: 'btn-primary', onClick: bd => {
        let f;
        try { f = readRoomForm(bd, 'e'); } catch (e) { SP.toast(e.message, 'bad'); return false; }
        const target = curPlan().sessions.find(s => s.id === bd.querySelector('#eMove').value);
        if (target.rooms.some(r => r.id !== room.id && sameNo(r.no, f.no))) { SP.toast(`কক্ষ ${SP.bn(f.no)} ওই সেশনে আগেই আছে।`, 'bad'); return false; }
        const test = Object.assign({}, room, f);
        const lost = Object.keys(room.seats).filter(k => !SP.validKey(test, k));
        const lostStudents = lost.filter(k => SP.isStudent(room.seats[k])).length;
        if (lostStudents && !confirm(`বেঞ্চ/আসন কমানোয় ${lostStudents} জন শিক্ষার্থীর আসন বাদ পড়বে। চালিয়ে যাবেন?`)) return false;
        commit(() => {
          Object.assign(room, f);
          lost.forEach(k => delete room.seats[k]);
          if (target.id !== sessionId) {
            const se = curSession();
            se.rooms = se.rooms.filter(r => r.id !== room.id);
            target.rooms.push(room);
          }
        });
        SP.toast('কক্ষের তথ্য হালনাগাদ হয়েছে।', 'ok');
      } }]
    });
  }

  function deleteRoom(room) {
    if (!confirm(`কক্ষ ${SP.bn(room.no)} মুছে ফেলবেন?`)) return;
    commit(() => { const se = curSession(); se.rooms = se.rooms.filter(r => r.id !== room.id); });
  }
  function clearRoom(room) {
    const st = SP.roomStats(room);
    if (!st.assigned && !st.blocked) return SP.toast('কক্ষটি আগে থেকেই খালি।');
    if (!confirm(`কক্ষ ${SP.bn(room.no)}-এর সব আসন (${SP.bn(st.assigned)} জন শিক্ষার্থী ও ${SP.bn(st.blocked)}টি ব্লক) খালি করবেন?`)) return;
    commit(() => { room.seats = {}; });
  }

  function exportWord(room) {
    const el = $('room-' + room.id);
    if (!el) return;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.room-actions, .print-head, button').forEach(b => b.remove());
    clone.querySelectorAll('.seat-found, .swap-source').forEach(c => c.classList.remove('seat-found', 'swap-source'));
    const plan = curPlan(), se = curSession(), s = data.settings;
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>কক্ষ ${SP.bn(SP.esc(room.no))} - আসনবিন্যাস</title>
<style>
 body { font-family: 'SolaimanLipi', 'Kalpurush', 'Nirmala UI', sans-serif; font-size: 13pt; }
 table { border-collapse: collapse; width: 100%; margin-top: 10px; }
 th, td { border: 1px solid #000; padding: 4px; text-align: center; vertical-align: top; }
 th { background: #f2f2f2; }
 .summary-chip { border: 1px solid #999; padding: 2px 6px; margin: 2px; display: inline-block; font-size: 10.5pt; }
 .seat-pos-tag { font-size: 9pt; display: block; color: #333; }
 .s-roll { font-weight: bold; font-size: 13pt; }
 .side-title { text-align: center; margin: 8px 0 0; }
 .aisle-text, .classroom-aisle { display: none; }
</style></head><body>
<p style="text-align:center;margin:0"><img src="${SP.esc(new URL('assets/logo.jpg', location.href).href)}" width="70" height="70" alt=""></p>
<h2 style="text-align:center;margin:0">${SP.esc(s.schoolName)}${s.established ? ` (স্থাপিত: ${SP.esc(s.established)})` : ''}</h2>
<h3 style="text-align:center;margin:4px 0">${SP.esc(plan.title)} — ${SP.esc(se.name)}${se.time ? ` (${SP.esc(se.time)})` : ''}</h3>
<hr>${clone.innerHTML}</body></html>`;
    download(`Seat_Plan_Room_${SP.asciiName(room.no)}.doc`, '﻿' + html, 'application/msword');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ================= আসন ================= */
  function seatTitle(room, key) {
    const p = SP.parseKey(key);
    return `কক্ষ ${SP.bn(room.no)} — ${p.side === 'L' ? 'বাম' : 'ডান'} সারি, বেঞ্চ ${SP.bn(SP.chartBench(room, p.side, p.bench))}, ${SP.posLabel(room.cap, p.c)} আসন`;
  }

  /** পুরো প্ল্যানে একই শিক্ষার্থী কোথায় বসানো আছে */
  function whereSeated(s, except) {
    const id = studentId(s);
    for (const se of curPlan().sessions) for (const r of se.rooms) for (const k in r.seats) {
      if (except && except.room === r && except.key === k) continue;
      if (SP.isStudent(r.seats[k]) && studentId(r.seats[k]) === id) return { se, r, k };
    }
    return null;
  }

  function openSeat(room, key) {
    const s = room.seats[key];
    const student = SP.isStudent(s), blocked = SP.isBlocked(s);
    let v = student ? s : lastSeat;
    let roll = student ? s.roll : '';
    if (!student && lastSeat.roll !== '' && !isNaN(SP.num(lastSeat.roll))) roll = SP.num(lastSeat.roll) + 1;
    const clsDefault = v.cls || ($('aCls').value);
    modal({
      title: student ? '✏ আসনের শিক্ষার্থী' : (blocked ? '🚫 ব্লক করা আসন' : '➕ আসনে শিক্ষার্থী বসান'),
      body: `
        <div class="note">${SP.esc(seatTitle(room, key))}</div>
        <div class="field-row">
          <div class="field"><label for="sCls">শ্রেণি</label><select id="sCls">${SP.optionsHtml(SP.CLASSES, clsDefault)}</select></div>
          <div class="field"><label for="sRoll">রোল</label><input type="text" id="sRoll" inputmode="numeric" value="${SP.esc(SP.bn(roll))}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="sSec">শাখা</label><select id="sSec">${SP.optionsHtml(SP.SECTIONS, v.sec || SP.NA, true)}</select></div>
          <div class="field"><label for="sShift">শিফট</label><select id="sShift">${SP.optionsHtml(SP.SHIFT_OPTS, v.shiftOpt || SP.NA, true)}</select></div>
          <div class="field"><label for="sDept">বিভাগ</label><select id="sDept">${SP.optionsHtml(SP.DEPTS, v.dept || SP.NA, true, true)}</select></div>
        </div>`,
      buttons: [
        ...(student || blocked ? [{ label: '✕ খালি করুন', cls: 'btn-danger', id: 'btnSeatClear', onClick: () => commit(() => { delete room.seats[key]; }) }] : []),
        ...(blocked ? [] : [{ label: '🚫 ব্লক', cls: 'btn-warning', id: 'btnSeatBlock', onClick: () => {
          if (student && !confirm('এই আসনে একজন শিক্ষার্থী আছে। তাকে সরিয়ে আসনটি ব্লক করবেন?')) return false;
          commit(() => { room.seats[key] = { status: 'blocked' }; });
        } }]),
        ...(student ? [{ label: '↔ স্থান বদল', id: 'btnSeatSwap', onClick: () => {
          swapFrom = { roomId: room.id, key };
          showSwapBanner();
          render();
        } }] : []),
        'spacer',
        { label: 'বাতিল' },
        { label: 'সেভ করুন', cls: 'btn-primary', id: 'btnSeatSave', onClick: bd => {
          const rollV = bd.querySelector('#sRoll').value.trim();
          const n = SP.num(rollV);
          if (isNaN(n) || n < 0) { SP.toast('সঠিক রোল নম্বর লিখুন।', 'bad'); return false; }
          const ns = { cls: bd.querySelector('#sCls').value, sec: bd.querySelector('#sSec').value, shiftOpt: bd.querySelector('#sShift').value, dept: bd.querySelector('#sDept').value, roll: n };
          const dup = whereSeated(ns, { room, key });
          if (dup && !confirm(`এই শিক্ষার্থী (${SP.groupLabel(ns)}, রোল ${SP.bn(n)}) আগে থেকেই ${dup.se.name}-এর ${seatTitle(dup.r, dup.k)}-এ বসানো আছে।\n\nতবুও এখানে বসাবেন?`)) return false;
          if (blocked && !confirm('আসনটি ব্লক করা। ব্লক তুলে শিক্ষার্থী বসাবেন?')) return false;
          lastSeat = Object.assign({}, ns);
          commit(() => { room.seats[key] = ns; });
        } }
      ]
    });
  }

  function swapSeats(roomA, keyA, roomB, keyB) {
    if (roomA === roomB && keyA === keyB) return;
    const a = roomA.seats[keyA], b = roomB.seats[keyB];
    if (SP.isBlocked(a) || SP.isBlocked(b)) return SP.toast('ব্লক করা আসনে স্থানান্তর করা যায় না। আগে ব্লক তুলুন।', 'bad');
    commit(() => {
      if (b) roomA.seats[keyA] = b; else delete roomA.seats[keyA];
      if (a) roomB.seats[keyB] = a; else delete roomB.seats[keyB];
    });
  }

  function showSwapBanner() {
    hideSwapBanner();
    const b = document.createElement('div');
    b.className = 'swap-banner'; b.id = 'swapBanner';
    b.innerHTML = '↔ যে আসনের সাথে বদলাতে চান সেটিতে ক্লিক করুন <button class="btn btn-xs" type="button">বাতিল</button>';
    b.querySelector('button').onclick = cancelSwap;
    document.body.appendChild(b);
  }
  function hideSwapBanner() { const b = $('swapBanner'); if (b) b.remove(); }
  function cancelSwap() { swapFrom = null; hideSwapBanner(); render(); }

  /* ================= স্বয়ংক্রিয় বণ্টন ================= */
  /** "১-১০, ১৫, ২০-২৫" → [1..10, 15, 20..25] */
  function parseRolls(str) {
    const out = [];
    const seen = new Set();
    for (const part of String(str).split(/[,،;]+/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.split(/\s*[-–—]\s*/);
      const a = SP.num(m[0]), b = m.length > 1 ? SP.num(m[1]) : a;
      if (isNaN(a) || isNaN(b) || m.length > 2) throw err(`"${t}" বোঝা যায়নি। যেমন লিখুন: ১-৪০ অথবা ১-১০, ১৫`);
      if (Math.abs(b - a) > 2000) throw err('রেঞ্জটি অনেক বড়।');
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
    }
    if (!out.length) throw err('রোল নম্বর লিখুন।');
    return out;
  }

  function autoAssign() {
    const room = findRoom($('aRoom').value);
    if (!room) return SP.toast('আগে একটি কক্ষ যোগ করুন।', 'bad');
    let rolls;
    try { rolls = parseRolls($('aRolls').value); } catch (e) { return SP.toast(e.message, 'bad'); }
    const total = room.left + room.right;
    let from = 1, to = total;
    const bs = $('aBenches').value.trim();
    if (bs) {
      const m = bs.split(/\s*[-–—]\s*/).map(SP.num);
      if (isNaN(m[0]) || (m.length > 1 && isNaN(m[1]))) return SP.toast('বেঞ্চ রেঞ্জ ঠিক নেই। যেমন: ১-৮', 'bad');
      from = Math.max(1, Math.min(m[0], m[1] || m[0]));
      to = Math.min(total, Math.max(m[0], m.length > 1 ? m[1] : m[0]));
      if (from > total) return SP.toast(`এই কক্ষে বেঞ্চ ${SP.bn(total)}টি।`, 'bad');
    }
    const pos = $('aPos').value;
    const okPos = c => pos === 'all' || (pos === 'left' && c === 1) || (pos === 'right' && c === room.cap) ||
      (pos === 'middle' && room.cap === 3 && c === 2) || (pos === 'left_right' && (c === 1 || c === room.cap));
    if (pos === 'middle' && room.cap !== 3) return SP.toast('এই কক্ষের বেঞ্চে মাঝের আসন নেই।', 'bad');

    const base = { cls: $('aCls').value, sec: $('aSec').value, shiftOpt: $('aShift').value, dept: $('aDept').value };
    const already = [], todo = [];
    rolls.forEach(r => (whereSeated(Object.assign({ roll: r }, base)) ? already : todo).push(r));
    if ($('aOrder').value === 'random') {
      for (let i = todo.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [todo[i], todo[j]] = [todo[j], todo[i]]; }
    }
    const free = [];
    for (let n = from; n <= to; n++) {
      const sb = SP.fromChartBench(room, n);
      for (let c = 1; c <= room.cap; c++) {
        if (!okPos(c)) continue;
        const key = SP.seatKey(sb.side, sb.bench, c);
        if (!room.seats[key]) free.push(key);
      }
    }
    const placed = todo.slice(0, free.length);
    const left = todo.slice(free.length);
    if (placed.length) { openRooms.add(room.id); saveOpen(); }
    if (placed.length) commit(() => placed.forEach((r, i) => { room.seats[free[i]] = Object.assign({}, base, { roll: r }); }));

    const fmt = arr => arr.length > 12 ? arr.slice(0, 12).map(SP.bn).join(', ') + ' …' : arr.map(SP.bn).join(', ');
    if (!already.length && !left.length) return SP.toast(`✔ মোট ${SP.bn(placed.length)} জন শিক্ষার্থীকে আসন দেওয়া হয়েছে।`, 'ok');
    modal({
      title: 'আসন বণ্টনের ফলাফল',
      body: `<p style="margin-top:0;font-weight:800">✔ আসন দেওয়া হয়েছে: ${SP.bn(placed.length)} জন</p>
        ${already.length ? `<div class="note">${SP.bn(already.length)} জন আগে থেকেই এই প্ল্যানে বসানো আছে, তাই বাদ দেওয়া হয়েছে (রোল: ${fmt(already)})।</div>` : ''}
        ${left.length ? `<div class="note warn">${SP.bn(left.length)} জনের জন্য নির্বাচিত বেঞ্চে ফাঁকা আসন পাওয়া যায়নি (রোল: ${fmt(left)})। অন্য কক্ষ বা বেঞ্চ বেছে আবার চালান।</div>` : ''}`,
      buttons: ['spacer', { label: 'ঠিক আছে', cls: 'btn-primary' }]
    });
  }

  /* ================= সেটিংস, ইমপোর্ট, ব্যাকআপ ================= */
  function fillSettings() {
    $('setSchool').value = data.settings.schoolName;
    $('setEst').value = data.settings.established || '';
    $('colorGrid').innerHTML = SP.CLASSES.map((c, i) => `
      <div class="color-item"><label for="clr${i}">${SP.esc(c)} শ্রেণি</label>
      <input type="color" id="clr${i}" data-cls="${SP.esc(c)}" value="${SP.esc(data.settings.classColors[c] || '#ffffff')}"></div>`).join('');
  }
  function saveSettings() {
    const name = $('setSchool').value.trim();
    if (!name) return SP.toast('স্কুলের নাম লিখুন।', 'bad');
    const colors = {};
    const used = new Set();
    for (const inp of $('colorGrid').querySelectorAll('input[type=color]')) {
      if (used.has(inp.value)) return SP.toast('একাধিক শ্রেণির জন্য একই রং দেওয়া যাবে না।', 'bad');
      used.add(inp.value);
      colors[nfc(inp.dataset.cls)] = inp.value;
    }
    commit(() => {
      data.settings.schoolName = name;
      data.settings.established = $('setEst').value.trim();
      Object.assign(data.settings.classColors, colors);
    });
    SP.toast('সেটিংস সেভ হয়েছে।', 'ok');
  }

  /** পুরনো সিঙ্গেল-ফাইল HTML থেকে প্ল্যান তৈরি */
  function planFromOldHtml(text) {
    const m = /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:<\/script>|\n)/.exec(text);
    if (!m) throw err('এই ফাইলে সিট প্ল্যানের ডেটা পাওয়া যায়নি।');
    let old;
    try { old = JSON.parse(m[1]); } catch (e) { throw err('ফাইলের ডেটা পড়া যায়নি।'); }
    const shifts = old.shifts || {};
    const mk = (key, name, icon) => SP.newSession(name, icon, (shifts[key] || {}).time || '', (shifts[key] || {}).classes || '');
    const plan = { id: SP.uid('p'), title: (old.examTitle || 'ইমপোর্ট করা পরীক্ষা') + ' (ইমপোর্ট)', published: false, updatedAt: new Date().toISOString(),
      sessions: [mk('morning', 'সকালের পরীক্ষা', '☀'), mk('evening', 'বিকালের পরীক্ষা', '🌙')] };
    let rooms = 0, students = 0;
    ['morning', 'evening'].forEach((key, i) => {
      Object.values(old[key] || {}).forEach(r => {
        const room = { id: SP.uid('r'), no: String(r.no), floor: r.floor || '', left: +r.leftBenches || 8, right: +r.rightBenches || 8, cap: +r.capacity || 3, seats: {} };
        Object.keys(r.seats || {}).forEach(k => { if (SP.validKey(room, k)) room.seats[k] = r.seats[k]; });
        rooms++;
        students += SP.roomStats(room).assigned;
        plan.sessions[i].rooms.push(room);
      });
    });
    if (!rooms) throw err('ফাইলে কোনো কক্ষ নেই।');
    return { plan: SP.normalizeData({ plans: [plan] }).plans[0], rooms, students };
  }

  function readFile(input, cb) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => cb(String(r.result));
    r.onerror = () => SP.toast('ফাইল পড়া যায়নি।', 'bad');
    r.readAsText(f, 'utf-8');
  }

  /* ================= ইভেন্ট ================= */
  function bindEvents() {
    $('btnUndo').onclick = undo;
    $('btnPublish').onclick = publish;
    $('btnDiscard').onclick = () => {
      if (!confirm('সব অপ্রকাশিত পরিবর্তন বাদ দিয়ে ওয়েবসাইটের সংস্করণে ফিরে যাবেন?')) return;
      commit(() => { data = SP.normalizeData(JSON.parse(serverJson)); if (!data.plans.length) data.plans.push(SP.newPlan('নতুন পরীক্ষা')); });
    };
    document.querySelector('.status-bar').addEventListener('click', e => { if (e.target.closest('[data-conn]')) openConnect(false); });

    $('planSelect').onchange = () => { planId = $('planSelect').value; sessionId = null; cancelSwapSilently(); render(); };
    $('planTitle').onchange = () => {
      const t = $('planTitle').value.trim();
      if (!t) { $('planTitle').value = curPlan().title; return; }
      commit(() => { curPlan().title = t; });
    };
    $('planPublished').onchange = () => {
      const on = $('planPublished').checked;
      commit(() => { curPlan().published = on; });
      SP.toast(on ? 'প্রকাশ করার পর এই প্ল্যান শিক্ষার্থীরা দেখতে পাবে।' : 'এই প্ল্যান শিক্ষার্থীদের কাছে লুকানো থাকবে।');
    };
    $('defaultSlot').addEventListener('click', e => {
      if (!e.target.closest('#btnMakeDefault')) return;
      commit(() => { data.settings.defaultPlanId = planId; });
      SP.toast('প্রকাশ করার পর শিক্ষার্থীরা শুরুতে এই পরীক্ষাটি দেখবে।', 'ok');
    });
    $('btnNewPlan').onclick = openNewPlan;
    $('btnDeletePlan').onclick = deletePlan;

    $('sessionTabs').addEventListener('click', e => {
      if (e.target.closest('#btnAddSession')) return openAddSession();
      const b = e.target.closest('[data-session]');
      if (b) { sessionId = b.dataset.session; cancelSwapSilently(); render(); }
    });
    $('btnSaveSession').onclick = saveSession;
    $('btnDeleteSession').onclick = deleteSession;
    $('btnAddRoom').onclick = addRoom;
    $('btnAuto').onclick = autoAssign;

    document.querySelector('details.tools:not([open])').addEventListener('toggle', e => { if (e.target.open) fillSettings(); });
    $('btnSaveSettings').onclick = saveSettings;
    $('btnImportOld').onclick = () => $('fileOld').click();
    $('fileOld').onchange = () => readFile($('fileOld'), text => {
      let res;
      try { res = planFromOldHtml(text); } catch (e) { return SP.toast(e.message, 'bad', 6000); }
      if (!confirm(`ফাইলে ${res.rooms}টি কক্ষ ও ${res.students} জন শিক্ষার্থীর আসন পাওয়া গেছে।\n"${res.plan.title}" নামে নতুন প্ল্যান হিসেবে যোগ করবেন?`)) return;
      commit(() => { data.plans.unshift(res.plan); planId = res.plan.id; sessionId = null; });
      SP.toast('ইমপোর্ট সম্পন্ন। দেখে নিয়ে প্রকাশ করুন।', 'ok');
    });
    $('btnBackup').onclick = () => {
      const d = new Date();
      download(`seat-plan-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`, JSON.stringify(data, null, 1), 'application/json');
    };
    $('btnRestore').onclick = () => $('fileBackup').click();
    $('fileBackup').onchange = () => readFile($('fileBackup'), text => {
      let d;
      try { d = SP.normalizeData(JSON.parse(text)); } catch (e) { return SP.toast('ব্যাকআপ ফাইলটি পড়া যায়নি।', 'bad'); }
      if (!d.plans.length) return SP.toast('ব্যাকআপে কোনো প্ল্যান নেই।', 'bad');
      if (!confirm(`ব্যাকআপে ${d.plans.length}টি প্ল্যান আছে। বর্তমান সব ডেটা এগুলো দিয়ে বদলে দেবেন?`)) return;
      commit(() => { data = d; planId = d.plans[0].id; sessionId = null; });
      fillSettings();
      SP.toast('ব্যাকআপ থেকে ফেরত আনা হয়েছে। দেখে নিয়ে প্রকাশ করুন।', 'ok');
    });

    const rooms = $('rooms');
    rooms.addEventListener('click', e => {
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const id = tg.dataset.toggle;
        openRooms.has(id) ? openRooms.delete(id) : openRooms.add(id);
        saveOpen(); render();
        return;
      }
      if (e.target.closest('[data-openall]') || e.target.closest('[data-closeall]')) {
        const all = !!e.target.closest('[data-openall]');
        curSession().rooms.forEach(r => all ? openRooms.add(r.id) : openRooms.delete(r.id));
        saveOpen(); render();
        return;
      }
      const card = e.target.closest('[data-room]');
      if (!card) return;
      const room = findRoom(card.dataset.room);
      if (!room) return;
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'edit') editRoom(room);
        else if (a === 'delete') deleteRoom(room);
        else if (a === 'clear') clearRoom(room);
        else if (a === 'word') exportWord(room);
        return;
      }
      const cell = e.target.closest('[data-seat]');
      if (!cell) return;
      if (swapFrom) {
        const src = findRoom(swapFrom.roomId);
        const key = swapFrom.key;
        swapFrom = null; hideSwapBanner();
        if (src) swapSeats(src, key, room, cell.dataset.seat);
        render();
        return;
      }
      openSeat(room, cell.dataset.seat);
    });
    rooms.addEventListener('dragstart', e => {
      const cell = e.target.closest && e.target.closest('[data-seat]');
      if (!cell) return;
      dragSrc = { roomId: cell.closest('[data-room]').dataset.room, key: cell.dataset.seat };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragSrc));
    });
    rooms.addEventListener('dragover', e => {
      const cell = e.target.closest && e.target.closest('[data-seat]');
      if (!cell || !dragSrc) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      rooms.querySelectorAll('.drag-over').forEach(c => c !== cell && c.classList.remove('drag-over'));
      cell.classList.add('drag-over');
    });
    rooms.addEventListener('dragleave', e => {
      const cell = e.target.closest && e.target.closest('[data-seat]');
      if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove('drag-over');
    });
    rooms.addEventListener('drop', e => {
      const cell = e.target.closest && e.target.closest('[data-seat]');
      if (!cell || !dragSrc) return;
      e.preventDefault();
      cell.classList.remove('drag-over');
      const src = findRoom(dragSrc.roomId);
      const dst = findRoom(cell.closest('[data-room]').dataset.room);
      const key = dragSrc.key;
      dragSrc = null;
      if (src && dst) swapSeats(src, key, dst, cell.dataset.seat);
    });
    rooms.addEventListener('dragend', () => { dragSrc = null; rooms.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over')); });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('modal')) closeModal();
      else if (swapFrom) cancelSwap();
    });
    window.addEventListener('beforeunload', saveDraft);
    rooms.addEventListener('input', e => {
      if (e.target.id !== 'roomFilter') return;
      roomFilter = e.target.value;
      applyRoomFilter();
    });
    // প্রিন্টে সব কক্ষ খোলা অবস্থায় যায়
    window.addEventListener('beforeprint', () => { printAll = true; render(); });
    window.addEventListener('afterprint', () => { printAll = false; render(); });
  }
  function cancelSwapSilently() { swapFrom = null; hideSwapBanner(); }

  start();
})();
