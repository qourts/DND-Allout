/* ALL-OUT Match Control (qourtsadmin). Signs in with Supabase and records match scores through
   admin-only database functions. The browser only ever holds the public (publishable) key; every
   write is checked in the database against the signed-in admin's role. */
(() => {
'use strict';

const A = window.ALLOUT;
const C = window.AOPL_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const client = window.supabase.createClient(C.supabaseUrl, C.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'qourtsadmin.auth.v1' }
});

/* ------------------------------------------------------------------ state */
const S = {
  session: null, access: null,
  snaps: new Map(),            // match id -> latest snapshot from the database
  loadedAt: 0, loadError: null, loading: false,
  view: 'courts', slot: null, slotPinned: false,
  stDiv: A.DIV_ORDER.includes('D14') ? 'D14' : A.DIV_ORDER[0],
  open: null,                  // id of the match in the scoring sheet
  ed: null,                    // editor state for the open match
  activity: null, activityAt: 0,
};
const can = p => !!(S.access && Array.isArray(S.access.permissions) && S.access.permissions.includes(p));
const canRecord = () => can('scores_record');
const canCorrect = () => can('scores_correct');

/* ------------------------------------------------------------------ format helpers */
const TZ = 'Asia/Manila';
function manilaNow() {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}
function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(d);
}
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
const teamName = id => (id && A.TEAM.get(id)?.name) || '';
const mono = id => { const n = teamName(id); return A.TEAM_MONO[n] || n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); };
function stageLabel(m) {
  if (m.stage === 'pool') return `Bracket ${m.bracket} · Round ${m.round}`;
  if (m.stage === 'semi') return `Semifinal ${m.code === 'SF1' ? 1 : 2}`;
  return m.stage === 'gold' ? 'Gold match' : 'Bronze match';
}
const gameType = n => A.GAME_TYPES[n - 1] || { short: 'G' + n, name: 'Game ' + n };

/* ------------------------------------------------------------------ scoring rules (mirror of the database) */
function finalOk(h, a, outcome = 'played') {
  if (outcome === 'forfeit_home') return a > h;
  if (outcome === 'forfeit_away') return h > a;
  const w = Math.max(h, a), l = Math.min(h, a);
  return w >= 21 && w - l >= 2 && (w === 21 || w - l === 2);
}
const gameWinner = g => (g.h > g.a ? 'H' : 'A');
/* What happens next in a match: {live: game|null, next: n|null, decided: 'H'|'A'|null, hw, aw} */
function progress(m, snap) {
  const games = (snap && snap.games) || [];
  const live = games.find(g => g.state === 'live') || null;
  let hw = 0, aw = 0;
  const regular = games.filter(g => g.n <= 4);
  regular.filter(g => g.state === 'final').forEach(g => { gameWinner(g) === 'H' ? hw++ : aw++; });
  const db = games.find(g => g.n === 5);
  let decided = null, next = null;
  if (!live) {
    if (m.stage !== 'pool' && (hw === 3 || aw === 3)) decided = hw === 3 ? 'H' : 'A';
    else if (regular.length < 4) next = regular.length + 1;
    else if (hw === 2 && aw === 2) { if (!db) next = 5; else if (db.state === 'final') decided = gameWinner(db); }
    else decided = hw > aw ? 'H' : 'A';
  }
  return { games, live, next, decided, hw, aw };
}
/* Admin status of a match: scheduled | live | decided | final */
function statusOf(m) {
  const s = S.snaps.get(m.id);
  if (!s || s.status === 'scheduled') return 'scheduled';
  if (s.status === 'final') return 'final';
  return progress(m, s).decided ? 'decided' : 'live';
}
const STATUS_TEXT = { scheduled: 'Not started', live: 'Live', decided: 'Ready to confirm', final: 'Final' };
function teamsOf(m) {
  const s = S.snaps.get(m.id);
  if (s && s.home && s.away && s.status !== 'scheduled') return [s.home, s.away];
  return A.participants(m);
}
function sideLabel(m, side) {
  const id = teamsOf(m)[side];
  return id ? teamName(id) : (m.stage === 'pool' ? '' : A.placeholder(m, side));
}

/* ------------------------------------------------------------------ data */
let pollTimer = null;
async function loadScores({ quiet = false } = {}) {
  if (S.loading) return;
  S.loading = true;
  const since = Date.now();
  try {
    const { data, error } = await client.rpc('get_allout_public_scores_v1');
    if (error) throw error;
    const list = (data && data.matches) || [];
    // keep anything pushed in real time that is newer than this feed (a push can overtake the request)
    const next = new Map(list.map(s => [s.id, s]));
    for (const [id, old] of S.snaps) {
      const fresh = next.get(id);
      if (fresh ? old.version > fresh.version : (old._at || 0) > since) next.set(id, old);
    }
    S.snaps = next;
    A.setLive([...next.values()]);
    S.loadedAt = Date.now(); S.loadError = null;
  } catch (e) {
    S.loadError = friendly(e);
    if (!quiet) toast(S.loadError, 'error');
  } finally {
    S.loading = false;
    renderSync();
    renderView();
    if (S.open) renderSheet();
  }
}
function applySnapshot(snap) {
  if (!snap || !snap.id || !A.MATCH.has(snap.id)) return false;
  const cur = S.snaps.get(snap.id);
  if (cur && cur.version >= snap.version) return false;
  S.snaps.set(snap.id, { ...snap, _at: Date.now() });
  A.setLive([...S.snaps.values()]);
  S.activity = null;
  return true;
}

/* ------------------------------------------------------------------ real-time push
   Every saved score is pushed by the database on the private "allout-scores" channel, so every
   admin screen (and the player portal) updates the moment anyone saves. Polling stays as a safety net. */
let channel = null, rtUp = false;
async function startRealtime() {
  if (channel) return;
  try { await client.realtime.setAuth(); } catch { /* the session token is used anyway */ }
  channel = client.channel('allout-scores', { config: { private: true } })
    .on('broadcast', { event: 'match' }, msg => {
      if (!applySnapshot(msg && msg.payload)) return;
      if (S.view !== 'activity') renderView();
      if (S.open === (msg.payload && msg.payload.id) && !(S.ed && (S.ed.saving || S.ed.local))) renderSheet();
    })
    .subscribe(status => {
      const was = rtUp;
      rtUp = status === 'SUBSCRIBED';
      if (rtUp && !was) loadScores({ quiet: true });   // catch up on anything missed while disconnected
      renderSync();
    });
}
async function stopRealtime() {
  rtUp = false;
  if (channel) { const c = channel; channel = null; try { await client.removeChannel(c); } catch { /* already gone */ } }
}
function startPolling() {
  stopPolling();
  const every = Math.max(5, Number(C.refreshSeconds) || 10) * 1000;
  let last = 0;
  pollTimer = setInterval(() => {
    const wait = rtUp ? Math.max(every, 30000) : every;   // the push channel makes frequent polling unnecessary
    if (Date.now() - last < wait - 500 || document.hidden || (S.ed && (S.ed.saving || S.ed.local))) return;
    last = Date.now();
    loadScores({ quiet: true });
  }, every);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
setInterval(renderSync, 5000);

function friendly(e) {
  const msg = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'No connection to the score server. Check the venue Wi-Fi or mobile data; nothing was saved.';
  if (/JWT expired|invalid JWT|not authenticated/i.test(msg)) return 'Your sign-in expired. Sign in again.';
  if (/permission denied/i.test(msg)) return 'This account is not allowed to do that.';
  if ((e && e.code === 'PGRST202') || /Could not find the function|function [a-z0-9_.]+\(.*\) does not exist/i.test(msg)) {
    if (/db_order/i.test(msg)) return 'The Dreambreaker order is not switched on yet: run 0007_dreambreaker_order.sql in Supabase first. Scores still save normally.';
    return /lineup/i.test(msg) ? 'Mixed pairs are not switched on yet: run 0006_match_lineups.sql in Supabase first. Scores still save normally.'
      : 'The score server is missing a database update. Ask the event owner to run the latest SQL file.';
  }
  return msg;
}

/* ------------------------------------------------------------------ sign in / access */
function show(id) { ['signin', 'noaccess', 'app'].forEach(x => { $('#' + x).hidden = x !== id; }); }
async function checkAccess(session) {
  S.session = session;
  if (!session) { S.access = null; stopPolling(); closeSheet(); show('signin'); setTimeout(() => $('#siEmail').focus(), 0); return; }
  const { data, error } = await client.rpc('get_allout_my_admin_access_v1');
  if (error) {
    show('noaccess');
    $('#naText').textContent = friendly(error);
    return;
  }
  if (!data || data.active === false) { S.access = null; show('noaccess'); return; }
  S.access = data;
  $('#whoName').textContent = data.displayName || data.email || 'Admin';
  $('#whoRole').textContent = (data.role && data.role.name) || '';
  const banner = $('#banner');
  if (!canRecord()) {
    banner.hidden = false;
    banner.textContent = 'View only: your admin role does not include “Record match scores”. Ask the event owner to add it in the registration admin under Users & Roles.';
  } else banner.hidden = true;
  show('app');
  await loadScores();
  startPolling();
  startRealtime();
}
$('#signinForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const email = $('#siEmail').value.trim(), password = $('#siPassword').value;
  const err = $('#siError');
  err.hidden = true;
  if (!email || !password) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
  const btn = $('#siSubmit'); btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    $('#siPassword').value = '';
    await checkAccess(data.session);
  } catch (e) {
    err.textContent = /invalid login credentials/i.test(e.message || '') ? 'Wrong email or password.' : friendly(e);
    err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
});
async function signOut() {
  stopPolling();
  await stopRealtime();
  try { await client.auth.signOut(); } catch { /* the local session is cleared either way */ }
  S.access = null; S.session = null; S.snaps = new Map(); A.setLive([]);
  closeSheet();
  show('signin');
}
$('#signOut').addEventListener('click', signOut);
$('#naSignOut').addEventListener('click', signOut);
client.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' && S.access) { S.access = null; stopPolling(); stopRealtime(); closeSheet(); show('signin'); }
  if (event === 'TOKEN_REFRESHED') S.session = session;
});

/* ------------------------------------------------------------------ chrome */
const regUrl = C.registrationsAdminUrl || '#';
$('#regLink').href = regUrl; $('#siRegLink').href = regUrl;
$('#eventLine').textContent = `${A.EVENT.dateShort} · ${A.EVENT.venue}`;
$('#tabs').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});
function setView(v) {
  S.view = v;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'v-' + v));
  renderView();
}
function renderSync() {
  const el = $('#sync'); if (!el) return;
  const stale = S.loadedAt && Date.now() - S.loadedAt > 60000;
  el.className = 'sync ' + (S.loadError ? 'bad' : stale ? 'warn' : S.loadedAt ? 'ok' : '');
  el.querySelector('span').textContent = S.loadError ? 'Offline · retrying' : rtUp ? 'Live' : S.loadedAt ? `Updated ${ago(S.loadedAt)}` : 'Connecting…';
  el.title = rtUp ? 'Connected: score changes appear instantly.' : 'Score changes appear on the next refresh.';
}
let toastTimer = null;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 2600);
}
function renderView() {
  if ($('#app').hidden) return;
  if (S.view === 'courts') renderCourts();
  else if (S.view === 'scores') renderScores();
  else if (S.view === 'standings') renderStandings();
  else if (S.view === 'activity') renderActivity();
  else if (S.view === 'teams') renderTeams();
}

/* ------------------------------------------------------------------ courts board */
function currentSlot() {
  const { date, time } = manilaNow();
  if (date < A.EVENT.dateISO) return A.TIMES[0];
  if (date > A.EVENT.dateISO) return A.TIMES[A.TIMES.length - 1];
  let slot = A.TIMES[0];
  for (const t of A.TIMES) if (t <= time) slot = t;
  // stay on a slot while any of its matches is still being played
  const unfinished = A.TIMES.find(t => t < slot && A.MATCHES.some(m => m.time === t && ['live', 'decided'].includes(statusOf(m))));
  return unfinished || slot;
}
const slotSel = $('#slotPick');
slotSel.innerHTML = A.TIMES.map(t => `<option value="${t}">${fmtTime(t)}</option>`).join('');
slotSel.addEventListener('change', () => { S.slot = slotSel.value; S.slotPinned = true; renderCourts(); });
$('#slotPrev').addEventListener('click', () => stepSlot(-1));
$('#slotNext').addEventListener('click', () => stepSlot(1));
$('#slotNow').addEventListener('click', () => { S.slotPinned = false; renderCourts(); });
function stepSlot(d) {
  const i = A.TIMES.indexOf(S.slot || currentSlot());
  S.slot = A.TIMES[Math.min(A.TIMES.length - 1, Math.max(0, i + d))]; S.slotPinned = true; renderCourts();
}
function scoreLine(m) {
  const s = S.snaps.get(m.id);
  if (!s || s.status === 'scheduled') return '';
  const p = progress(m, s);
  return `${p.hw}–${p.aw}`;
}
function matchCard(m, opts = {}) {
  const st = statusOf(m);
  const s = S.snaps.get(m.id);
  const p = progress(m, s);
  const cur = p.live ? `<span class="cur">G${p.live.n} ${esc(gameType(p.live.n).short)} · <b>${p.live.h}–${p.live.a}</b></span>` : '';
  const win = s && s.status === 'final' ? s.winner : p.decided;
  const side = i => {
    const id = teamsOf(m)[i];
    const label = sideLabel(m, i);
    const won = st !== 'scheduled' && win === (i === 0 ? 'H' : 'A');
    return `<div class="side${won ? ' won' : ''}${id ? '' : ' tbd'}"><span class="mono">${esc(id ? mono(id) : '?')}</span><span class="nm">${esc(label || 'To be decided')}</span><b class="gw">${st === 'scheduled' ? '' : (i === 0 ? p.hw : p.aw)}</b></div>`;
  };
  return `<button type="button" class="mcard st-${st}" data-match="${esc(m.id)}">
    <div class="mc-top">${opts.court ? `<span class="court">Court ${m.court}</span>` : `<span class="court">${fmtTime(m.time)} · Court ${m.court}</span>`}
      <span class="chip st-${st}">${STATUS_TEXT[st]}</span></div>
    <div class="mc-meta"><b>${esc(A.DIVISIONS[m.div].label)}</b> · ${esc(stageLabel(m))}</div>
    ${side(0)}${side(1)}
    <div class="mc-foot">${cur}</div>
  </button>`;
}
function renderCourts() {
  if (!S.slotPinned) S.slot = currentSlot();
  slotSel.value = S.slot;
  const list = A.MATCHES.filter(m => m.time === S.slot).sort((a, b) => a.court - b.court);
  const byCourt = new Map(list.map(m => [m.court, m]));
  const idx = A.TIMES.indexOf(S.slot);
  const nextSlot = A.TIMES[idx + 1];
  $('#courtsTitle').textContent = `Courts at ${fmtTime(S.slot)}`;
  let html = '';
  for (let c = 1; c <= A.EVENT.courts; c++) {
    const m = byCourt.get(c);
    const nx = nextSlot && A.MATCHES.find(x => x.time === nextSlot && x.court === c);
    html += `<div class="court-cell">${m ? matchCard(m, { court: true }) : `<div class="mcard empty"><div class="mc-top"><span class="court">Court ${c}</span></div><p class="muted">No match this slot</p></div>`}
      ${nx ? `<p class="up-next">Next ${fmtTime(nextSlot)}: ${esc(A.DIVISIONS[nx.div].label)} ${esc(nx.stage === 'pool' ? nx.code : stageLabel(nx))}</p>` : ''}</div>`;
  }
  $('#courts').innerHTML = html;
}

/* ------------------------------------------------------------------ scores list */
$('#fDiv').insertAdjacentHTML('beforeend', A.DIV_ORDER.map(d => `<option value="${d}">${esc(A.DIVISIONS[d].label)}</option>`).join(''));
['#fSearch', '#fDiv', '#fStatus'].forEach(s => $(s).addEventListener('input', () => renderScores()));
function renderScores() {
  const q = $('#fSearch').value.trim().toLowerCase(), dv = $('#fDiv').value, st = $('#fStatus').value;
  const rows = A.MATCHES.filter(m => {
    if (dv && m.div !== dv) return false;
    if (st && statusOf(m) !== st) return false;
    if (q) {
      const hay = [m.id, m.code, stageLabel(m), sideLabel(m, 0), sideLabel(m, 1), 'court ' + m.court].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (!rows.length) { $('#scoreList').innerHTML = '<p class="empty-note">No matches match these filters.</p>'; return; }
  let html = '', slot = null;
  for (const m of rows) {
    if (m.time !== slot) {
      if (slot !== null) html += '</div>';
      slot = m.time;
      html += `<h3 class="slot-h">${fmtTime(slot)}</h3><div class="mgrid">`;
    }
    html += matchCard(m);
  }
  $('#scoreList').innerHTML = html + '</div>';
}
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-match]');
  if (b && !b.closest('#scorer')) openSheet(b.dataset.match);
});

/* ------------------------------------------------------------------ scoring sheet */
const dlg = $('#scorer');
function openSheet(id) {
  const m = A.MATCH.get(id); if (!m) return;
  S.open = id;
  const [h, a] = teamsOf(m);
  S.ed = { id, local: null, saving: false, again: false, timer: null, editGame: null, pick: [h || '', a || ''], lu: [null, null], dbo: [null, null], history: null, historyOpen: false };
  renderSheet();
  if (!dlg.open) dlg.showModal();
}
function closeSheet() {
  if (S.ed && S.ed.timer) { clearTimeout(S.ed.timer); }
  if (S.ed && S.ed.local && !S.ed.saving) flush();
  S.open = null; S.ed = null;
  if (dlg.open) dlg.close();
}
dlg.addEventListener('cancel', ev => { ev.preventDefault(); closeSheet(); });
dlg.addEventListener('click', ev => { if (ev.target === dlg) closeSheet(); });

function renderSheet() {
  if (!S.open || !S.ed) return;
  const m = A.MATCH.get(S.open), ed = S.ed;
  // keep panels the scorer opened or closed (the toggle event can arrive after a quick redraw)
  const same = $('#scSheet').dataset.m === m.id;
  const dOld = same && $('#scSheet details.dborder'), lOld = same && $('#scSheet details.lineup:not(.dborder)');
  if (dOld) ed.dbOpen = dOld.open;
  if (lOld) ed.luOpen = lOld.open;
  const snap = S.snaps.get(m.id);
  const st = statusOf(m);
  const p = progress(m, snap);
  const started = snap && snap.status !== 'scheduled';
  const teams = started ? [snap.home, snap.away] : (m.stage === 'pool' ? [m.home, m.away] : ed.pick);
  const nm = i => teams[i] ? teamName(teams[i]) : A.placeholder(m, i);
  const roster = id => { const t = id && A.TEAM.get(id); return t ? t.roster.map(r => esc(r.name) + (r.captain ? ' <i>(C)</i>' : '')).join(' · ') : ''; };
  const editable = canRecord() && st !== 'final';
  const win = snap && snap.status === 'final' ? snap.winner : p.decided;

  let html = `<header class="sh-head">
      <div><p class="eyebrow">${esc(A.DIVISIONS[m.div].label)} · ${esc(stageLabel(m))}</p>
      <h2 id="scTitle">${fmtTime(m.time)} · Court ${m.court}</h2></div>
      <span class="chip st-${st}">${STATUS_TEXT[st]}</span>
      <button type="button" class="x" data-act="close" aria-label="Close">✕</button>
    </header>`;

  // ----- knockout team picker (before the first point)
  if (m.stage !== 'pool' && !started) {
    const divTeams = A.TEAMS.filter(t => t.div === m.div);
    const suggested = A.participants(m);
    const opt = sel => `<option value="">Choose…</option>` + divTeams.map(t => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    const note = suggested[0] && suggested[1]
      ? 'Suggested from the confirmed results. Change them only if the organizers say so.'
      : 'The standings do not decide these teams yet. Pick them as announced by the organizers.';
    html += `<section class="pick">
      <h3>Teams</h3><p class="muted">${note}</p>
      <div class="pick-row"><label class="field"><span>${esc(A.placeholder(m, 0))} (left)</span><select class="control" data-pick="0"${editable ? '' : ' disabled'}>${opt(ed.pick[0])}</select></label>
      <label class="field"><span>${esc(A.placeholder(m, 1))} (right)</span><select class="control" data-pick="1"${editable ? '' : ' disabled'}>${opt(ed.pick[1])}</select></label></div>
    </section>`;
  }

  // ----- match score header
  html += `<section class="board">
      <div class="team${win === 'H' ? ' won' : ''}"><span class="mono big">${esc(teams[0] ? mono(teams[0]) : '?')}</span><div><b>${esc(nm(0))}</b><small>${roster(teams[0])}</small></div><span class="gw">${p.hw}<small>games</small></span></div>
      <div class="team${win === 'A' ? ' won' : ''}"><span class="mono big">${esc(teams[1] ? mono(teams[1]) : '?')}</span><div><b>${esc(nm(1))}</b><small>${roster(teams[1])}</small></div><span class="gw">${p.aw}<small>games</small></span></div>
    </section>`;

  // ----- mixed pairs (can be changed until Mixed 1 starts). Shown above the pad when Mixed 1 is next,
  // otherwise below it so the scorer of games 1-2 does not have to scroll past it on a phone.
  const curN = p.live ? p.live.n : p.next;
  const luHtml = lineupHtml(m, teams, p, editable);
  const luFirst = curN === 3 && !p.games.some(g => g.n >= 3);
  if (luFirst) html += luHtml;
  // ----- Dreambreaker order: above the pad when the Dreambreaker is next, otherwise below
  const dbHtml = dbOrderHtml(m, teams, p, editable, curN);
  const dbFirst = curN === 5 && !p.games.some(g => g.n >= 5);
  if (dbFirst) html += dbHtml;

  // ----- current game editor
  if (editable && curN && !(m.stage !== 'pool' && !started && !(ed.pick[0] && ed.pick[1] && ed.pick[0] !== ed.pick[1]))) {
    const base = p.live || { n: curN, h: 0, a: 0 };
    const cur = ed.local && ed.local.n === curN ? ed.local : base;
    const ok = finalOk(cur.h, cur.a);
    const savedTxt = ed.saving ? 'Saving…' : ed.offline && ed.local ? 'No connection · retrying' : ed.local ? 'Not saved yet' : p.live ? 'Saved' : 'Not started';
    html += `<section class="cur-game">
      <div class="cg-head"><h3>Game ${curN} · ${esc(gameType(curN).name)}</h3><span class="save-state${ed.offline && ed.local ? ' bad' : ed.local ? ' dirty' : ''}">${savedTxt}</span></div>
      <div class="pad">
        ${[0, 1].map(i => `<div class="pad-side">
          <span class="pad-name">${esc(nm(i))}</span>
          <span class="pad-who">${curN === 5 ? dbNowHtml(A.dbOrder(m, teams)[i], cur.h + cur.a) : whoHtml(A.gamePlayers(m, curN, teams)[i], curN)}</span>
          <div class="pad-ctl">
            <button type="button" class="pm minus" data-act="pt" data-side="${i}" data-d="-1" aria-label="Minus one for ${esc(nm(i))}"${(i ? cur.a : cur.h) <= 0 ? ' disabled' : ''}>−</button>
            <input class="pts" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" data-pts="${i}" data-side="${i}" value="${i ? cur.a : cur.h}" aria-label="Points for ${esc(nm(i))} (tap to type)">
            <button type="button" class="pm plus" data-act="pt" data-side="${i}" data-d="1" aria-label="Plus one for ${esc(nm(i))}">+</button>
          </div></div>`).join('')}
      </div>
      <div class="cg-actions">
        <button type="button" class="btn primary" data-act="endgame"${ok ? '' : ' disabled'}>End game ${curN}</button>
        <button type="button" class="btn ghost" data-act="forfeit">Forfeit…</button>
      </div>
      <p class="hint">${ok ? `Ending makes it ${cur.h > cur.a ? esc(nm(0)) : esc(nm(1))}'s game.` : 'Games end at 21, win by 2 (exactly 2 once past 21).'}${curN === 5 ? ' Dreambreaker: switch ends at 11.' : ''}</p>
    </section>`;
  } else if (m.stage !== 'pool' && !started && editable) {
    html += `<p class="hint">Choose both teams to start scoring.</p>`;
  }

  if (!luFirst) html += luHtml;
  if (!dbFirst) html += dbHtml;

  // ----- games: the whole team match, game by game, with who plays each one
  const rows = [];
  for (let n = 1; n <= 5; n++) rows.push(gameRow(m, n, p, teams, curN, editable, st));
  html += `<section class="games"><h3>Team match · game by game</h3>${rows.join('')}</section>`;

  // ----- decided / final
  if (st === 'decided') {
    const w = p.decided === 'H' ? nm(0) : nm(1);
    html += `<section class="confirm"><p><b>${esc(w)}</b> wins ${Math.max(p.hw, p.aw)}–${Math.min(p.hw, p.aw)}${p.games.length === 5 ? ' on the Dreambreaker' : ''}. Check the games, then confirm.</p>
      ${canRecord() ? '<button type="button" class="btn primary big" data-act="finalize">Confirm result</button>' : ''}</section>`;
  }
  if (st === 'final') {
    html += `<section class="confirm final"><p>Final: <b>${esc(snap.winner === 'H' ? nm(0) : nm(1))}</b> won. Confirmed ${esc(fmtStamp(snap.updatedAt))}.</p></section>`;
  }

  // ----- secondary actions
  const acts = [];
  if (canRecord() && st !== 'final' && p.games.length) acts.push('<button type="button" class="btn small" data-act="removelast">Remove last game</button>');
  if (canCorrect() && st === 'final') acts.push('<button type="button" class="btn small" data-act="reopen">Reopen to correct</button>');
  if (canCorrect() && started) acts.push('<button type="button" class="btn small danger" data-act="reset">Reset match</button>');
  html += `<section class="more">${acts.join('')}
      <button type="button" class="btn small ghost" data-act="history">${ed.historyOpen ? 'Hide history' : 'Show history'}</button></section>`;
  if (ed.historyOpen) html += `<section class="history">${historyHtml(m, ed.history)}</section>`;
  if (!canRecord()) html += '<p class="hint">View only. Your role cannot record scores.</p>';

  // keep the cursor in a score box the scorer is typing in
  const f = document.activeElement;
  const keep = f && f.matches && f.matches('#scSheet [data-pts]') ? { side: f.dataset.pts, start: f.selectionStart, end: f.selectionEnd } : null;
  $('#scSheet').innerHTML = html;
  $('#scSheet').dataset.m = m.id;
  if (keep) {
    const box = $(`#scSheet [data-pts="${keep.side}"]`);
    // refocusing after a redraw must not select the digits already typed, or the next digit would replace them
    if (box) { S.refocusing = true; box.focus(); S.refocusing = false; try { box.setSelectionRange(keep.start, keep.end); } catch { /* not a text box */ } }
  }
}
function whoHtml(list, n) {
  if (n === 5) return 'All four players rotate';
  if (!list) return '<i>Mixed pair not set</i>';
  return list.map(esc).join(' &amp; ');
}
function gameRow(m, n, p, teams, curN, editable, st) {
  const ed = S.ed;
  const g = p.games.find(x => x.n === n);
  const gp = A.gamePlayers(m, n, teams);
  const label = `<span class="gt">G${n}</span><span class="gtn">${esc(gameType(n).name)}</span>`;
  const od = n === 5 ? A.dbOrder(m, teams) : null;
  const who = n === 5 ? (od[0] || od[1]
      ? [0, 1].map(i => `<span class="gw-who"><b>${esc(teams[i] ? mono(teams[i]) : '?')}</b>${od[i] ? od[i].map((x, j) => `${j + 1}. ${esc(x)}`).join(' · ') : '<i>Order not set</i>'}</span>`).join('')
      : `<span class="gw-who">All four players rotate, 4 rallies each</span>`)
    : [0, 1].map(i => `<span class="gw-who"><b>${esc(teams[i] ? mono(teams[i]) : '?')}</b>${whoHtml(gp[i], n)}</span>`).join('');
  if (g && ed.editGame === n) {
    return `<div class="grow editing" data-n="${n}"><div class="g-main">${label}${who}</div>
      <div class="g-edit"><input class="control num" type="number" inputmode="numeric" min="0" max="99" value="${g.h}" data-edit="h" aria-label="Left team points">
      <span>–</span>
      <input class="control num" type="number" inputmode="numeric" min="0" max="99" value="${g.a}" data-edit="a" aria-label="Right team points">
      <button type="button" class="btn small primary" data-act="saveedit" data-n="${n}">Save</button>
      <button type="button" class="btn small ghost" data-act="canceledit">Cancel</button></div></div>`;
  }
  let right;
  if (g) {
    const ff = g.outcome === 'forfeit_home' ? 'Forfeit by left team' : g.outcome === 'forfeit_away' ? 'Forfeit by right team' : '';
    right = `<span class="gs"><b class="${g.h > g.a ? 'w' : ''}">${g.h}</b>–<b class="${g.a > g.h ? 'w' : ''}">${g.a}</b></span>
      <span class="gn">${g.state === 'live' ? 'In progress' : esc(ff || 'Final')}</span>
      ${editable && g.state === 'final' && g.outcome === 'played' ? `<button type="button" class="btn small ghost" data-act="edit" data-n="${n}">Edit</button>` : ''}`;
  } else {
    const txt = n === curN ? 'Next up' : (p.decided || st === 'final') ? 'Not needed' : n === 5 ? 'Only if 2–2' : 'Upcoming';
    right = `<span class="gn">${txt}</span>`;
  }
  const cls = g && g.state === 'live' ? ' live' : n === curN ? ' next' : !g ? ' todo' : '';
  return `<div class="grow${cls}" data-n="${n}"><div class="g-main">${label}${who}</div><div class="g-right">${right}</div></div>`;
}
/* Mixed pairs: for each team choose the man and woman for Mixed 1; the other two play Mixed 2. */
function lineupHtml(m, teams, p, editable) {
  const snap = S.snaps.get(m.id);
  const locked = p.games.some(g => g.n >= 3);
  const ed = S.ed;
  let anyMissing = false;
  const block = i => {
    const id = teams[i];
    if (!id) return `<div class="lu-team"><p class="muted">Choose the ${i ? 'right' : 'left'} team first.</p></div>`;
    const t = A.TEAM.get(id);
    const men = t.roster.filter(x => x.g === 'M').map(x => x.name), women = t.roster.filter(x => x.g === 'F').map(x => x.name);
    const lu = snap && snap.lineup && snap.lineup[i ? 'A' : 'H'];
    const saved = lu && lu.team === id ? lu : null;
    if (!saved) anyMissing = true;
    const pick = ed.lu[i] || (saved ? { man: saved.xd1[0], woman: saved.xd1[1] } : { man: '', woman: '' });
    const other = (list, x) => x ? list.find(y => y !== x) : '';
    const xd2 = pick.man && pick.woman ? `${esc(other(men, pick.man))} &amp; ${esc(other(women, pick.woman))}` : '<i>picked automatically</i>';
    const head = `<div class="lu-head"><span class="mono">${esc(mono(id))}</span><b>${esc(teamName(id))}</b>${saved ? '<span class="chip st-final">Set</span>' : '<span class="chip">Not set</span>'}</div>`;
    if (locked || !editable) {
      return `<div class="lu-team">${head}<p class="lu-line"><span>Mixed 1</span>${saved ? esc(saved.xd1.join(' & ')) : '<i>not set</i>'}</p>
        <p class="lu-line"><span>Mixed 2</span>${saved ? esc(saved.xd2.join(' & ')) : '<i>not set</i>'}</p></div>`;
    }
    const sel = (role, list, cur) => `<select class="control" data-lu="${i}" data-role="${role}" aria-label="Mixed 1 ${role} for ${esc(teamName(id))}">
      <option value="">${role === 'man' ? 'Man…' : 'Woman…'}</option>${list.map(x => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
    return `<div class="lu-team">${head}
      <div class="lu-line"><span>Mixed 1</span><div class="lu-sel">${sel('man', men, pick.man)}${sel('woman', women, pick.woman)}</div></div>
      <p class="lu-line"><span>Mixed 2</span>${xd2}</p></div>`;
  };
  const body = block(0) + block(1);
  const note = locked ? 'Locked: Mixed 1 has started. To change, remove games 3 onward first.'
    : 'Pick each team’s Mixed 1 pair; the other man and woman play Mixed 2. Saved as soon as both are chosen. Can be changed every round until Mixed 1 starts.';
  const open = !locked && (anyMissing || ed.luOpen);
  return `<details class="lineup"${open ? ' open' : ''}><summary><h3>Mixed pairs</h3><span class="muted small">${anyMissing ? 'Not set yet' : locked ? 'Locked' : 'Set'}</span></summary>
    <p class="hint">${note}</p><div class="lu-grid">${body}</div></details>`;
}
/* Dreambreaker: who is on court now. Each player takes four consecutive rallies in the submitted order. */
function dbNowHtml(order, rallies) {
  if (!order) return '<i>Order not set</i> · all four rotate';
  const k = Math.floor(rallies / 4) % 4, left = 4 - (rallies % 4);
  return `<b>${k + 1}. ${esc(order[k])}</b> · next ${esc(order[(k + 1) % 4])} in ${left} ${left === 1 ? 'rally' : 'rallies'}`;
}
function sideTeams(m) {
  const snap = S.snaps.get(m.id);
  const started = snap && snap.status !== 'scheduled';
  return started ? [snap.home, snap.away] : (m.stage === 'pool' ? [m.home, m.away] : S.ed.pick);
}
/* Dreambreaker order: each team's 1st-4th player, submitted before the Dreambreaker begins. */
function dbOrderHtml(m, teams, p, editable, curN) {
  const ed = S.ed;
  const locked = p.games.some(g => g.n >= 5);
  if (p.decided && !locked) return '';   // decided without a 2-2: no Dreambreaker in this match
  let anyMissing = false;
  const block = i => {
    const id = teams[i];
    if (!id) return `<div class="lu-team"><p class="muted">Choose the ${i ? 'right' : 'left'} team first.</p></div>`;
    const t = A.TEAM.get(id);
    const saved = A.dbOrder(m, teams)[i];
    if (!saved) anyMissing = true;
    const head = `<div class="lu-head"><span class="mono">${esc(mono(id))}</span><b>${esc(teamName(id))}</b>${saved ? '<span class="chip st-final">Set</span>' : '<span class="chip">Not set</span>'}</div>`;
    if (locked || !editable) {
      return `<div class="lu-team">${head}${saved ? `<ol class="db-list">${saved.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="lu-line"><i>not set</i></p>'}</div>`;
    }
    const pick = ed.dbo[i] || (saved ? saved.slice() : ['', '', '', '']);
    const dup = new Set(pick.filter(Boolean)).size !== pick.filter(Boolean).length;
    const names = t.roster.map(x => x.name);
    const sel = k => `<label class="db-pos"><span>${['1st', '2nd', '3rd', '4th'][k]}</span><select class="control" data-dbo="${i}" data-pos="${k}" aria-label="Dreambreaker ${['1st', '2nd', '3rd', '4th'][k]} player for ${esc(teamName(id))}">
      <option value="">Player…</option>${names.map(x => `<option${x === pick[k] ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
    return `<div class="lu-team">${head}<div class="db-grid">${[0, 1, 2, 3].map(sel).join('')}</div>${dup ? '<p class="form-error">Each player can be picked only once.</p>' : ''}</div>`;
  };
  const body = block(0) + block(1);
  const note = locked ? 'Locked: the Dreambreaker has started. To change, remove the Dreambreaker first.'
    : 'Only needed at 2–2. Each team submits its order before the Dreambreaker begins. Each player takes 4 rallies in turn, any gender order. Saved as soon as all four are chosen.';
  const open = !locked && ((curN === 5 && anyMissing) || ed.dbOpen);
  return `<details class="lineup dborder"${open ? ' open' : ''}><summary><h3>Dreambreaker order</h3><span class="muted small">${anyMissing ? 'Not set yet' : locked ? 'Locked' : 'Set'}</span></summary>
    <p class="hint">${note}</p><div class="lu-grid">${body}</div></details>`;
}
async function saveDbOrder(m, i) {
  const ed = S.ed;
  const id = sideTeams(m)[i];
  const order = ed.dbo[i].slice();
  clearTimeout(ed.timer);
  while (ed.saving) await new Promise(r => setTimeout(r, 120));
  if (ed.local) await flush();
  if (S.ed !== ed) return;
  const ok = await call('set_allout_match_db_order_v1', { p_match_id: m.id, p_expected_version: version(m), p_side: i ? 'A' : 'H', p_team: id, p_order: order });
  if (S.ed !== ed) return;
  ed.dbo[i] = null;
  ed.dbOpen = true;
  if (ok) toast(`Dreambreaker order saved for ${teamName(id)}.`);
  renderSheet();
}
async function saveLineup(m, i) {
  const ed = S.ed;
  const snap = S.snaps.get(m.id);
  const started = snap && snap.status !== 'scheduled';
  const teams = started ? [snap.home, snap.away] : (m.stage === 'pool' ? [m.home, m.away] : ed.pick);
  const id = teams[i], t = A.TEAM.get(id);
  const { man, woman } = ed.lu[i];
  const men = t.roster.filter(x => x.g === 'M').map(x => x.name), women = t.roster.filter(x => x.g === 'F').map(x => x.name);
  clearTimeout(ed.timer);
  while (ed.saving) await new Promise(r => setTimeout(r, 120));
  if (ed.local) await flush();
  if (S.ed !== ed) return;
  const ok = await call('set_allout_match_lineup_v1', {
    p_match_id: m.id, p_expected_version: version(m), p_side: i ? 'A' : 'H', p_team: id,
    p_xd1: [man, woman], p_xd2: [men.find(x => x !== man), women.find(x => x !== woman)]
  });
  if (S.ed !== ed) return;
  ed.lu[i] = null;
  ed.luOpen = true;
  if (ok) toast(`Mixed pairs saved for ${teamName(id)}.`);
  renderSheet();
}
const ACTION_TEXT = { match_lineup_set: 'Mixed pairs set', match_db_order_set: 'Dreambreaker order set', match_game_recorded: 'Score saved', match_game_removed: 'Last game removed', match_finalized: 'Result confirmed', match_reopened: 'Reopened', match_reset: 'Reset' };
function snapSummary(s) {
  if (!s || !s.games) return '';
  return s.games.map(g => `${g.h}–${g.a}${g.state === 'live' ? '*' : ''}`).join(', ') || 'no games';
}
function historyHtml(m, list) {
  if (!list) return '<p class="muted">Loading…</p>';
  if (list.error) return `<p class="form-error">${esc(list.error)}</p>`;
  if (!list.length) return '<p class="muted">No changes yet.</p>';
  return '<ol class="hist">' + list.map(e => {
    const reason = e.after && e.after.reason;
    return `<li><time>${esc(fmtStamp(e.at))}</time> <b>${esc(ACTION_TEXT[e.action] || e.action)}</b> by ${esc(e.by)}
      <span class="muted">${esc(snapSummary(e.after))}</span>${reason ? `<span class="reason">Reason: ${esc(reason)}</span>` : ''}</li>`;
  }).join('') + '</ol>';
}

/* ------------------------------------------------------------------ sheet actions */
dlg.addEventListener('change', ev => {
  const sel = ev.target.closest('[data-pick]');
  if (sel && S.ed) { S.ed.pick[Number(sel.dataset.pick)] = sel.value; renderSheet(); }
  if (ev.target.matches('[data-pts]') && S.ed && S.ed.local) flush();   // typed score: save as soon as the box is left
  const dbo = ev.target.closest('[data-dbo]');
  if (dbo && S.ed) {
    const i = Number(dbo.dataset.dbo), m = A.MATCH.get(S.open);
    const box = dbo.closest('.lu-team');
    S.ed.dbo[i] = [0, 1, 2, 3].map(k => box.querySelector(`[data-pos="${k}"]`).value);
    const o = S.ed.dbo[i];
    if (o.every(Boolean) && new Set(o).size === 4) saveDbOrder(m, i); else renderSheet();
    return;
  }
  const lu = ev.target.closest('[data-lu]');
  if (lu && S.ed) {
    const i = Number(lu.dataset.lu), m = A.MATCH.get(S.open);
    const box = lu.closest('.lu-team');
    S.ed.lu[i] = { man: box.querySelector('[data-role="man"]').value, woman: box.querySelector('[data-role="woman"]').value };
    if (S.ed.lu[i].man && S.ed.lu[i].woman) saveLineup(m, i); else renderSheet();
  }
});
/* Typing a score: digits only, 0-99. Saves shortly after typing stops, like the + and − buttons. */
dlg.addEventListener('input', ev => {
  const box = ev.target.closest('[data-pts]');
  if (!box || !S.ed) return;
  const m = A.MATCH.get(S.open);
  const raw = box.value.replace(/\D/g, '').slice(0, 2);
  if (raw !== box.value) box.value = raw;
  const cur = currentGame(m); if (!cur) return;
  const v = raw === '' ? 0 : Math.min(99, Number(raw));
  if (box.dataset.pts === '0') cur.h = v; else cur.a = v;
  S.ed.local = cur;
  if (raw !== '') renderSheet();
  clearTimeout(S.ed.timer);
  S.ed.timer = setTimeout(() => flush(), 1200);
});
dlg.addEventListener('toggle', ev => {
  if (!ev.target.matches || !S.ed) return;
  if (ev.target.matches('details.dborder')) S.ed.dbOpen = ev.target.open;
  else if (ev.target.matches('details.lineup')) S.ed.luOpen = ev.target.open;
}, true);
dlg.addEventListener('focusin', ev => { if (ev.target.matches('[data-pts]') && !S.refocusing) { const box = ev.target; setTimeout(() => { if (document.activeElement === box) box.select(); }, 0); } });
dlg.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('[data-pts]')) { ev.preventDefault(); ev.target.blur(); } });
dlg.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]');
  if (!b || !S.ed || b.disabled) return;
  const act = b.dataset.act, m = A.MATCH.get(S.open);
  if (act === 'close') return closeSheet();
  if (act === 'pt') return tapPoint(m, Number(b.dataset.side), Number(b.dataset.d));
  if (act === 'endgame') return endGame(m);
  if (act === 'forfeit') return forfeit(m);
  if (act === 'edit') { S.ed.editGame = Number(b.dataset.n); return renderSheet(); }
  if (act === 'canceledit') { S.ed.editGame = null; return renderSheet(); }
  if (act === 'saveedit') return saveEdit(m, Number(b.dataset.n));
  if (act === 'finalize') return finalize(m);
  if (act === 'removelast') return removeLast(m);
  if (act === 'reopen') return reopen(m);
  if (act === 'reset') return reset(m);
  if (act === 'history') { S.ed.historyOpen = !S.ed.historyOpen; renderSheet(); if (S.ed.historyOpen) loadHistory(m); }
});

function currentGame(m) {
  const snap = S.snaps.get(m.id), p = progress(m, snap), ed = S.ed;
  const n = p.live ? p.live.n : p.next;
  if (!n) return null;
  if (ed.local && ed.local.n === n) return { ...ed.local };
  return p.live ? { n, h: p.live.h, a: p.live.a } : { n, h: 0, a: 0 };
}
function teamArgs(m) {
  if (m.stage === 'pool') return [null, null];
  const snap = S.snaps.get(m.id);
  if (snap && snap.status !== 'scheduled' && snap.home) return [snap.home, snap.away];
  return S.ed.pick;
}
function tapPoint(m, side, d) {
  const cur = currentGame(m); if (!cur) return;
  if (side === 0) cur.h = Math.max(0, Math.min(99, cur.h + d)); else cur.a = Math.max(0, Math.min(99, cur.a + d));
  S.ed.local = cur;
  renderSheet();
  clearTimeout(S.ed.timer);
  S.ed.timer = setTimeout(() => flush(), 700);
}
/* Save the live score of the current game. Saves run one at a time; taps during a save are sent next. */
async function flush(state = 'live', outcome = 'played') {
  const ed = S.ed; if (!ed) return false;
  clearTimeout(ed.timer);
  if (ed.saving) { ed.again = true; return false; }
  const m = A.MATCH.get(ed.id);
  const g = state === 'live' ? ed.local : currentGame(m);
  if (!g) return true;
  const sent = { ...g };
  ed.saving = true; renderSheet();
  const ok = await call('record_allout_game_v1', {
    p_match_id: m.id, p_expected_version: version(m), p_home_team: teamArgs(m)[0], p_away_team: teamArgs(m)[1],
    p_game_no: sent.n, p_home_points: sent.h, p_away_points: sent.a, p_state: state, p_outcome: outcome
  });
  if (S.ed !== ed) return ok;               // the sheet was closed meanwhile
  ed.saving = false;
  if (ok && ed.local && ed.local.n === sent.n && ed.local.h === sent.h && ed.local.a === sent.a) ed.local = null;
  if (ok && state === 'final') ed.local = null;
  ed.offline = !ok && lastCallOffline;
  if (!ok && ed.offline && state === 'live') {
    // no connection: keep the score on screen and try again shortly
    ed.timer = setTimeout(() => flush(), 4000);
  } else if (!ok) ed.local = null;          // refused by the database: show what it has
  if (ed.again && ed.local && !ed.offline) { ed.again = false; return flush(); }
  ed.again = false;
  renderSheet();
  return ok;
}
const version = m => { const s = S.snaps.get(m.id); return s ? s.version : 0; };
let lastCallOffline = false;
async function call(fn, args) {
  lastCallOffline = false;
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw error;
    if (data && data.id) applySnapshot(data);
    renderView();
    return data || true;
  } catch (e) {
    const msg = friendly(e);
    lastCallOffline = /No connection/.test(msg);
    if (!(lastCallOffline && S.ed && S.ed.offline)) toast(msg, 'error');
    if (/changed by someone else|Reload/i.test(msg)) await loadScores({ quiet: true });
    return false;
  }
}
async function endGame(m) {
  const cur = currentGame(m);
  if (!cur || !finalOk(cur.h, cur.a)) return;
  const ed = S.ed;
  clearTimeout(ed.timer);
  while (ed.saving) await new Promise(r => setTimeout(r, 120));
  if (S.ed !== ed) return;
  ed.local = cur;
  const ok = await flush('final');
  if (ok) {
    const p = progress(m, S.snaps.get(m.id));
    toast(p.decided ? 'Game saved. The match is decided: check and confirm the result.' : `Game ${cur.n} saved. Game ${p.next} is next.`);
  }
}
async function saveEdit(m, n) {
  const row = dlg.querySelector(`.grow.editing[data-n="${n}"]`);
  const h = Number(row.querySelector('[data-edit="h"]').value), a = Number(row.querySelector('[data-edit="a"]').value);
  if (!Number.isInteger(h) || !Number.isInteger(a) || !finalOk(h, a)) { toast('That is not a finished game: games end at 21, win by 2 (exactly 2 once past 21).', 'error'); return; }
  const ok = await call('record_allout_game_v1', {
    p_match_id: m.id, p_expected_version: version(m), p_home_team: teamArgs(m)[0], p_away_team: teamArgs(m)[1],
    p_game_no: n, p_home_points: h, p_away_points: a, p_state: 'final', p_outcome: 'played'
  });
  if (ok && S.ed) { S.ed.editGame = null; toast(`Game ${n} corrected.`); }
  renderSheet();
}
async function forfeit(m) {
  const cur = currentGame(m); if (!cur) return;
  const [h, a] = teamArgs(m).map((id, i) => id || (m.stage === 'pool' ? [m.home, m.away][i] : null));
  const res = await ask({
    title: `Forfeit game ${cur.n}`,
    text: 'Which team forfeits this game? The other team is awarded it, and the game is recorded as final.',
    extra: `<div class="ff-pick">
      <label><input type="radio" name="ff" value="forfeit_home"> ${esc(teamName(h) || 'Left team')} forfeits</label>
      <label><input type="radio" name="ff" value="forfeit_away"> ${esc(teamName(a) || 'Right team')} forfeits</label></div>
      <p class="muted small">Points at the forfeit: <input class="control num" type="number" min="0" max="99" id="ffH" value="${cur.h}"> – <input class="control num" type="number" min="0" max="99" id="ffA" value="${cur.a}"></p>`,
    reason: false, ok: 'Record forfeit',
    validate: () => {
      const o = ($('input[name="ff"]:checked') || {}).value;
      if (!o) return 'Choose the team that forfeits.';
      const fh = Number($('#ffH').value), fa = Number($('#ffA').value);
      if (!finalOk(fh, fa, o)) return 'The team that is awarded the game must have more points. Adjust the points.';
      return null;
    },
    collect: () => ({ o: $('input[name="ff"]:checked').value, h: Number($('#ffH').value), a: Number($('#ffA').value) })
  });
  if (!res) return;
  S.ed.local = null; clearTimeout(S.ed.timer);
  const ok = await call('record_allout_game_v1', {
    p_match_id: m.id, p_expected_version: version(m), p_home_team: teamArgs(m)[0], p_away_team: teamArgs(m)[1],
    p_game_no: cur.n, p_home_points: res.h, p_away_points: res.a, p_state: 'final', p_outcome: res.o
  });
  if (ok) toast(`Game ${cur.n} recorded as a forfeit.`);
  renderSheet();
}
async function finalize(m) {
  const p = progress(m, S.snaps.get(m.id));
  const w = p.decided === 'H' ? sideLabel(m, 0) : sideLabel(m, 1);
  const res = await ask({ title: 'Confirm result', text: `${w} wins ${Math.max(p.hw, p.aw)}–${Math.min(p.hw, p.aw)}. Once confirmed the match is locked and the standings update.`, reason: false, ok: 'Confirm result' });
  if (!res) return;
  const ok = await call('finalize_allout_match_v1', { p_match_id: m.id, p_expected_version: version(m) });
  if (ok) toast('Result confirmed.');
  renderSheet();
}
async function removeLast(m) {
  const p = progress(m, S.snaps.get(m.id));
  const last = p.games[p.games.length - 1];
  const res = await ask({ title: `Remove game ${last.n}?`, text: `This deletes game ${last.n} (${last.h}–${last.a}). Use it only for a game entered by mistake.`, reason: false, ok: 'Remove game', danger: true });
  if (!res) return;
  S.ed.local = null;
  const ok = await call('remove_allout_last_game_v1', { p_match_id: m.id, p_expected_version: version(m) });
  if (ok) toast(`Game ${last.n} removed.`);
  renderSheet();
}
async function reopen(m) {
  const res = await ask({ title: 'Reopen this match?', text: 'The result goes back to live so a game can be corrected. Standings drop this result until it is confirmed again.', reason: true, ok: 'Reopen' });
  if (!res) return;
  const ok = await call('reopen_allout_match_v1', { p_match_id: m.id, p_expected_version: version(m), p_reason: res.reason });
  if (ok) toast('Match reopened.');
  renderSheet();
}
async function reset(m) {
  const res = await ask({ title: 'Reset this match?', text: 'This deletes every game of this match and sets it back to not started. The change and your reason stay in the activity log.', reason: true, ok: 'Reset match', danger: true });
  if (!res) return;
  S.ed.local = null;
  const ok = await call('reset_allout_match_v1', { p_match_id: m.id, p_expected_version: version(m), p_reason: res.reason });
  if (ok) { toast('Match reset.'); const [h, a] = A.participants(m); if (S.ed) S.ed.pick = [h || '', a || '']; }
  renderSheet();
}
async function loadHistory(m) {
  const { data, error } = await client.rpc('get_allout_match_history_v1', { p_match_id: m.id });
  if (!S.ed || S.ed.id !== m.id) return;
  S.ed.history = error ? { error: friendly(error) } : (data || []);
  renderSheet();
}

/* ------------------------------------------------------------------ ask dialog */
const askDlg = $('#askDlg');
function ask({ title, text, extra = '', reason = false, ok = 'OK', danger = false, validate = null, collect = null }) {
  return new Promise(resolve => {
    $('#askTitle').textContent = title;
    $('#askText').textContent = text;
    $('#askExtra').innerHTML = extra;
    $('#askReasonWrap').hidden = !reason;
    $('#askReason').value = '';
    $('#askError').hidden = true;
    const okBtn = $('#askOk');
    okBtn.textContent = ok; okBtn.className = 'btn ' + (danger ? 'danger solid' : 'primary');
    const done = val => { cleanup(); askDlg.close(); resolve(val); };
    const onSubmit = ev => {
      ev.preventDefault();
      let err = validate ? validate() : null;
      const r = $('#askReason').value.trim();
      if (!err && reason && r.length < 5) err = 'Give a short reason (5 or more characters).';
      if (err) { $('#askError').textContent = err; $('#askError').hidden = false; return; }
      done({ reason: r, ...(collect ? collect() : {}) });
    };
    const onCancel = ev => { if (ev) ev.preventDefault(); done(null); };
    function cleanup() { $('#askForm').removeEventListener('submit', onSubmit); $('#askCancel').removeEventListener('click', onCancel); askDlg.removeEventListener('cancel', onCancel); }
    $('#askForm').addEventListener('submit', onSubmit);
    $('#askCancel').addEventListener('click', onCancel);
    askDlg.addEventListener('cancel', onCancel);
    askDlg.showModal();
    (reason ? $('#askReason') : okBtn).focus();
  });
}

/* ------------------------------------------------------------------ standings */
$('#stDiv').innerHTML = A.DIV_ORDER.map(d => `<button type="button" role="tab" data-div="${d}">${esc(A.DIVISIONS[d].label)}</button>`).join('');
$('#stDiv').addEventListener('click', ev => { const b = ev.target.closest('[data-div]'); if (b) { S.stDiv = b.dataset.div; renderStandings(); } });
const Q_TEXT = { Q: 'Qualified', WC: 'Wildcard', OUT: 'Out', TIE: 'Special tiebreak needed' };
function renderStandings() {
  const div = S.stDiv;
  $$('#stDiv button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.div === div)));
  const D = A.DIVISIONS[div];
  const q = A.qualification(div);
  let html = `<p class="muted">${esc(D.qualifyLong)}</p><div class="brackets">`;
  for (const t of q.tables) {
    const played = A.MATCHES.filter(m => m.stage === 'pool' && m.div === div && m.bracket === t.bracket);
    const done = played.filter(m => statusOf(m) === 'final').length;
    html += `<div class="panel bt"><h3>Bracket ${esc(t.bracket)} <small>${done}/${played.length} confirmed</small></h3>
      <table class="tbl"><thead><tr><th>#</th><th>Team</th><th title="Matches won-lost">W–L</th><th title="Regular games won-lost">Games</th><th title="Dreambreakers played">DB</th><th title="Point differential (regular games)">PD</th><th></th></tr></thead><tbody>`;
    for (const e of t.ranked) {
      const r = e.row, s = q.status[r.id];
      html += `<tr${e.reason ? ` title="${esc(e.reason)}"` : ''}><td>${e.rank ?? '–'}</td><td>${esc(teamName(r.id))}</td><td>${r.W}–${r.L}</td><td>${r.GW}–${r.GL}</td><td>${r.D}</td><td>${esc(A.signed(r.PD))}</td>
        <td>${s ? `<span class="q q-${s}">${Q_TEXT[s]}</span>` : ''}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  html += '</div>';
  if (q.notes.length) html += `<div class="panel warn">${q.notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>`;
  if (q.seeds) html += `<div class="panel"><h3>Semifinal seeds</h3><ol class="seeds">${q.seeds.map(id => `<li>${esc(teamName(id))}</li>`).join('')}</ol></div>`;
  const ko = A.MATCHES.filter(m => m.div === div && m.stage !== 'pool').sort((a, b) => a.time.localeCompare(b.time) || a.court - b.court);
  html += `<h3 class="slot-h">Knockout</h3><div class="mgrid">${ko.map(m => matchCard(m)).join('')}</div>`;
  const pl = A.placements(div);
  if (pl.every(Boolean)) html += `<div class="panel podium"><h3>Final placings</h3><ol>${pl.map((id, i) => `<li><b>${['Champion', 'Runner-up', 'Third', 'Fourth'][i]}</b> ${esc(teamName(id))}</li>`).join('')}</ol></div>`;
  $('#standings').innerHTML = html;
}

/* ------------------------------------------------------------------ activity */
$('#actReload').addEventListener('click', () => { S.activity = null; renderActivity(true); });
async function renderActivity(force = false) {
  const box = $('#activity');
  if (!S.activity || force || Date.now() - S.activityAt > 30000) {
    if (!S.activity) box.innerHTML = '<p class="muted">Loading…</p>';
    const { data, error } = await client.rpc('get_allout_score_activity_v1', { p_limit: 200 });
    S.activity = error ? { error: friendly(error) } : (data || []);
    S.activityAt = Date.now();
  }
  if (S.view !== 'activity') return;
  const list = S.activity;
  if (list.error) { box.innerHTML = `<p class="form-error">${esc(list.error)}</p>`; return; }
  if (!list.length) { box.innerHTML = '<p class="empty-note">No score changes yet.</p>'; return; }
  box.innerHTML = '<table class="tbl act"><thead><tr><th>When</th><th>Match</th><th>Change</th><th>By</th><th>Score after</th></tr></thead><tbody>' + list.map(e => {
    const m = A.MATCH.get(e.match);
    const label = m ? `${A.DIVISIONS[m.div].label} ${m.stage === 'pool' ? m.code : stageLabel(m)} · Court ${m.court}` : e.match;
    const reason = e.after && e.after.reason;
    return `<tr><td>${esc(fmtStamp(e.at))}</td><td><button type="button" class="link" data-match="${esc(e.match)}">${esc(label)}</button></td>
      <td>${esc(ACTION_TEXT[e.action] || e.action)}${reason ? `<span class="reason">${esc(reason)}</span>` : ''}</td><td>${esc(e.by)}</td><td>${esc(snapSummary(e.after))}</td></tr>`;
  }).join('') + '</tbody></table>';
}

/* ------------------------------------------------------------------ teams */
$('#tSearch').addEventListener('input', () => renderTeams());
function renderTeams() {
  const q = $('#tSearch').value.trim().toLowerCase();
  let html = '';
  for (const div of A.DIV_ORDER) {
    const teams = A.TEAMS.filter(t => t.div === div && (!q || t.name.toLowerCase().includes(q) || t.roster.some(p => p.name.toLowerCase().includes(q))));
    if (!teams.length) continue;
    html += `<h3 class="slot-h">${esc(A.DIVISIONS[div].label)}</h3><div class="tgrid">` + teams.map(t => `<div class="panel tcard">
      <div class="tc-head"><span class="mono">${esc(mono(t.id))}</span><div><b>${esc(t.name)}</b><small>Bracket ${esc(t.bracket)} · slot ${t.slot}</small></div></div>
      <ul>${t.roster.map(p => `<li>${esc(p.name)} <small>${p.g === 'F' ? 'W' : 'M'}${p.captain ? ' · Captain' : ''}</small></li>`).join('')}</ul></div>`).join('') + '</div>';
  }
  $('#teams').innerHTML = html || '<p class="empty-note">No team or player matches that search.</p>';
}

/* ------------------------------------------------------------------ boot */
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.access) loadScores({ quiet: true }); });
window.addEventListener('beforeunload', ev => { if (S.ed && (S.ed.local || S.ed.saving)) { ev.preventDefault(); ev.returnValue = ''; } });
(async () => {
  const { data } = await client.auth.getSession();
  await checkAccess(data.session);
})();
})();
