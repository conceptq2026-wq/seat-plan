/* সিট প্ল্যান — শিক্ষার্থী ও এডমিন দুই পাতার সাধারণ কোড */
(function () {
  'use strict';

  const SP = {};
  window.SP = SP;

  SP.NA = 'প্রযোজ্য নয়';
  const nfc = s => (typeof s === 'string' ? s.normalize('NFC') : s);
  SP.nfc = nfc;

  /* ---------- সংখ্যা ও লেখা ---------- */
  const BN = '০১২৩৪৫৬৭৮৯';
  SP.bn = v => (v === null || v === undefined) ? '' : String(v).replace(/[0-9]/g, d => BN[d]);
  SP.num = v => {
    if (v === null || v === undefined || v === '') return NaN;
    return parseInt(String(v).trim().replace(/[০-৯]/g, d => BN.indexOf(d)), 10);
  };
  SP.esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  SP.uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  SP.clone = o => JSON.parse(JSON.stringify(o));

  /* ---------- ডিফল্ট মান ---------- */
  SP.CLASSES = ['৩য়', '৪র্থ', '৫ম', '৬ষ্ঠ', '৭ম', '৮ম', '৯ম', '১০ম'].map(nfc);
  SP.SECTIONS = ['ক', 'খ', 'গ', 'ঘ'].map(nfc);
  SP.SHIFT_OPTS = ['প্রভাতি', 'দিবা'].map(nfc);
  SP.DEPTS = ['বিজ্ঞান', 'মানবিক', 'ব্যবসায় শিক্ষা'].map(nfc);
  SP.DEFAULT_COLORS = {
    '৩য়': '#bbf7d0', '৪র্থ': '#fef08a', '৫ম': '#fca5a5', '৬ষ্ঠ': '#bfdbfe',
    '৭ম': '#e9d5ff', '৮ম': '#fed7aa', '৯ম': '#fbcfe8', '১০ম': '#cbd5e1'
  };

  function deepNfc(o) {
    if (typeof o === 'string') return nfc(o);
    if (Array.isArray(o)) return o.map(deepNfc);
    if (o && typeof o === 'object') {
      const out = {};
      for (const k in o) out[nfc(k)] = deepNfc(o[k]);
      return out;
    }
    return o;
  }

  SP.newSession = (name, icon, time, classes) => ({ id: SP.uid('s'), name, icon: icon || '📝', time: time || '', classes: classes || '', rooms: [] });
  SP.newPlan = title => ({
    id: SP.uid('p'), title, published: false, updatedAt: new Date().toISOString(),
    sessions: [SP.newSession('সকালের পরীক্ষা', '☀'), SP.newSession('বিকালের পরীক্ষা', '🌙')]
  });

  /** ডেটা যেকোনো অবস্থায় থাকুক, প্রয়োজনীয় ঘরগুলো নিশ্চিত করে */
  SP.normalizeData = function (raw) {
    const d = deepNfc(raw && typeof raw === 'object' ? raw : {});
    d.version = 1;
    d.settings = d.settings || {};
    const s = d.settings;
    if (!s.schoolName) s.schoolName = 'সরকারি জুবিলী উচ্চ বিদ্যালয়, সুনামগঞ্জ';
    if (s.established === undefined) s.established = '১৮৮৭';
    s.classColors = Object.assign({}, deepNfc(SP.DEFAULT_COLORS), s.classColors || {});
    d.plans = Array.isArray(d.plans) ? d.plans : [];
    d.plans.forEach(p => {
      p.id = p.id || SP.uid('p');
      p.title = p.title || 'নামহীন পরীক্ষা';
      p.published = !!p.published;
      p.sessions = Array.isArray(p.sessions) ? p.sessions : [];
      p.sessions.forEach(se => {
        se.id = se.id || SP.uid('s');
        se.name = se.name || 'সেশন';
        se.rooms = Array.isArray(se.rooms) ? se.rooms : [];
        se.rooms.forEach(r => {
          r.id = r.id || SP.uid('r');
          r.no = String(r.no || '');
          r.left = parseInt(r.left, 10) || 0;
          r.right = parseInt(r.right, 10) || 0;
          r.cap = [1, 2, 3].includes(parseInt(r.cap, 10)) ? parseInt(r.cap, 10) : 3;
          r.seats = r.seats && typeof r.seats === 'object' ? r.seats : {};
        });
      });
    });
    return d;
  };

  /* ---------- রিপো ও ডেটা লোড ---------- */
  /** ওয়েবসাইটের ঠিকানা থেকে GitHub রিপো বের করে (owner.github.io/repo), কনফিগ বা এডমিনের সেটিং থাকলে সেটাই আগে */
  SP.repoInfo = function (ignoreSaved) {
    const cfg = window.SEATPLAN_CONFIG || {};
    let saved = {};
    if (!ignoreSaved) {
      try { saved = JSON.parse(localStorage.getItem('seatplan_repo') || '{}'); } catch (e) { /* ignore */ }
    }
    let owner = '', repo = '';
    const host = location.hostname.toLowerCase();
    if (host.endsWith('.github.io')) {
      owner = host.replace(/\.github\.io$/, '');
      const first = location.pathname.split('/').filter(Boolean)[0];
      repo = (first && !/\.html?$/i.test(first)) ? first : host;
    }
    return {
      owner: saved.owner || cfg.owner || owner,
      repo: saved.repo || cfg.repo || repo,
      branch: saved.branch || cfg.branch || '',
      dataPath: cfg.dataPath || 'data/plans.json'
    };
  };

  SP.loadPublicData = async function () {
    const path = (window.SEATPLAN_CONFIG && window.SEATPLAN_CONFIG.dataPath) || 'data/plans.json';
    const res = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('ডেটা ফাইল পাওয়া যায়নি (' + res.status + ')');
    return SP.normalizeData(await res.json());
  };

  /* ---------- আসনের হিসাব ---------- */
  SP.seatKey = (side, bench, c) => `b${side}-${bench}-s${c}`;
  SP.parseKey = key => {
    const m = /^b([LR])-(\d+)-s(\d)$/.exec(key);
    return m ? { side: m[1], bench: +m[2], c: +m[3] } : null;
  };
  /** চার্টে যে বেঞ্চ নম্বর ছাপা হয় (ডান সারি বাম সারির পর থেকে গোনা) */
  SP.chartBench = (room, side, bench) => side === 'R' ? room.left + bench : bench;
  /** চার্টের বেঞ্চ নম্বর → {side, bench} */
  SP.fromChartBench = (room, n) => {
    if (n >= 1 && n <= room.left) return { side: 'L', bench: n };
    if (n > room.left && n <= room.left + room.right) return { side: 'R', bench: n - room.left };
    return null;
  };
  SP.posLabel = (cap, c) => cap === 1 ? 'একক' : (c === 1 ? 'বাম' : (cap === 3 && c === 2 ? 'মাঝ' : 'ডান'));
  SP.isStudent = s => !!s && s.status !== 'blocked' && s.roll !== undefined && s.roll !== null && s.roll !== '';
  SP.isBlocked = s => !!s && s.status === 'blocked';
  SP.validKey = (room, key) => {
    const p = SP.parseKey(key);
    if (!p) return false;
    const max = p.side === 'L' ? room.left : room.right;
    return p.bench >= 1 && p.bench <= max && p.c >= 1 && p.c <= room.cap;
  };
  /** সব আসন চার্টের ক্রমে (বাম সারি ১..n, তারপর ডান সারি) */
  SP.allKeys = room => {
    const keys = [];
    for (const side of ['L', 'R']) {
      const n = side === 'L' ? room.left : room.right;
      for (let b = 1; b <= n; b++) for (let c = 1; c <= room.cap; c++) keys.push(SP.seatKey(side, b, c));
    }
    return keys;
  };

  SP.groupLabel = s => {
    const sec = (s.sec && s.sec !== SP.NA) ? ` (${s.sec})` : '';
    const sh = (s.shiftOpt && s.shiftOpt !== SP.NA) ? ` ${s.shiftOpt}` : '';
    const dp = (s.dept && s.dept !== SP.NA) ? `, ${s.dept}` : '';
    return `${s.cls}${sec}${sh}${dp}`;
  };

  SP.roomStats = room => {
    const keys = SP.allKeys(room);
    let assigned = 0, blocked = 0;
    const groups = {};
    keys.forEach(k => {
      const s = room.seats[k];
      if (SP.isBlocked(s)) blocked++;
      else if (SP.isStudent(s)) {
        assigned++;
        const g = SP.groupLabel(s);
        (groups[g] = groups[g] || []).push(SP.num(s.roll));
      }
    });
    return { capacity: keys.length, assigned, blocked, empty: keys.length - assigned - blocked, groups };
  };

  /* ---------- কক্ষ আঁকা ---------- */
  function seatCellHtml(room, side, b, c, opts) {
    const key = SP.seatKey(side, b, c);
    const s = room.seats[key];
    const blocked = SP.isBlocked(s);
    const student = SP.isStudent(s);
    const color = student && opts.colors[s.cls] ? `background-color:${SP.esc(opts.colors[s.cls])};` : '';
    const cls = ['seat-cell', blocked ? 'is-blocked' : '', student ? 'has-student' : '', opts.highlight === key ? 'seat-found' : ''].join(' ').trim();
    const drag = opts.admin && student ? ' draggable="true"' : '';
    let inner;
    if (blocked) inner = '<span class="seat-blocked-text">🚫 ফাঁকা</span>';
    else if (student) {
      const sec = (s.sec && s.sec !== SP.NA) ? ` | ${SP.esc(s.sec)}` : '';
      const sh = (s.shiftOpt && s.shiftOpt !== SP.NA) ? ` | ${SP.esc(s.shiftOpt)}` : '';
      const dp = (s.dept && s.dept !== SP.NA) ? ` (${SP.esc(s.dept)})` : '';
      inner = `<div class="s-card"><div class="s-cls">${SP.esc(s.cls)}${dp}</div><div class="s-detail">${sec}${sh}</div><div class="s-roll">রোল: ${SP.bn(SP.esc(s.roll))}</div></div>`;
    } else inner = '<span class="seat-empty">ফাঁকা</span>';
    return `<td class="${cls}" style="${color}" data-seat="${key}"${drag}><span class="seat-pos-tag">${SP.posLabel(room.cap, c)}</span>${inner}</td>`;
  }

  function benchTable(room, side, opts) {
    const n = side === 'L' ? room.left : room.right;
    let h = '<table class="bench-table"><thead><tr><th>বেঞ্চ</th>';
    for (let c = 1; c <= room.cap; c++) h += `<th>${SP.posLabel(room.cap, c)}</th>`;
    h += '</tr></thead><tbody>';
    for (let b = 1; b <= n; b++) {
      h += `<tr><td><b>${SP.bn(SP.chartBench(room, side, b))}</b></td>`;
      for (let c = 1; c <= room.cap; c++) h += seatCellHtml(room, side, b, c, opts);
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  /**
   * opts: { admin, colors, highlight (seat key), printHead (string html), actionsHtml }
   */
  SP.renderRoom = function (room, opts) {
    const st = SP.roomStats(room);
    const chips = Object.keys(st.groups).map(g => {
      const r = st.groups[g].sort((a, b) => a - b);
      const range = r[0] === r[r.length - 1] ? SP.bn(r[0]) : `${SP.bn(r[0])}-${SP.bn(r[r.length - 1])}`;
      return `<span class="summary-chip">${SP.esc(g)}, রোল রেঞ্জ: ${range} = <b>${SP.bn(r.length)}</b> জন</span>`;
    }).join(' ') || '<span class="summary-chip neutral">কোন শিক্ষার্থী বরাদ্দ নেই</span>';

    const leftSide = room.left > 0 ? `
      <div class="classroom-side" style="flex:${room.left}">
        <h4 class="side-title">বাম সারি (বেঞ্চ ১ - ${SP.bn(room.left)})</h4>
        ${benchTable(room, 'L', opts)}
      </div>` : '';
    const rightSide = room.right > 0 ? `
      <div class="classroom-side" style="flex:${room.right}">
        <h4 class="side-title">ডান সারি (বেঞ্চ ${SP.bn(room.left + 1)} - ${SP.bn(room.left + room.right)})</h4>
        ${benchTable(room, 'R', opts)}
      </div>` : '';
    const aisle = room.left > 0 && room.right > 0 ? '<div class="classroom-aisle"><span class="aisle-text">চলাচলের রাস্তা</span></div>' : '';

    return `
      <article class="room-card" id="room-${SP.esc(room.id)}" data-room="${SP.esc(room.id)}">
        <header class="room-header">
          ${opts.printHead ? `<div class="print-head">${opts.printHead}</div>` : ''}
          <div class="room-top-bar">
            <div>
              <span class="room-title">কক্ষ নম্বর: ${SP.bn(SP.esc(room.no))}</span>
              <span class="room-meta">(${SP.esc(room.floor || '')}${room.floor ? ' | ' : ''}বেঞ্চ প্রতি সিট: ${SP.bn(room.cap)}টি)</span>
            </div>
            ${opts.actionsHtml ? `<div class="room-actions">${opts.actionsHtml}</div>` : ''}
          </div>
          <div class="room-summary-bar">
            <div class="summary-group">
              <span class="summary-title">📊 আসন পরিসংখ্যান:</span>
              <span class="summary-chip">মোট ক্ষমতা: <b>${SP.bn(st.capacity)}</b>টি</span>
              <span class="summary-chip assigned">বরাদ্দকৃত: <b>${SP.bn(st.assigned)}</b> জন</span>
              <span class="summary-chip empty">ফাঁকা আসন: <b>${SP.bn(st.empty)}</b>টি</span>
              ${st.blocked ? `<span class="summary-chip blocked">ব্লকড: <b>${SP.bn(st.blocked)}</b>টি</span>` : ''}
            </div>
            <div class="summary-group">
              <span class="summary-title">🎓 শ্রেণি ভিত্তিক বন্টন:</span>
              ${chips}
            </div>
          </div>
        </header>
        <div class="classroom-scroll"><div class="classroom-grid-wrapper">${leftSide}${aisle}${rightSide}</div></div>
      </article>`;
  };

  SP.printHead = (settings, plan, session) =>
    `<div style="font-size:20px;font-weight:800">${SP.esc(settings.schoolName)}${settings.established ? ` (স্থাপিত: ${SP.esc(settings.established)})` : ''}</div>
     <div style="font-size:16px;font-weight:700">${SP.esc(plan.title)} — ${SP.esc(session.icon || '')} ${SP.esc(session.name)}${session.time ? ` (${SP.esc(session.time)})` : ''}</div>`;

  SP.sessionTabsHtml = (plan, currentId, extraHtml) =>
    plan.sessions.map(se => `
      <button class="shift-btn${se.id === currentId ? ' active' : ''}" data-session="${SP.esc(se.id)}">
        <span class="btn-title">${SP.esc(se.icon || '')} ${SP.esc(se.name)}</span>
        ${se.time ? `<span class="btn-time">${SP.esc(se.time)}</span>` : ''}
        ${se.classes ? `<span class="btn-classes">শ্রেণি: ${SP.esc(se.classes)}</span>` : ''}
      </button>`).join('') + (extraHtml || '');

  SP.optionsHtml = (list, selected, withNA, naFirst) => {
    const items = list.slice();
    if (withNA) naFirst ? items.unshift(SP.NA) : items.push(SP.NA);
    return items.map(v => `<option value="${SP.esc(v)}"${nfc(v) === nfc(selected) ? ' selected' : ''}>${SP.esc(v)}</option>`).join('');
  };

  /* ---------- খোঁজা ---------- */
  /** একটি প্ল্যানের সব সেশন ও কক্ষে শ্রেণি + রোল দিয়ে খোঁজে; শাখা/শিফট/বিভাগ দেওয়া থাকলে মিলিয়ে দেখে */
  SP.findSeats = function (plan, q) {
    const out = [];
    const want = SP.num(q.roll);
    if (isNaN(want)) return out;
    const opt = (given, have) => !given || given === SP.NA || !have || have === SP.NA || nfc(given) === nfc(have);
    plan.sessions.forEach(se => se.rooms.forEach(room => {
      SP.allKeys(room).forEach(key => {
        const s = room.seats[key];
        if (!SP.isStudent(s)) return;
        if (SP.num(s.roll) !== want || nfc(s.cls) !== nfc(q.cls)) return;
        if (!opt(q.sec, s.sec) || !opt(q.shiftOpt, s.shiftOpt) || !opt(q.dept, s.dept)) return;
        const p = SP.parseKey(key);
        out.push({ session: se, room, key, seat: s, side: p.side, bench: SP.chartBench(room, p.side, p.bench), pos: SP.posLabel(room.cap, p.c) });
      });
    }));
    return out;
  };

  /* ---------- ছোট বার্তা ---------- */
  SP.toast = function (msg, kind, ms) {
    let box = document.querySelector('.toast-box');
    if (!box) { box = document.createElement('div'); box.className = 'toast-box'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), ms || 3500);
  };
})();
