/* Backup file for Match Control: one Excel workbook (.xlsx) that people can open, print and keep, and that the
   offline Match Control file can load back. No library and no network: the workbook is written by hand
   (Office Open XML in an uncompressed zip). The full data travels as JSON in a hidden "_backup" sheet. */
window.ALLOUT_BACKUP = (() => {
  'use strict';
  const enc = new TextEncoder();
  /* ---------------------------------------------------------------- zip (store) */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {                       // files: [[name, string]]
    const parts = [], central = []; let off = 0;
    const d = new Date(), dt = ((d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate()), tm = (d.getHours() << 11 | d.getMinutes() << 5 | (d.getSeconds() >> 1));
    for (const [name, text] of files) {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, tm, true); h.setUint16(12, dt, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, tm, true); c.setUint16(14, dt, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), nb);
      off += 30 + nb.length + data.length;
    }
    const cl = central.reduce((s, x) => s + x.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  async function unzip(buf) {                 // -> Map(name -> Uint8Array); stored or deflated entries
    const v = new DataView(buf), u8 = new Uint8Array(buf), out = new Map();
    let e = buf.byteLength - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a backup file (no zip directory).');
    let p = v.getUint32(e + 16, true); const n = v.getUint16(e + 10, true);
    for (let i = 0; i < n; i++) {
      const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), raw = u8.subarray(start, start + size);
      let data = raw;
      if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else if (method !== 0) throw new Error('Unsupported zip compression.');
      out.set(name, data);
      p += 46 + nl + xl + cl;
    }
    return out;
  }
  /* ---------------------------------------------------------------- xlsx */
  const x = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = i => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - 1 - r) / 26; } return s; };
  function sheetXml(rows, widths, { header = true } = {}) {
    const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = col(ci) + (ri + 1), st = header && ri === 0 ? ' s="1"' : '';
      return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = widths ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    const pane = header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
  }
  function xlsx(sheets) {                     // [{name, rows, widths, hidden, header}]
    const files = [];
    files.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>']);
    files.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
    files.push(['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
      + sheets.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>']);
    files.push(['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
    files.push(['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFB0291C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>']);
    sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths, { header: s.header !== false })]));
    return zip(files);
  }
  /* ---------------------------------------------------------------- read back */
  const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  const texts = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(m => unx(m[1] || ''));
  async function read(file) {
    const buf = await file.arrayBuffer(), head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (head[0] === 0x7B) return check(JSON.parse(new TextDecoder().decode(buf)));         // a plain .json backup
    if (!(head[0] === 0x50 && head[1] === 0x4B)) throw new Error('This is not an ALL-OUT backup file (.xlsx or .json).');
    const files = await unzip(buf), dec = b => new TextDecoder().decode(b);
    const wb = dec(files.get('xl/workbook.xml') || new Uint8Array());
    const sm = /<sheet\b[^>]*name="_backup"[^>]*>/.exec(wb); if (!sm) throw new Error('This workbook has no ALL-OUT backup data (the hidden _backup sheet is missing).');
    const rid = /r:id="([^"]+)"/.exec(sm[0])[1];
    const rels = dec(files.get('xl/_rels/workbook.xml.rels'));
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes(`Id="${rid}"`));
    let target = /Target="([^"]+)"/.exec(rel)[1]; target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const sheet = dec(files.get(target));
    const shared = files.has('xl/sharedStrings.xml') ? [...dec(files.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]).join('')) : [];
    const cells = [...sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].filter(m => /r="A\d+"/.test(m[1])).map(m => {
      const row = +/r="A(\d+)"/.exec(m[1])[1], inner = m[2] || '';
      const val = /t="s"/.test(m[1]) ? shared[+(/<v>(\d+)<\/v>/.exec(inner) || [0, -1])[1]] : texts(inner).join('');
      return [row, val || ''];
    }).sort((a, b) => a[0] - b[0]);
    return check(JSON.parse(cells.map(c => c[1]).join('')));
  }
  function check(d) {
    if (!d || d.format !== 'allout-backup' || !Array.isArray(d.matches)) throw new Error('This file is not an ALL-OUT backup.');
    return d;
  }
  /* ---------------------------------------------------------------- the workbook */
  const manila = iso => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const stamp = d => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d), g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}-${g('hour')}${g('minute')}`; };
  const STATUS = { scheduled: 'Not started', live: 'Live', final: 'Final' };
  /* Team corrections as {id, name, players} relative to the published roster (kept on t._name0 / t._roster0). */
  function teamEdits(A) {
    return A.TEAMS.filter(t => t._roster0 && (t.name !== t._name0 || t.roster.some((p, i) => p.name !== t._roster0[i].name || !!p.captain !== !!t._roster0[i].captain)))
      .map(t => ({ id: t.id, name: t.name !== t._name0 ? t.name : null, players: t.roster.map(p => ({ name: p.name, captain: !!p.captain })) }));
  }
  function data(A, snaps, meta) {
    const clean = s => { const o = {}; for (const k of Object.keys(s)) if (!k.startsWith('_') && k !== 'public') o[k] = s[k]; return o; };
    return { format: 'allout-backup', v: 1, exportedAt: new Date().toISOString(), by: meta.by || '', source: meta.source || 'live',
             matches: [...snaps.values()].filter(s => s && s.id).map(clean).sort((a, b) => a.id < b.id ? -1 : 1), teams: teamEdits(A),
             // offline file: the live backup it started from, so the upload can tell what changed offline and what changed live
             ...(meta.checkin ? { checkin: meta.checkin } : {}),
             ...(meta.base ? { base: { exportedAt: meta.base.exportedAt, by: meta.base.by || '', matches: meta.base.matches || [] } } : {}) };
  }
  function build(A, snaps, meta = {}) {
    const d = data(A, snaps, meta), name = id => (id && A.TEAM.get(id)?.name) || '';
    const stage = m => m.stage === 'pool' ? `Bracket ${m.bracket} · Round ${m.round}` : m.stage === 'semi' ? `Semifinal ${m.code === 'SF1' ? 1 : 2}` : m.stage === 'gold' ? 'Gold match' : 'Bronze match';
    const order = [...A.MATCHES].sort((a, b) => a.time.localeCompare(b.time) || a.court - b.court);
    const sides = m => { const s = snaps.get(m.id); return s && s.home && s.away && s.status !== 'scheduled' ? [s.home, s.away] : A.participants(m); };
    const n = { final: 0, live: 0, scheduled: 0 };
    const matches = [['Time', 'Court', 'Division', 'Stage', 'Match', 'Home team', 'Away team', 'Status', 'Games (H–A)', 'WD', 'MD', 'XD1', 'XD2', 'Dreambreaker', 'Winner', 'Note', 'Match ID']];
    const games = [['Match ID', 'Division', 'Time', 'Court', 'Game', 'Type', 'Home team', 'Away team', 'Home pts', 'Away pts', 'State', 'Outcome']];
    const lineups = [['Match ID', 'Division', 'Time', 'Side', 'Team', 'Mixed 1', 'Mixed 2', 'Dreambreaker order']];
    for (const m of order) {
      const s = snaps.get(m.id), r = A.result(m), [h, a] = sides(m), st = s && s.status ? s.status : 'scheduled';
      n[st] = (n[st] || 0) + 1;
      const g = k => { const x = (s && s.games || []).find(y => y.n === k); return x ? `${x.h}–${x.a}${x.state === 'live' ? ' (live)' : ''}${x.outcome && x.outcome !== 'played' ? ' (forfeit)' : ''}` : ''; };
      const court = (s && s.court) || m.court;
      matches.push([A.TIMES ? m.time : m.time, court, A.DIVISIONS[m.div].label, stage(m), m.code, name(h) || (m.stage === 'pool' ? '' : A.placeholder(m, 0)), name(a) || (m.stage === 'pool' ? '' : A.placeholder(m, 1)),
        STATUS[st] || st, st === 'scheduled' ? '' : `${r.hw}–${r.aw}`, g(1), g(2), g(3), g(4), g(5), r.winner ? name(r.winner === 'H' ? h : a) : '', s && s.note ? s.note : '', m.id]);
      for (const x of (s && s.games) || []) games.push([m.id, A.DIVISIONS[m.div].label, m.time, court, x.n, (A.GAME_TYPES[x.n - 1] || {}).name || 'Game ' + x.n, name(h), name(a), x.h, x.a, x.state, x.outcome || 'played']);
      const lu = s && s.lineup;
      if (lu) for (const side of ['H', 'A']) {
        const L = lu[side] || {}, D = (lu.db && lu.db[side]) || {};
        if (!(L.xd1 || L.xd2 || D.order)) continue;
        lineups.push([m.id, A.DIVISIONS[m.div].label, m.time, side === 'H' ? 'Home' : 'Away', name(L.team || D.team), (L.xd1 || []).join(' & '), (L.xd2 || []).join(' & '), (D.order || []).join(' → ')]);
      }
    }
    const standings = [['Division', 'Bracket', 'Rank', 'Team', 'Won', 'Lost', 'Games won', 'Games lost', 'Dreambreakers', 'Point diff', 'Status']];
    const Q = { Q: 'Qualified', WC: 'Wildcard', OUT: 'Out', TIE: 'Special tiebreak needed' };
    for (const div of A.DIV_ORDER) {
      const q = A.qualification(div);
      for (const t of q.tables) for (const e of t.ranked) { const r = e.row; standings.push([A.DIVISIONS[div].label, t.bracket, e.rank ?? '', name(r.id), r.W, r.L, r.GW, r.GL, r.D, r.PD, Q[q.status[r.id]] || '']); }
      const pl = A.placements(div);
      if (pl.some(Boolean)) pl.forEach((id, i) => id && standings.push([A.DIVISIONS[div].label, 'Final placings', i + 1, name(id), '', '', '', '', '', '', ['Champion', 'Runner-up', 'Third', 'Fourth'][i]]));
    }
    const rosters = [['Division', 'Bracket', 'Team ID', 'Team', 'Player 1', 'Player 2', 'Player 3', 'Player 4', 'Captain', 'Corrected in Match Control']];
    for (const t of A.TEAMS) {
      const cap = t.roster.find(p => p.captain);
      const corrected = t._roster0 && (t.name !== t._name0 || t.roster.some((p, i) => p.name !== t._roster0[i].name));
      rosters.push([A.DIVISIONS[t.div].label, t.bracket, t.id, t.name, ...t.roster.map(p => `${p.name} (${p.g === 'F' ? 'W' : 'M'})`), cap ? cap.name : '', corrected ? 'Yes' : '']);
    }
    const manilaT = iso => iso ? new Date(iso).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }) : '';
    const checkin = [['Division', 'Team', 'Player', 'W/M', 'Shirt size', 'Checked in', 'By', 'Shirt given', 'Team ID']];
    for (const t of d.checkin || []) { const tm = A.TEAM.get(t.team); for (const p of t.players) checkin.push([tm ? A.DIVISIONS[tm.div].label : '', t.name, p.name, p.g === 'F' ? 'W' : 'M', p.size || '', manilaT(p.arrivedAt), p.arrivedBy || '', manilaT(p.shirtAt), t.team]); }
    const summary = [
      ['ALL-OUT Pickleball League · Match Control backup', ''],
      ['Saved', manila(d.exportedAt) + ' (Manila time)'],
      ['Saved by', d.by || ''],
      ['Source', d.source === 'offline' ? 'Offline Match Control (not yet on the live site)' : 'Live Match Control'],
      ['Matches final', n.final], ['Matches live', n.live], ['Matches not started', n.scheduled],
      ['Teams corrected', d.teams.length],
      ...(d.checkin ? [['Players checked in', d.checkin.reduce((x, t) => x + t.players.filter(p => p.arrivedAt).length, 0) + ' of ' + d.checkin.length * 4]] : []),
      ['', ''],
      ['Sheets', 'Matches, Games, Lineups, Standings, Rosters' + (d.checkin ? ', Check-in' : '')],
      ['Confidential', 'Lineups (mixed pairs, Dreambreaker orders) are for Match Control only. Do not post or forward this file.'],
      ['Offline use', 'Open ALL-OUT-Match-Control-offline.html and load this file to keep scoring without internet.'],
      ['Do not edit', 'Edits made in Excel are not read back. Keep scores in Match Control (live or offline).'],
    ];
    const json = JSON.stringify(d), chunks = [];
    for (let i = 0; i < json.length; i += 30000) chunks.push([json.slice(i, i + 30000)]);
    const blob = xlsx([
      { name: 'Summary', rows: summary, widths: [24, 90], header: false },
      { name: 'Matches', rows: matches, widths: [7, 6, 10, 22, 8, 26, 26, 12, 11, 12, 12, 12, 12, 13, 26, 30, 13] },
      { name: 'Games', rows: games, widths: [13, 10, 7, 6, 6, 18, 26, 26, 9, 9, 8, 13] },
      { name: 'Lineups', rows: lineups, widths: [13, 10, 7, 7, 26, 36, 36, 60] },
      { name: 'Standings', rows: standings, widths: [10, 14, 6, 28, 7, 7, 11, 11, 13, 10, 22] },
      { name: 'Rosters', rows: rosters, widths: [10, 8, 9, 28, 28, 28, 28, 28, 24, 12] },
      ...(d.checkin ? [{ name: 'Check-in', rows: checkin, widths: [10, 26, 28, 6, 10, 11, 22, 11, 9] }] : []),
      { name: '_backup', rows: chunks, widths: [20], hidden: true, header: false },
    ]);
    return { blob, filename: `ALL-OUT-backup-${stamp(new Date())}${d.source === 'offline' ? '-offline' : ''}.xlsx`, data: d };
  }
  function download({ blob, filename }) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  /* ---------------------------------------------------------------- automatic backup into a folder (Chrome / Edge on a laptop)
     The person picks a folder once. After every change the workbook is written to "<latest>" a few seconds later
     (the browser writes a temporary file and swaps it in, so the file is never half-written), and a time-stamped
     copy is kept every 15 minutes. The folder is remembered in this browser; after a reload the browser wants one
     click before it lets the page write again ("paused"). */
  function autoSaver({ key, latest, prefix = 'ALL-OUT-autobackup-', getBackup, fingerprint, onChange, everyMin = 15, delay = 3000 }) {
    const supported = typeof window.showDirectoryPicker === 'function' && window.isSecureContext !== false && !!window.indexedDB;
    const st = { supported, state: supported ? 'off' : 'unsupported', folder: '', latest, savedAt: 0, copyAt: 0, copyName: '', error: '', saves: 0, dirty: false };
    let dir = null, timer = null, busy = false, again = false, lastFp, retryT = null;
    const emit = () => { try { if (onChange) onChange({ ...st }); } catch { /* the page's own problem */ } };
    const db = (mode, fn) => new Promise((res, rej) => {
      const o = indexedDB.open('allout-autobackup', 1);
      o.onupgradeneeded = () => o.result.createObjectStore('folders');
      o.onerror = () => rej(o.error);
      o.onsuccess = () => { const d = o.result, tx = d.transaction('folders', mode), r = fn(tx.objectStore('folders')); tx.oncomplete = () => { d.close(); res(r && r.result); }; tx.onerror = () => { d.close(); rej(tx.error); }; };
    });
    async function allowed(askNow) {
      const o = { mode: 'readwrite' };
      if (!dir.queryPermission || (await dir.queryPermission(o)) === 'granted') return true;
      return askNow && dir.requestPermission ? (await dir.requestPermission(o)) === 'granted' : false;
    }
    async function restore() {
      if (!supported) { emit(); return st; }
      try { dir = (await db('readonly', s => s.get(key))) || null; } catch { dir = null; }
      if (dir) { st.folder = dir.name; st.state = (await allowed(false).catch(() => false)) ? 'on' : 'paused'; st.dirty = true; }
      emit();
      if (st.state === 'on') touch();
      return st;
    }
    async function enable() {                       // from a click: opens the folder picker
      if (!supported) return false;
      let d;
      try { d = await window.showDirectoryPicker({ id: 'allout-backup', mode: 'readwrite', startIn: 'documents' }); }
      catch (e) { if (e && e.name === 'AbortError') return false; throw e; }
      dir = d;
      if (!(await allowed(true).catch(() => false))) { st.state = 'paused'; st.folder = dir.name; emit(); return false; }
      try { await db('readwrite', s => s.put(dir, key)); } catch { /* still works until the page is closed */ }
      Object.assign(st, { folder: dir.name, state: 'on', error: '', copyAt: 0, copyName: '' }); lastFp = undefined;
      emit();
      return saveNow();
    }
    async function resume() {                       // from a click: the browser asks "Allow editing?"
      if (!dir) return enable();
      if (!(await allowed(true).catch(() => false))) { st.state = 'paused'; emit(); return false; }
      st.state = 'on'; st.error = ''; lastFp = undefined; emit();
      return saveNow();
    }
    async function disable() {
      clearTimeout(timer); clearTimeout(retryT); timer = null; dir = null;
      Object.assign(st, { state: supported ? 'off' : 'unsupported', folder: '', error: '', dirty: false });
      try { await db('readwrite', s => s.delete(key)); } catch { /* nothing kept */ }
      emit();
    }
    function touch() {                              // call after anything changed; cheap when nothing did
      if (!dir) return;
      let fp; try { fp = fingerprint ? fingerprint() : Math.random(); } catch { fp = Math.random(); }
      if (fp === lastFp && st.state === 'on') return;
      if (st.state === 'paused') { if (!st.dirty) { st.dirty = true; emit(); } return; }
      st.dirty = true;
      if (!timer) timer = setTimeout(saveNow, delay);  // at most one write per few seconds while changes keep coming
    }
    async function put(name, blob) {
      const fh = await dir.getFileHandle(name, { create: true }), w = await fh.createWritable();
      try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch { /* already closed */ } throw e; }
    }
    async function saveNow() {
      clearTimeout(timer); timer = null; clearTimeout(retryT); retryT = null;
      if (!dir || st.state === 'paused') return false;
      if (busy) { again = true; return false; }
      busy = true;
      let ok = false;
      try {
        let fp; try { fp = fingerprint ? fingerprint() : undefined; } catch { fp = undefined; }
        const r = getBackup();
        if (!r) return false;                       // nothing loaded yet: never overwrite a good file with an empty one
        await put(latest, r.blob);
        const now = Date.now();
        st.savedAt = now; st.saves++; st.state = 'on'; st.error = ''; st.dirty = false; lastFp = fp;
        if (!st.copyAt || now - st.copyAt >= everyMin * 60000) {
          const name = r.filename.replace(/^ALL-OUT-backup-/, prefix);
          await put(name, r.blob); st.copyAt = now; st.copyName = name;
        }
        ok = true;
      } catch (e) {
        const n = e && e.name;
        if (n === 'NotAllowedError' || n === 'SecurityError') { st.state = 'paused'; st.error = 'The browser needs your OK to keep saving into the folder.'; }
        else {
          st.state = 'error';
          st.error = n === 'NotFoundError' ? 'The backup folder was moved or deleted. Choose a folder again.'
            : n === 'NoModificationAllowedError' || n === 'InvalidStateError' || /lock|in use|being used/i.test((e && e.message) || '') ? `Could not write ${latest}. If it is open in Excel, close it.`
            : n === 'QuotaExceededError' ? 'The disk is full.'
            : 'Could not save: ' + ((e && e.message) || e);
          if (n !== 'NotFoundError') retryT = setTimeout(saveNow, 30000);
        }
      } finally {
        busy = false; emit();
        if (again) { again = false; touch(); }
      }
      return ok;
    }
    return { restore, enable, resume, disable, touch, saveNow, status: () => ({ ...st }) };
  }

  /* The top-bar button and its menu (same in the live and the offline Match Control). */
  function autoButton(btn, saver, { toast = () => {}, what = 'this laptop' } = {}) {
    const t = d => new Date(d).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
    const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function paint(st) {
      btn.classList.remove('ab-on', 'ab-warn', 'ab-bad');
      if (st.state === 'unsupported') { btn.textContent = 'Auto-backup'; btn.title = 'Automatic backup needs Chrome or Edge on a laptop. Use Download backup instead.'; return; }
      if (st.state === 'off') { btn.textContent = 'Auto-backup: off'; btn.title = 'Save a backup into a folder on this laptop after every change'; return; }
      if (st.state === 'paused') { btn.classList.add('ab-warn'); btn.textContent = 'Auto-backup paused · tap'; btn.title = 'The browser needs one tap before it saves into ' + st.folder + ' again'; return; }
      if (st.state === 'error') { btn.classList.add('ab-bad'); btn.textContent = 'Auto-backup failed'; btn.title = st.error; return; }
      btn.classList.add('ab-on');
      btn.textContent = st.savedAt ? `Auto-saved ${t(st.savedAt)}` : 'Auto-backup on';
      btn.title = `Saving into the folder “${st.folder}” after every change`;
    }
    let dlg = null;
    function menu() {
      const st = saver.status();
      if (!dlg) {
        dlg = document.createElement('dialog'); dlg.className = 'ask-dlg ab-dlg'; document.body.appendChild(dlg);
        dlg.addEventListener('click', async ev => {
          const b = ev.target.closest('[data-ab]'); if (!b) return;
          const a = b.dataset.ab; dlg.close();
          if (a === 'now') toast((await saver.saveNow()) ? 'Backup saved into the folder.' : (saver.status().error || 'Nothing to save yet.'), saver.status().error ? 'error' : '');
          if (a === 'folder') await go(() => saver.enable());
          if (a === 'off') { await saver.disable(); toast('Auto-backup is off. Files already saved stay in the folder.'); }
        });
      }
      dlg.innerHTML = `<div class="ask"><h3>Auto-backup ${st.state === 'error' ? 'has a problem' : 'is on'}</h3>
        <p class="muted">Folder <b>${e(st.folder)}</b> on ${e(what)}. After every change it saves <b>${e(st.latest)}</b> there (always the newest), and keeps a time-stamped copy every 15 minutes.</p>
        ${st.error ? `<p class="form-error">${e(st.error)}</p>` : ''}
        <p class="muted">${st.savedAt ? `Last saved ${new Date(st.savedAt).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila' })} · ${st.saves} save${st.saves === 1 ? '' : 's'} since this page opened` : 'Not saved yet on this page.'}${st.copyName ? `<br>Last copy: ${e(st.copyName)}` : ''}</p>
        <p class="muted">If the live site fails: open the offline Match Control file and load <b>${e(st.latest)}</b> from this folder.</p>
        <div class="ask-actions"><button type="button" class="btn ghost" data-ab="off">Turn off</button><button type="button" class="btn ghost" data-ab="folder">Choose another folder</button><button type="button" class="btn" data-ab="close">Close</button><button type="button" class="btn primary" data-ab="now">Save now</button></div></div>`;
      dlg.showModal();
    }
    async function go(fn) {
      try {
        const ok = await fn();
        const st = saver.status();
        if (ok) toast(`Auto-backup on. Saved ${st.latest} into “${st.folder}”.`);
        else if (st.state === 'paused') toast('Auto-backup is paused until you allow it.', 'error');
        else if (st.error) toast(st.error, 'error');
      } catch (err) { toast('Auto-backup could not start: ' + ((err && err.message) || err), 'error'); }
    }
    btn.addEventListener('click', () => {
      const st = saver.status();
      if (st.state === 'unsupported') return toast('Automatic backup needs Chrome or Edge on a laptop. Use Download backup instead.', 'error');
      if (st.state === 'off') return go(() => saver.enable());
      if (st.state === 'paused') return go(() => saver.resume());
      menu();
    });
    return paint;
  }
  return { build, download, read, teamEdits, autoSaver, autoButton };
})();
