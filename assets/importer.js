/* Excel (.xlsx) ও CSV থেকে শিক্ষার্থীর তালিকা পড়া — কোনো বাইরের লাইব্রেরি ছাড়া */
(function () {
  'use strict';
  const SP = window.SP;
  const nfc = SP.nfc;
  const IM = {};
  SP.importer = IM;

  function fail(msg) { const e = new Error(msg); e.userMessage = true; return e; }

  /* ---------- .xlsx: zip খুলে XML পড়া ---------- */
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw fail('ফাইলটি সঠিক Excel (.xlsx) ফাইল নয়।');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      files[dec.decode(u8.subarray(p + 46, p + 46 + nameLen))] = { method, csize, localOff };
      p += 46 + nameLen + extraLen + commLen;
    }
    return async function read(name) {
      const f = files[name];
      if (!f) return null;
      const lo = f.localOff;
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const data = u8.subarray(start, start + f.csize);
      if (f.method === 0) return dec.decode(data);
      if (f.method !== 8) throw fail('এই Excel ফাইলের ধরন পড়া যাচ্ছে না। CSV হিসেবে সেভ করে দিন।');
      if (typeof DecompressionStream === 'undefined') throw fail('এই ব্রাউজারে Excel পড়া যায় না। Chrome হালনাগাদ করুন বা ফাইলটি CSV হিসেবে সেভ করে দিন।');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return dec.decode(await new Response(stream).arrayBuffer());
    };
  }

  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  async function readXlsx(buf) {
    const read = await unzip(buf);
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await read('xl/workbook.xml');
    const rels = await read('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = xml(wb).getElementsByTagName('sheet')[0];
      const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = [...xml(rels).getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    }
    const shared = [];
    const ss = await read('xl/sharedStrings.xml');
    if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    const sheet = await read(sheetPath);
    if (!sheet) throw fail('Excel ফাইলে কোনো শিট পাওয়া যায়নি।');
    const rows = [];
    for (const row of xml(sheet).getElementsByTagName('row')) {
      const out = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's') val = v ? (shared[+v.textContent] || '') : '';
        else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
        else val = v ? v.textContent : '';
        out[colIndex(c.getAttribute('r') || 'A1')] = val;
      }
      rows.push(Array.from(out, x => (x === undefined ? '' : String(x))));
    }
    return rows;
  }

  /* ---------- CSV ---------- */
  function readCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ---------- মান চেনা ---------- */
  const CLASS_WORDS = {
    'তৃতীয়': 3, 'চতুর্থ': 4, 'পঞ্চম': 5, 'ষষ্ঠ': 6, 'সপ্তম': 7, 'অষ্টম': 8, 'নবম': 9, 'দশম': 10,
    three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6,
    seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10
  };
  IM.mapClass = v => {
    const s = nfc(String(v || '')).trim().toLowerCase();
    if (!s) return null;
    const exact = SP.CLASSES.find(c => c === s);
    if (exact) return exact;
    const m = SP.digitsEn(s).match(/\d+/);
    if (m) { const n = +m[0]; return n >= 3 && n <= 10 ? SP.CLASSES[n - 3] : null; }
    for (const w in CLASS_WORDS) if (s.includes(nfc(w))) return SP.CLASSES[CLASS_WORDS[w] - 3];
    return null;
  };
  IM.mapSection = v => {
    const s = nfc(String(v || '')).trim().toLowerCase().replace(/^(section|sec|শাখা)[\s:.-]*/, '');
    if (!s || s === '-' || s === nfc(SP.NA)) return SP.NA;
    const map = { a: 'ক', ka: 'ক', b: 'খ', kha: 'খ', c: 'গ', ga: 'গ', d: 'ঘ', gha: 'ঘ' };
    if (map[s]) return nfc(map[s]);
    const hit = SP.SECTIONS.find(x => s.startsWith(x));
    return hit || null;
  };
  IM.mapShift = v => {
    const s = nfc(String(v || '')).trim().toLowerCase();
    if (!s || s === '-' || s === nfc(SP.NA)) return SP.NA;
    if (/^(প্রভাত|morning|m$)/.test(s)) return SP.SHIFT_OPTS[0];
    if (/^(দিবা|day|d$)/.test(s)) return SP.SHIFT_OPTS[1];
    return null;
  };
  IM.mapDept = v => {
    const s = nfc(String(v || '')).trim().toLowerCase();
    if (!s || s === '-' || s === nfc(SP.NA)) return SP.NA;
    if (/^(বিজ্ঞান|science|sci)/.test(s)) return SP.DEPTS[0];
    if (/^(মানবিক|humanities|arts?)/.test(s)) return SP.DEPTS[1];
    if (/^(ব্যবসা|business|commerce|bs)/.test(s)) return SP.DEPTS[2];
    return null;
  };

  const HEAD = {
    roll: /রোল|roll/i,
    cls: /শ্রেণ|class|grade/i,
    sec: /শাখা|section|^sec/i,
    shift: /শিফট|shift/i,
    dept: /বিভাগ|group|dept|department/i,
    name: /নাম|name/i
  };

  /**
   * ফাইল → { rows: [{cls, sec, shiftOpt, dept, roll}], warnings: [], ignoredName: bool }
   * fallbackCls: ফাইলে শ্রেণি কলাম না থাকলে এই শ্রেণি ধরা হবে
   */
  IM.readStudents = async function (file, fallbackCls) {
    const isXlsx = /\.xlsx$/i.test(file.name);
    if (/\.xls$/i.test(file.name)) throw fail('পুরনো .xls ফাইল পড়া যায় না। Excel-এ "Save As" দিয়ে .xlsx বা CSV হিসেবে সেভ করে আবার দিন।');
    const table = isXlsx ? await readXlsx(await file.arrayBuffer()) : readCsv(await file.text());
    const rows = table.map(r => r.map(c => nfc(String(c || '')).trim())).filter(r => r.some(Boolean));
    if (!rows.length) throw fail('ফাইলটি খালি।');

    // শিরোনামের সারি খোঁজা (প্রথম ৫ সারির মধ্যে "রোল" কলাম)
    let hi = rows.slice(0, 5).findIndex(r => r.some(c => HEAD.roll.test(c)));
    const col = {};
    if (hi >= 0) {
      rows[hi].forEach((c, i) => {
        for (const k of ['roll', 'cls', 'sec', 'shift', 'dept', 'name']) if (col[k] === undefined && HEAD[k].test(c)) { col[k] = i; break; }
      });
    } else if (rows.every(r => r.filter(Boolean).length === 1 && !isNaN(SP.num(r.find(Boolean))))) {
      col.roll = rows[0].findIndex(Boolean); hi = -1;
    } else {
      throw fail('ফাইলে "রোল" কলাম পাওয়া যায়নি। প্রথম সারিতে শিরোনাম দিন: শ্রেণি, শাখা, শিফট, বিভাগ, রোল। নমুনা ফাইলটি দেখুন।');
    }
    if (col.cls === undefined && !fallbackCls) throw fail('ফাইলে "শ্রেণি" কলাম নেই। শ্রেণি কলাম যোগ করুন, অথবা বণ্টনের ঘরে শ্রেণি বেছে দিন।');

    const out = [], warnings = [];
    const bad = { cls: 0, sec: 0, shift: 0, dept: 0, roll: 0 };
    rows.slice(hi + 1).forEach(r => {
      const rollRaw = r[col.roll];
      if (!rollRaw) return;
      const roll = Math.round(parseFloat(SP.digitsEn(rollRaw)));
      if (isNaN(roll)) { bad.roll++; return; }
      const cls = col.cls !== undefined ? IM.mapClass(r[col.cls]) : fallbackCls;
      if (!cls) { bad.cls++; return; }
      let sec = col.sec !== undefined ? IM.mapSection(r[col.sec]) : SP.NA;
      let shiftOpt = col.shift !== undefined ? IM.mapShift(r[col.shift]) : SP.NA;
      let dept = col.dept !== undefined ? IM.mapDept(r[col.dept]) : SP.NA;
      if (sec === null) { bad.sec++; sec = SP.NA; }
      if (shiftOpt === null) { bad.shift++; shiftOpt = SP.NA; }
      if (dept === null) { bad.dept++; dept = SP.NA; }
      out.push({ cls, sec, shiftOpt, dept, roll });
    });
    if (bad.roll) warnings.push(`${SP.bn(bad.roll)}টি সারির রোল সংখ্যা নয়, বাদ দেওয়া হয়েছে।`);
    if (bad.cls) warnings.push(`${SP.bn(bad.cls)}টি সারির শ্রেণি চেনা যায়নি (৩য় থেকে ১০ম হতে হবে), বাদ দেওয়া হয়েছে।`);
    if (bad.sec) warnings.push(`${SP.bn(bad.sec)}টি সারির শাখা চেনা যায়নি, "প্রযোজ্য নয়" ধরা হয়েছে।`);
    if (bad.shift) warnings.push(`${SP.bn(bad.shift)}টি সারির শিফট চেনা যায়নি, "প্রযোজ্য নয়" ধরা হয়েছে।`);
    if (bad.dept) warnings.push(`${SP.bn(bad.dept)}টি সারির বিভাগ চেনা যায়নি, "প্রযোজ্য নয়" ধরা হয়েছে।`);
    if (!out.length) throw fail('ফাইলে কোনো শিক্ষার্থী পাওয়া যায়নি। ' + warnings.join(' '));
    return { rows: out, warnings, ignoredName: col.name !== undefined };
  };

  /** একই শ্রেণি/শাখা/শিফট/বিভাগের শিক্ষার্থীদের এক দলে */
  IM.groupRows = rows => {
    const map = new Map();
    rows.forEach(r => {
      const k = [r.cls, r.sec, r.shiftOpt, r.dept].join('|');
      if (!map.has(k)) map.set(k, { cls: r.cls, sec: r.sec, shiftOpt: r.shiftOpt, dept: r.dept, rolls: [] });
      const g = map.get(k);
      if (!g.rolls.includes(r.roll)) g.rolls.push(r.roll);
    });
    return [...map.values()].map(g => (g.rolls.sort((a, b) => a - b), g));
  };

  /** [1,2,3,5,7,8] → "১-৩, ৫, ৭-৮" */
  IM.rangeText = rolls => {
    const r = rolls.slice().sort((a, b) => a - b), parts = [];
    for (let i = 0; i < r.length; i++) {
      let j = i;
      while (j + 1 < r.length && r[j + 1] === r[j] + 1) j++;
      parts.push(i === j ? SP.bn(r[i]) : `${SP.bn(r[i])}-${SP.bn(r[j])}`);
      i = j;
    }
    return parts.join(', ');
  };

  IM.sampleCsv = () => '﻿' + [
    'শ্রেণি,শাখা,শিফট,বিভাগ,রোল',
    '৮ম,ক,দিবা,প্রযোজ্য নয়,১',
    '৮ম,ক,দিবা,প্রযোজ্য নয়,২',
    '৯ম,খ,প্রভাতি,বিজ্ঞান,১',
    '৯ম,খ,প্রভাতি,বিজ্ঞান,২'
  ].join('\r\n') + '\r\n';
})();
