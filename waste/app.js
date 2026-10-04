// Lab Waste Tracker: a static app on GitHub Pages. Everyone can view the tanks;
// lab members sign in with a GitHub token, and every change is committed to
// waste/data.json through the GitHub API (so the repository history is the log).
import { FORM_ROWS, FORM_TEMPLATES, buildFormDocx, formNum } from './form.js';

// ---------------------------------------------------------------- rules
const TANK_MAX_L = 10.0;
const ALERT_THRESHOLD_L = 9.0; // "almost full" warning
const RULE_LIMIT_L = 2.5;      // k: non-water ≤ 2.5 L, f-OH: water ≤ 2.5 L
const EPS = 0.001;
const SOLVENTS = ['water', 'ethanol', 'acetone', 'hexane', 'cyclohexane', 'methanol'];
const WASTE_TYPES = ['k', 'f-OH', 'f', 'f-N', 'h-L', 'h-a', 'a', 'a-Hg', 'b', 'b-f', 'b-p', 'd', 'e', 'g', 'i', 'j', 'p', 'Cyanide'];
const SOLVENT_COLORS = {
  water: '#4cc9f0', ethanol: '#4895ef', acetone: '#f72585',
  hexane: '#f9c74f', cyclohexane: '#fb8500', methanol: '#8338ec',
};
const EXTRA_COLORS = ['#adb5bd', '#90be6d', '#43aa8b', '#f8961e', '#b5838d', '#6d6875', '#90e0ef', '#e5989b', '#ffb4a2', '#577590'];
const RECENT = 30;

// ---------------------------------------------------------------- site / storage
// Not the Research dashboard's key (rpd.auth): the shared lab token belongs to the
// admin's account and must never sign anyone in to the dashboard.
const KEY = { auth: 'lab.waste.auth', name: 'lab.waste.name' };
const store = {
  get(k, fb = null) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
function detectRepo() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const first = location.pathname.split('/').filter(Boolean)[0];
    const repo = first && first !== 'waste' ? first : `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: 'purin1999', repo: 'Lab-management' };
}
const SITE = { ...detectRepo(), branch: 'main', path: 'waste/data.json' };

const state = {
  data: null, sha: null, source: '', loadError: '',
  auth: { token: '', ...(store.get(KEY.auth) || {}) },
  name: store.get(KEY.name, ''),
  form: null,     // the entry form of the open tank
  showAll: {},    // tank id -> show every entry
  busy: false,
};

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const f3 = (x) => (Math.round(x * 1e3) / 1e3).toFixed(3);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Lab time is JST whatever the device's time zone is.
const jstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const today = () => jstNow().slice(0, 10);
// The chosen disposal date with the current time, so same-day entries keep their order.
const stampFor = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} ${jstNow().slice(11)}` : jstNow());

function colorOf(name, i = 0) {
  if (SOLVENT_COLORS[name]) return SOLVENT_COLORS[name];
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[(h + i) % EXTRA_COLORS.length];
}
// "Water", " water " -> "water", so the k / f-OH rules always see it.
function canonSolvent(s) {
  const t = String(s || '').trim();
  const known = SOLVENTS.find((k) => k.toLowerCase() === t.toLowerCase());
  return known || t;
}

// ---------------------------------------------------------------- data model
function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    version: 1,
    tanks: Array.isArray(d.tanks) ? d.tanks : [],
    entries: Array.isArray(d.entries) ? d.entries : [],
    feedback: Array.isArray(d.feedback) ? d.feedback : [],
  };
}
const byTankId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const findTank = (d, id) => d.tanks.find((t) => t.id === id);
const nextId = (list) => list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
const entryCmp = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id);
const entriesOf = (d, tankId, order = 'asc') => {
  const list = d.entries.filter((e) => e.tank === tankId).sort(entryCmp);
  return order === 'desc' ? list.reverse() : list;
};

function summarize(entries) {
  const by = {};
  for (const e of entries) for (const s of e.solvents) by[s.name] = (by[s.name] || 0) + s.L;
  const bySolvent = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, r4(v)]).sort((a, b) => b[1] - a[1]));
  const total = r4(Object.values(bySolvent).reduce((a, b) => a + b, 0));
  return { total, water: bySolvent.water || 0, bySolvent };
}
const tankSummary = (d, tankId) => summarize(entriesOf(d, tankId));

// Returns an error message, or '' when the entry fits the tank and its rule.
function checkEntry(d, tankId, solvents, replaceId = null) {
  const tank = findTank(d, tankId);
  if (!tank) return 'Tank not found.';
  const others = entriesOf(d, tankId).filter((e) => e.id !== replaceId);
  const base = summarize(others);
  const newTotal = solvents.reduce((a, s) => a + s.L, 0);
  const newWater = solvents.filter((s) => s.name === 'water').reduce((a, s) => a + s.L, 0);
  const total = base.total + newTotal;
  const water = base.water + newWater;
  if (total > TANK_MAX_L + EPS) {
    return `Tank overflow: adding ${f3(newTotal)} L would bring the total to ${f3(total)} L (max ${TANK_MAX_L} L). Only ${f3(TANK_MAX_L - base.total)} L remaining.`;
  }
  if (tank.type === 'k' && total - water > RULE_LIMIT_L + EPS) {
    return `k tank: non-water solvents cannot exceed ${RULE_LIMIT_L} L. After this entry non-water would be ${f3(total - water)} L.`;
  }
  if (tank.type === 'f-OH' && water > RULE_LIMIT_L + EPS) {
    return `f-OH tank: water cannot exceed ${RULE_LIMIT_L} L. After this entry water would be ${f3(water)} L.`;
  }
  return '';
}

function ruleLine(type, total, water) {
  if (!(total > 0)) return '';
  if (type === 'k') {
    const organic = total - water; const ok = organic <= RULE_LIMIT_L + EPS;
    return { ok, text: `k rule: non-water ${f3(organic)} L ${ok ? `✓ (≤ ${RULE_LIMIT_L} L)` : `✗ (must be ≤ ${RULE_LIMIT_L} L)`}` };
  }
  if (type === 'f-OH') {
    const ok = water <= RULE_LIMIT_L + EPS;
    return { ok, text: `f-OH rule: water ${f3(water)} L ${ok ? `✓ (≤ ${RULE_LIMIT_L} L)` : `✗ (must be ≤ ${RULE_LIMIT_L} L)`}` };
  }
  return '';
}

// ---------------------------------------------------------------- GitHub
const b64enc = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function ghApi(url, { method = 'GET', body, token = state.auth.token } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || `GitHub HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}
const contentsUrl = `https://api.github.com/repos/${SITE.owner}/${SITE.repo}/contents/${SITE.path}`;
async function ghGet() {
  const j = await ghApi(`${contentsUrl}?ref=${SITE.branch}&t=${Date.now()}`);
  return { data: normalize(JSON.parse(b64dec(j.content))), sha: j.sha };
}
async function ghPut(data, sha, message) {
  const text = `${JSON.stringify(data, null, 1)}\n`;
  const j = await ghApi(contentsUrl, { method: 'PUT', body: { message, content: b64enc(text), branch: SITE.branch, sha } });
  return j.content.sha;
}

class UserError extends Error {}

// Every change: read the latest file, apply the change to it, commit. If someone
// else committed in between, GitHub refuses the stale sha and we simply redo it,
// so two people logging at the same time never overwrite each other.
async function mutate(message, change, { anonymous = false } = {}) {
  if (!state.auth.token) { openSignIn('Sign in to make changes.'); throw new UserError(''); }
  if (!state.name && !anonymous) { openSignIn('Enter your name first, so the lab knows who logged it.'); throw new UserError(''); }
  if (state.busy) throw new UserError('Still saving the previous change…');
  state.busy = true; document.body.classList.add('busy');
  try {
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await ghGet();
      const result = change(data);
      try {
        state.sha = await ghPut(data, sha, anonymous ? message : `${message} (by ${state.name})`);
        state.data = data; state.source = 'api';
        return result;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 4) continue;
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e.status === 401) throw new UserError('The lab token was not accepted (it may have expired). Ask the admin for the new one and sign in again.');
    if (e.status === 403 || e.status === 404) {
      throw new UserError(`The lab token cannot write to ${SITE.owner}/${SITE.repo}. Ask the admin to check its “Contents: Read and write” permission.`);
    }
    throw new UserError(`Could not save: ${e.message}`);
  } finally {
    state.busy = false; document.body.classList.remove('busy');
    render();
  }
}

async function load({ quiet = false } = {}) {
  try {
    if (state.auth.token) {
      try {
        const { data, sha } = await ghGet();
        Object.assign(state, { data, sha, source: 'api', loadError: '' });
        render(); return;
      } catch (e) {
        if (e.status === 401) toast('The saved lab token was not accepted (expired?). Ask the admin for the new one.', 6000);
      }
    }
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    Object.assign(state, { data: normalize(await res.json()), source: 'pages', loadError: '' });
  } catch (e) {
    state.loadError = e.message;
  }
  render();
  if (!quiet && state.source) toast('Up to date');
}

// ---------------------------------------------------------------- routing
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'report') return { view: 'report', tank: parts[1] || '' };
  if (parts[0] === 'feedback') return { view: 'feedback' };
  if (parts[0] === 't') return { view: 'tanks', tank: parts[1] || '' };
  return { view: 'tanks', tank: '' };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ---------------------------------------------------------------- rendering
function render() {
  renderTop();
  const view = $('#view');
  if (!state.data) {
    view.innerHTML = state.loadError
      ? `<div class="card pad"><p><b>Could not load the waste data.</b></p><p class="muted small">${esc(state.loadError)}</p><button class="btn" data-act="reload">Try again</button></div>`
      : '<p class="muted">Loading…</p>';
    return;
  }
  const r = route();
  if (r.view === 'report') view.innerHTML = renderReport(r.tank);
  else if (r.view === 'feedback') view.innerHTML = renderFeedback();
  else view.innerHTML = renderTanks(r.tank);
  afterRender(r);
}

function renderTop() {
  const r = route();
  $('#nav').innerHTML = [['tanks', '#/', '🧪 Tanks'], ['report', '#/report', '📊 Report'], ['feedback', '#/feedback', '💬 Feedback']]
    .map(([v, h, label]) => `<a href="${h}" class="${r.view === v ? 'on' : ''}">${label}</a>`).join('');
  $('#account').innerHTML = state.auth.token
    ? `<button class="btn ghost" data-act="account" title="Account">👤 ${esc(state.name || 'Account')}</button>`
    : '<button class="btn primary" data-act="signin">Sign in</button>';
  const banner = $('#banner');
  banner.innerHTML = state.auth.token ? ''
    : '<div class="inner info">👀 You are viewing. <a href="#" data-act="signin">Sign in</a> with the lab token to log waste.</div>';
}

function stackBar(bySolvent, scale, tall = false) {
  const segs = Object.entries(bySolvent).map(([name, vol], i) => {
    const pct = scale > 0 ? (vol / scale) * 100 : 0;
    return `<span class="seg" style="width:${pct.toFixed(2)}%;background:${colorOf(name, i)}" title="${esc(name)}: ${f3(vol)} L">${pct > 8 ? esc(name) : ''}</span>`;
  }).join('');
  return `<div class="bar${tall ? ' tall' : ''}">${segs}</div>`;
}
function legend(bySolvent, total) {
  const items = Object.entries(bySolvent).map(([name, vol], i) => `<span class="lg"><i style="background:${colorOf(name, i)}"></i>${esc(name)} ${f3(vol)} L <span class="muted">(${total > 0 ? ((vol / total) * 100).toFixed(1) : 0}%)</span></span>`);
  return `<div class="legend">${items.join('') || '<span class="muted">Empty</span>'}</div>`;
}
const fillClass = (total) => (total >= TANK_MAX_L - EPS ? 'full' : total > ALERT_THRESHOLD_L ? 'near' : '');

// ---- Tanks view
function renderTanks(sel) {
  const d = state.data;
  const active = d.tanks.filter((t) => !t.archived).sort(byTankId);
  const archived = d.tanks.filter((t) => t.archived).sort(byTankId);
  const tank = findTank(d, sel) || active[0];
  if (tank && state.form?.tank !== tank.id) state.form = blankForm(tank.id);

  const chips = active.map((t) => {
    const s = tankSummary(d, t.id);
    return `<a class="chip ${tank && t.id === tank.id ? 'on' : ''} ${fillClass(s.total)}" href="#/t/${encodeURIComponent(t.id)}">
      <b>Tank ${esc(t.id)}</b><span class="badge">${esc(t.type)}</span>
      <span class="mini"><span style="width:${Math.min(100, (s.total / TANK_MAX_L) * 100).toFixed(1)}%"></span></span></a>`;
  }).join('');
  const archivedChip = tank?.archived ? `<a class="chip on" href="#/t/${encodeURIComponent(tank.id)}"><b>Tank ${esc(tank.id)}</b><span class="badge dark">archived</span></a>` : '';

  return `
  <div class="chips" role="tablist">${chips}${archivedChip}
    <button class="chip add" data-act="add-tank">＋ Tank</button>
  </div>
  ${tank ? renderTank(tank) : '<div class="card pad"><p>No tanks yet. Tap <b>＋ Tank</b> to add one.</p></div>'}
  ${archived.length ? `<details class="card archived"><summary>Archived tanks (${archived.length})</summary>
    <div class="list">${archived.map((t) => `<div class="li"><a href="#/t/${encodeURIComponent(t.id)}">Tank ${esc(t.id)} <span class="badge">${esc(t.type)}</span></a>
      <span class="muted small">${f3(tankSummary(d, t.id).total)} L logged</span><span class="spacer"></span>
      <button class="btn small" data-act="unarchive" data-tank="${esc(t.id)}">Unarchive</button></div>`).join('')}</div></details>` : ''}`;
}

function renderTank(t) {
  const d = state.data;
  const s = tankSummary(d, t.id);
  const rule = ruleLine(t.type, s.total, s.water);
  const entries = entriesOf(d, t.id, 'desc');
  const shown = state.showAll[t.id] ? entries : entries.slice(0, RECENT);
  return `
  <section class="card pad storage ${fillClass(s.total)}">
    <div class="row">
      <h2>Tank ${esc(t.id)} <span class="badge">${esc(t.type)}</span>${t.archived ? ' <span class="badge dark">archived</span>' : ''}</h2>
      <span class="spacer"></span>
      <button class="btn ghost small" data-act="tank-settings" data-tank="${esc(t.id)}">⚙︎ Settings</button>
    </div>
    <div class="row space">
      <span class="small"><b class="${s.total >= TANK_MAX_L - EPS ? 'bad' : ''}">${f3(s.total)} / ${TANK_MAX_L} L</b>
        <span class="muted">(${f3(TANK_MAX_L - s.total)} L free)</span></span>
    </div>
    ${stackBar(s.bySolvent, TANK_MAX_L, true)}
    ${legend(s.bySolvent, s.total)}
    ${rule ? `<p class="rule ${rule.ok ? 'good' : 'bad'}">${esc(rule.text)}</p>` : ''}
  </section>

  ${t.archived ? '<div class="card pad muted small">This tank is archived (already collected). Unarchive it to log new waste.</div>' : renderEntryForm(t)}

  <section class="card">
    <div class="card-head row">
      <h3>Entries <span class="muted small">(${entries.length})</span></h3>
      <span class="spacer"></span>
      <button class="btn small" data-act="word-form" data-tank="${esc(t.id)}">📄 Word form</button>
      <button class="btn small" data-act="csv" data-tank="${esc(t.id)}">⇩ CSV</button>
    </div>
    ${entries.length ? `<div class="entries">${shown.map((e) => entryItem(e, !t.archived)).join('')}</div>` : '<p class="muted pad small">No entries yet.</p>'}
    ${entries.length > shown.length ? `<div class="pad center"><button class="btn small" data-act="show-all" data-tank="${esc(t.id)}">Show all ${entries.length} entries</button></div>` : ''}
  </section>`;
}

function entryItem(e, actions) {
  const lines = e.solvents.map((s, i) => `<div class="sl"><i style="background:${colorOf(s.name, i)}"></i><b>${esc(s.name)}</b> ${esc(formNum(s.L))} L
    ${s.solute ? `<span class="muted">· ${esc(s.solute)}${s.conc != null && s.conc !== '' ? ` ${esc(formNum(s.conc))} g/L` : ''}</span>` : (s.conc != null && s.conc !== '' ? `<span class="muted">· ${esc(formNum(s.conc))} g/L</span>` : '')}</div>`).join('');
  return `<div class="entry${state.form?.replaceId === e.id ? ' editing' : ''}">
    <div class="meta"><span class="date">${esc(e.at.slice(0, 10))}</span><span class="by">${esc(e.by)}</span></div>
    <div class="lines">${lines}</div>
    ${actions ? `<div class="acts">
      <button class="btn tiny" data-act="copy-entry" data-id="${e.id}" title="Fill the form with the same solvents">Copy</button>
      <button class="btn tiny warn" data-act="edit-entry" data-id="${e.id}">Edit</button>
      <button class="btn tiny danger" data-act="del-entry" data-id="${e.id}">Del</button></div>` : ''}
  </div>`;
}

// ---- Entry form (state.form mirrors the inputs so a re-render keeps what was typed)
const blankRow = () => ({ name: 'water', L: '', solute: '', amount: '', unit: 'g/L' });
const blankForm = (tank) => ({ tank, replaceId: null, date: today(), rows: [blankRow()] });

function knownSolvents() {
  const seen = new Set(SOLVENTS);
  for (const e of state.data.entries) for (const s of e.solvents) seen.add(s.name);
  return [...seen];
}

function renderEntryForm(t) {
  const f = state.form;
  const rows = f.rows.map((r, i) => `
    <div class="srow" data-i="${i}">
      <label class="f solvent"><span>Solvent</span><input list="solvent-list" data-f="name" value="${esc(r.name)}" autocapitalize="off" spellcheck="false" required></label>
      <label class="f vol"><span>Volume (L)</span><input type="number" inputmode="decimal" step="0.001" min="0" data-f="L" value="${esc(r.L)}" placeholder="0.000" required></label>
      <label class="f solute"><span>Solute <em>(optional)</em></span><input data-f="solute" value="${esc(r.solute)}" placeholder="e.g. AgNO3"></label>
      <label class="f amt"><span>Amount</span><input type="number" inputmode="decimal" step="0.001" min="0" data-f="amount" value="${esc(r.amount)}" placeholder="${esc(r.unit)}"></label>
      <label class="f unit"><span>Unit</span><select data-f="unit"><option${r.unit === 'g/L' ? ' selected' : ''}>g/L</option><option${r.unit === 'g' ? ' selected' : ''}>g</option></select></label>
      ${f.rows.length > 1 ? `<button type="button" class="btn tiny danger rm" data-act="rm-row" data-i="${i}" aria-label="Remove solvent">✕</button>` : ''}
      <div class="hint small muted" data-hint="${i}">${concHint(r)}</div>
    </div>`).join('');
  return `
  <section class="card pad form ${f.replaceId ? 'editing' : ''}" id="entry-form">
    ${f.replaceId ? '<div class="note warn small">Editing an entry. <b>Save changes</b> to update it, or <a href="#" data-act="clear-form">cancel</a>.</div>' : ''}
    <form id="ef" autocomplete="off">
      <div class="row">
        <h3>${f.replaceId ? 'Edit entry' : 'Log waste'}</h3><span class="spacer"></span>
        <label class="f inline"><span>Date thrown</span><input type="date" data-top="date" value="${esc(f.date)}" max="${today()}" required></label>
      </div>
      <div id="srows">${rows}</div>
      <datalist id="solvent-list">${knownSolvents().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="preview" class="preview small">${previewHtml(t)}</div>
      <div class="row">
        <button type="button" class="btn" data-act="add-row">＋ Add solvent</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="clear-form">Clear</button>
        <button type="submit" class="btn ${f.replaceId ? 'warn' : 'primary'}">${f.replaceId ? 'Save changes' : 'Log entry'}</button>
      </div>
    </form>
  </section>`;
}

function concHint(r) {
  const amount = num(r.amount); const vol = num(r.L);
  return r.unit === 'g' && amount > 0 && vol > 0 ? `${amount} g in ${vol} L → stored as ${(amount / vol).toFixed(3)} g/L` : '';
}

// The form as solvent lines ready to store (rows without a solvent or volume are skipped).
function formSolvents() {
  const out = [];
  for (const r of state.form.rows) {
    const name = canonSolvent(r.name); const L = num(r.L);
    if (!name || !(L >= 0) || r.L === '') continue;
    const amount = num(r.amount);
    let conc = null;
    if (r.amount !== '' && Number.isFinite(amount)) conc = r.unit === 'g' && L > 0 ? r4(amount / L) : amount;
    out.push({ name, L, solute: r.solute.trim(), conc });
  }
  return out;
}

function previewHtml(t) {
  const sol = formSolvents();
  const newTotal = sol.reduce((a, s) => a + s.L, 0);
  if (!(newTotal > 0)) return '';
  const others = entriesOf(state.data, t.id).filter((e) => e.id !== state.form.replaceId);
  const after = summarize([...others, { solvents: sol }]);
  const overflow = after.total > TANK_MAX_L + EPS;
  const rule = ruleLine(t.type, after.total, after.water);
  const ok = !overflow && (!rule || rule.ok);
  return `<span class="${ok ? 'good' : 'bad'}">After this entry: ${f3(after.total)} / ${TANK_MAX_L} L ${overflow ? '✗ OVERFLOW' : `(+${f3(newTotal)} L)`}${rule ? ` · ${esc(rule.text)}` : ''}</span>`;
}

// ---- Report view
function renderReport(sel) {
  const d = state.data;
  const tanks = [...d.tanks].sort(byTankId);
  const active = tanks.filter((t) => !t.archived);
  // Archived tanks were already collected for treatment, so they aren't in the lab total.
  const grand = summarize(d.entries.filter((e) => active.some((t) => t.id === e.tank)));
  const tank = findTank(d, sel) || tanks[0];
  const tile = ([name, vol], i) => `<div class="tile"><div class="small trunc"><i style="background:${colorOf(name, i)}"></i> ${esc(name)}</div>
    <b>${f3(vol)} L</b><div class="muted tiny-t">${grand.total > 0 ? ((vol / grand.total) * 100).toFixed(1) : 0}%</div></div>`;
  // The biggest few as tiles; the long tail of small volumes in a compact list.
  const ranked = Object.entries(grand.bySolvent);
  const TOP = 8;
  const tiles = ranked.slice(0, TOP).map(tile).join('') + (ranked.length > TOP ? `</div><details class="more"><summary>${ranked.length - TOP} more solvents</summary>
    <table class="tbl"><tbody>${ranked.slice(TOP).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="n">${f3(v)} L</td></tr>`).join('')}</tbody></table></details><div>` : '');

  let detail = '';
  if (tank) {
    const list = entriesOf(d, tank.id);
    const s = summarize(list);
    detail = `
    <div class="row no-print"><span class="spacer"></span>
      <button class="btn small" data-act="word-form" data-tank="${esc(tank.id)}">📄 Word form</button>
      <button class="btn small" data-act="csv" data-tank="${esc(tank.id)}">⇩ CSV</button></div>
    <section class="card">
      <div class="card-head"><h3>Tank ${esc(tank.id)} (${esc(tank.type)})${tank.archived ? ' <span class="badge dark">archived</span>' : ''} — all entries</h3></div>
      ${list.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>Date</th><th>By</th><th>Solvent</th><th class="n">Vol (L)</th><th>Solute</th><th class="n">Conc (g/L)</th></tr></thead>
      ${list.map((e) => `<tbody>${e.solvents.map((x, i) => `<tr>${i === 0 ? `<td rowspan="${e.solvents.length}" class="nowrap"><b>${esc(e.at.slice(0, 10))}</b></td><td rowspan="${e.solvents.length}">${esc(e.by)}</td>` : ''}
        <td>${esc(x.name)}</td><td class="n">${esc(formNum(x.L))}</td><td>${esc(x.solute || '—')}</td><td class="n">${x.conc == null || x.conc === '' ? '—' : esc(formNum(x.conc))}</td></tr>`).join('')}</tbody>`).join('')}
      </table></div>` : '<p class="muted pad small">No entries.</p>'}
    </section>
    <section class="card totals">
      <div class="card-head"><h3>Solvent totals <span class="muted small">(for the online system)</span></h3></div>
      ${Object.keys(s.bySolvent).length ? `<table class="tbl"><thead><tr><th>Solvent</th><th class="n">Total (L)</th></tr></thead><tbody>
        ${Object.entries(s.bySolvent).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="n"><b>${f3(v)}</b></td></tr>`).join('')}
        <tr class="sum"><td><b>Grand total</b></td><td class="n"><b>${f3(s.total)}</b></td></tr></tbody></table>` : '<p class="muted pad small">No data.</p>'}
    </section>`;
  }

  return `
  <div class="row no-print"><h1>Waste report</h1><span class="spacer"></span><button class="btn small" data-act="print">🖨 Print</button></div>
  <section class="card pad">
    <h3>Total solvent — active tanks <span class="muted small">(archived tanks excluded: already collected)</span></h3>
    ${grand.total > 0 ? `<div class="row space"><span class="big">${f3(grand.total)}<span class="muted small"> L total</span></span>
      <span class="muted small">across ${active.length} active tank${active.length === 1 ? '' : 's'}</span></div>
      ${stackBar(grand.bySolvent, grand.total, true)}<div class="tiles">${tiles}</div>` : '<p class="muted small">No entries in active tanks yet.</p>'}
  </section>
  <div class="chips no-print">${tanks.map((t) => `<a class="chip ${tank && t.id === tank.id ? 'on' : ''}" href="#/report/${encodeURIComponent(t.id)}"><b>Tank ${esc(t.id)}</b><span class="badge${t.archived ? ' dark' : ''}">${esc(t.type)}</span></a>`).join('')}</div>
  ${detail}`;
}

// ---- Feedback view
function renderFeedback() {
  const list = [...state.data.feedback].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  return `
  <h1>Feedback</h1>
  <section class="card pad">
    <p class="small muted" style="margin-top:0">Found a bug or have a suggestion? Feedback is anonymous: no name is saved with it.</p>
    <form id="fb-form"><textarea name="text" rows="3" placeholder="Your feedback… (日本語でも大丈夫です)" required></textarea>
      <div class="row"><span class="spacer"></span><button class="btn primary" type="submit">Submit</button></div></form>
  </section>
  <h3 class="muted small">Previous feedback</h3>
  ${list.length ? `<div class="card list">${list.map((c) => `<div class="li col"><span class="muted small">${esc(c.at.slice(0, 16))}</span><div class="pre">${esc(c.text)}</div></div>`).join('')}</div>` : '<p class="muted small">No feedback yet.</p>'}`;
}

// ---------------------------------------------------------------- wiring after render
function afterRender(r) {
  const ef = $('#ef');
  if (ef) {
    const t = findTank(state.data, state.form.tank);
    ef.addEventListener('input', (e) => syncForm(e.target, t));
    ef.addEventListener('change', (e) => syncForm(e.target, t));
    ef.addEventListener('submit', (e) => { e.preventDefault(); submitEntry(); });
  }
  const fb = $('#fb-form');
  if (fb) {
    fb.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = fb.text.value.trim();
      if (!text) return;
      try {
        await mutate('Waste feedback', (d) => { d.feedback.push({ id: nextId(d.feedback), text, at: jstNow() }); }, { anonymous: true });
        toast('Thanks! Feedback saved ✓');
      } catch (err) { if (err.message) toast(err.message, 7000); }
    });
  }
  document.title = r.view === 'report' ? 'Waste Report' : r.view === 'feedback' ? 'Feedback · Lab Waste' : 'Lab Waste Tracker';
}

function syncForm(el, t) {
  if (el.dataset.top === 'date') { state.form.date = el.value; return; }
  const row = el.closest('.srow'); const f = el.dataset.f;
  if (!row || !f) return;
  const i = Number(row.dataset.i);
  state.form.rows[i][f] = el.value;
  if (f === 'unit') { const a = $('[data-f="amount"]', row); if (a) a.placeholder = el.value; }
  const hint = $(`[data-hint="${i}"]`); if (hint) hint.textContent = concHint(state.form.rows[i]);
  $('#preview').innerHTML = previewHtml(t);
}

async function submitEntry() {
  const f = state.form; const tankId = f.tank;
  const solvents = formSolvents();
  if (!solvents.length) { toast('Enter at least one solvent with its volume.'); return; }
  if (!(f.date <= today())) { toast('The date cannot be in the future.'); return; }
  const localErr = checkEntry(state.data, tankId, solvents, f.replaceId);
  if (localErr) { alert(`Entry rejected:\n${localErr}`); return; }
  const by = state.name;
  const editing = f.replaceId;
  try {
    const result = await mutate(`${editing ? 'Edit' : 'Log'} waste: tank ${tankId}`, (d) => {
      // Checked again on the latest data: someone may have filled the tank meanwhile.
      const err = checkEntry(d, tankId, solvents, editing);
      if (err) throw new UserError(`Entry rejected:\n${err}`);
      const before = tankSummary(d, tankId).total - (editing ? summarize(d.entries.filter((e) => e.id === editing)).total : 0);
      if (editing) {
        const e = d.entries.find((x) => x.id === editing);
        if (!e) throw new UserError('That entry was deleted by someone else.');
        if (e.at.slice(0, 10) !== f.date) e.at = stampFor(f.date);
        e.solvents = solvents; e.editedBy = by;
      } else {
        d.entries.push({ id: nextId(d.entries), tank: tankId, by, at: stampFor(f.date), solvents });
      }
      return { before, after: tankSummary(d, tankId).total };
    });
    state.form = blankForm(tankId);
    render();
    if (result.before <= ALERT_THRESHOLD_L && result.after > ALERT_THRESHOLD_L) {
      toast(`⚠️ Tank ${tankId} is almost full: ${f3(result.after)} / ${TANK_MAX_L} L. Time to arrange a pickup.`, 8000);
    } else toast(editing ? 'Entry updated ✓' : 'Logged ✓');
  } catch (e) {
    if (e.message.startsWith('Entry rejected')) alert(e.message);
    else if (e.message) toast(e.message, 7000);
  }
}

// ---------------------------------------------------------------- actions
const entryById = (id) => state.data.entries.find((e) => e.id === Number(id));
const toFormRows = (e) => e.solvents.map((s) => ({ name: s.name, L: String(s.L), solute: s.solute || '', amount: s.conc == null ? '' : String(s.conc), unit: 'g/L' }));
const scrollToForm = () => $('#entry-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const actions = {
  reload() { load(); },
  signin() { openSignIn(); },
  account() { openAccount(); },
  print() { window.print(); },
  'show-all'(el) { state.showAll[el.dataset.tank] = true; render(); },
  'add-row'() { state.form.rows.push(blankRow()); render(); $$('#srows .srow').at(-1)?.querySelector('[data-f="name"]')?.focus(); },
  'rm-row'(el) { state.form.rows.splice(Number(el.dataset.i), 1); render(); },
  'clear-form'() { state.form = blankForm(state.form.tank); render(); },
  'copy-entry'(el) {
    const e = entryById(el.dataset.id);
    state.form = { tank: e.tank, replaceId: null, date: today(), rows: toFormRows(e) }; // a copy is a new pour
    render(); scrollToForm();
  },
  'edit-entry'(el) {
    const e = entryById(el.dataset.id);
    state.form = { tank: e.tank, replaceId: e.id, date: e.at.slice(0, 10), rows: toFormRows(e) };
    render(); scrollToForm();
  },
  async 'del-entry'(el) {
    const e = entryById(el.dataset.id);
    const desc = e.solvents.map((s) => `${s.name} ${formNum(s.L)} L`).join(', ');
    if (!confirm(`Delete this entry?\n\n${e.at.slice(0, 10)} · ${e.by}\n${desc}`)) return;
    try {
      await mutate(`Delete waste entry #${e.id}: tank ${e.tank}`, (d) => { d.entries = d.entries.filter((x) => x.id !== e.id); });
      if (state.form?.replaceId === e.id) state.form = blankForm(e.tank);
      render(); toast('Entry deleted');
    } catch (err) { if (err.message) toast(err.message, 7000); }
  },
  async unarchive(el) {
    const id = el.dataset.tank;
    try {
      await mutate(`Unarchive tank ${id}`, (d) => { const t = findTank(d, id); if (t) t.archived = false; });
      go(`#/t/${encodeURIComponent(id)}`); toast(`Tank ${id} is back in use`);
    } catch (err) { if (err.message) toast(err.message, 7000); }
  },
  'add-tank'() { openAddTank(); },
  'tank-settings'(el) { openTankSettings(el.dataset.tank); },
  'word-form'(el) { openWordForm(el.dataset.tank); },
  csv(el) { exportCsv(el.dataset.tank); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el);
});

// ---------------------------------------------------------------- dialogs
function openModal({ title, body, footer = '', onMount }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop" data-close></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost small" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div>`;
  document.body.classList.add('modal-open');
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  const m = $('.modal', root);
  onMount?.(m);
  ($('input:not([type=hidden]), textarea, select', m))?.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; document.body.classList.remove('modal-open'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

const typeOptions = (sel) => WASTE_TYPES.map((w) => `<option${w === sel ? ' selected' : ''}>${esc(w)}</option>`).join('');
const padId = (v) => String(v).trim().padStart(2, '0');

function guardedSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', form.closest('.modal')) || $('[type=submit]', form);
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { if (err.message) toast(err.message, 7000); } finally { if (btn) btn.disabled = false; }
  });
}

function openAddTank() {
  if (!state.auth.token) { openSignIn('Sign in to add a tank.'); return; }
  openModal({
    title: 'Add tank',
    body: `<form id="at-form" class="stack">
      <div class="grid2">
        <label class="f"><span>Tank number</span><input type="number" name="id" min="1" max="99" placeholder="01" required></label>
        <label class="f"><span>Waste type</span><select name="type">${typeOptions('k')}</select></label>
      </div></form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="at-form">Add tank</button>',
    onMount(m) {
      const form = $('#at-form', m);
      guardedSubmit(form, async () => {
        const id = padId(form.id.value); const type = form.type.value;
        await mutate(`Add tank ${id} (${type})`, (d) => {
          if (findTank(d, id)) throw new UserError(`Tank ${id} already exists.`);
          d.tanks.push({ id, type, archived: false });
        });
        closeModal(); go(`#/t/${encodeURIComponent(id)}`); toast(`Tank ${id} added ✓`);
      });
    },
  });
}

function confirmField(word) {
  return `<label class="f"><span>Type <code>${word}</code> to confirm</span><input name="confirm" autocomplete="off" autocapitalize="off" data-word="${word}"></label>`;
}

function openTankSettings(id) {
  if (!state.auth.token) { openSignIn('Sign in to change tank settings.'); return; }
  const t = findTank(state.data, id);
  openModal({
    title: `Tank ${id} settings`,
    body: `
      <div class="seg-tabs" role="tablist"><button class="on" data-pane="archive">Archive</button><button data-pane="rename">Rename</button><button data-pane="delete" class="danger-t">Delete</button></div>
      <form class="pane" data-pane="archive">
        <p class="small muted">Archive the tank once it has been picked up for treatment. It disappears from the main view and the lab total, but all its data is kept and it can be unarchived later.</p>
        ${confirmField('archive')}<button class="btn warn" type="submit" disabled>Archive tank</button></form>
      <form class="pane hidden" data-pane="rename">
        <p class="small muted">Fix the tank number or waste type if it was created wrong.</p>
        <div class="grid2"><label class="f"><span>Number</span><input type="number" name="id" min="1" max="99" value="${esc(Number(t.id))}" required></label>
        <label class="f"><span>Waste type</span><select name="type">${typeOptions(t.type)}</select></label></div>
        ${confirmField('rename')}<button class="btn warn" type="submit" disabled>Rename tank</button></form>
      <form class="pane hidden" data-pane="delete">
        <p class="small bad">This permanently deletes the tank and every entry logged in it. Use Archive instead if the tank just needs to leave the main view. (An admin can still recover it from the GitHub history.)</p>
        ${confirmField('delete')}<button class="btn danger" type="submit" disabled>Delete tank</button></form>`,
    onMount(m) {
      $$('.seg-tabs button', m).forEach((b) => b.addEventListener('click', () => {
        $$('.seg-tabs button', m).forEach((x) => x.classList.toggle('on', x === b));
        $$('.pane', m).forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.pane));
      }));
      $$('.pane', m).forEach((form) => {
        const input = $('[name=confirm]', form); const btn = $('[type=submit]', form);
        input.addEventListener('input', () => { btn.disabled = input.value.trim() !== input.dataset.word; });
      });
      guardedSubmit($('[data-pane=archive].pane', m), async () => {
        await mutate(`Archive tank ${id}`, (d) => { const x = findTank(d, id); if (x) x.archived = true; });
        closeModal(); go('#/'); toast(`Tank ${id} archived`);
      });
      const rn = $('[data-pane=rename].pane', m);
      guardedSubmit(rn, async () => {
        const newId = padId(rn.id.value); const type = rn.type.value;
        await mutate(`Rename tank ${id} → ${newId} (${type})`, (d) => {
          const x = findTank(d, id);
          if (!x) throw new UserError(`Tank ${id} no longer exists.`);
          if (newId !== id && findTank(d, newId)) throw new UserError(`Tank ${newId} already exists.`);
          x.id = newId; x.type = type;
          for (const e of d.entries) if (e.tank === id) e.tank = newId;
        });
        closeModal(); go(`#/t/${encodeURIComponent(newId)}`); toast('Tank updated ✓');
      });
      guardedSubmit($('[data-pane=delete].pane', m), async () => {
        await mutate(`Delete tank ${id}`, (d) => {
          d.tanks = d.tanks.filter((x) => x.id !== id);
          d.entries = d.entries.filter((e) => e.tank !== id);
        });
        closeModal(); go('#/'); toast(`Tank ${id} deleted`);
      });
    },
  });
}

let jszipPromise = null;
function loadJSZip() {
  jszipPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error('Could not load the Word file builder. Check your connection.')); };
    document.head.appendChild(s);
  });
  return jszipPromise;
}

function openWordForm(id) {
  const t = findTank(state.data, id);
  const entries = entriesOf(state.data, id);
  const lines = entries.reduce((a, e) => a + e.solvents.length, 0);
  const supported = !!FORM_TEMPLATES[t.type];
  openModal({
    title: `Word form · Tank ${id}`,
    body: supported ? `<form id="wf-form" class="stack">
      <p class="small muted" style="margin-top:0">様式2の2 for <b>${esc(t.type)}</b>, ${lines} line${lines === 1 ? '' : 's'}. These go in the form header; leave any blank to fill in by hand after printing.</p>
      <label class="f"><span>搬入月日 <em>(delivery date)</em></span><input type="date" name="date" value="${today()}"></label>
      <label class="f"><span>搬入者名 <em>(deliverer)</em></span><input name="name" value="${esc(state.name || '')}"></label>
      <label class="f"><span>容器番号 <em>(container number)</em></span><input name="container" placeholder="e.g. 15840517" autocomplete="off"></label>
      ${lines > FORM_ROWS ? `<p class="note warn small">This tank has ${lines} lines but one sheet holds ${FORM_ROWS}, so the table will run onto a second page.</p>` : ''}
    </form>` : `<p>No 様式2の2 template exists for waste type <b>${esc(t.type)}</b>.</p>
      <p class="small muted">Each template has the 貯留区分 circle drawn over its own waste type, so a form can only be made for a type that has one. Available: <b>${Object.keys(FORM_TEMPLATES).join('</b>, <b>')}</b>.</p>`,
    footer: supported ? '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="wf-form">⇩ Download Word file</button>' : '<button class="btn" data-close>Close</button>',
    onMount(m) {
      const form = $('#wf-form', m);
      if (!form) return;
      guardedSubmit(form, async () => {
        const [JSZip, tpl] = await Promise.all([
          loadJSZip(),
          fetch(FORM_TEMPLATES[t.type]).then((r) => { if (!r.ok) throw new Error(`Template not found (HTTP ${r.status})`); return r.arrayBuffer(); }),
        ]);
        const bytes = await buildFormDocx(JSZip, tpl, entries, { date: form.date.value, name: form.name.value.trim(), container: form.container.value.trim() });
        download(`waste_form_tank_${id}.docx`, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
        closeModal();
      });
    },
  });
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast(`Downloaded ${name}`);
}

function exportCsv(id) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Date', 'User', 'Group', 'Solvent', 'Solvent (L)', 'Solute', 'Solute (g/L)']];
  for (const e of entriesOf(state.data, id)) {
    for (const s of e.solvents) rows.push([e.at.slice(0, 10), e.by, e.id, s.name, s.L, s.solute || '', s.conc || '']);
  }
  // BOM so Excel opens Japanese names correctly.
  download(`tank_${id}_log.csv`, new Blob([`﻿${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
}

// ---------------------------------------------------------------- sign-in
// The whole lab shares one token that the admin makes and hands out, so GitHub
// sees every change as the admin. Who did what is the name each person enters,
// which goes on their entries and in the commit message.

// "#/join/<token>" lets the admin send a single link instead of a pasted token.
// The part after # never leaves the browser, so the token isn't sent to GitHub Pages.
function takeJoinLink() {
  const m = location.hash.match(/^#\/join\/([^/?#]+)/);
  if (!m) return '';
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  return decodeURIComponent(m[1]);
}
const joinLink = () => `${location.origin}${location.pathname}#/join/${encodeURIComponent(state.auth.token)}`;

function openSignIn(note = '', token = state.auth.token) {
  openModal({
    title: 'Sign in',
    body: `<form id="si-form" autocomplete="off" class="stack">
      ${note ? `<p class="note info small">${esc(note)}</p>` : ''}
      <label class="f"><span>Your name (投入者氏名)</span><input name="name" value="${esc(state.name)}" placeholder="e.g. Purin or 後藤 照希" required></label>
      <p class="small muted" style="margin-top:4px">Written on your entries and on the Word form, so use the name the lab expects.</p>
      <label class="f"><span>Lab access token</span><input type="password" name="token" value="${esc(token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false" required></label>
      <p class="small muted">Ask the lab admin for the token or the sign-in link. Keep it inside the lab: don't post it anywhere public. It is saved only in this browser and only sent to <code>api.github.com</code>.</p>
    </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" type="submit" form="si-form">Sign in</button>',
    onMount(m) {
      const form = $('#si-form', m);
      guardedSubmit(form, async () => {
        const token = form.token.value.trim(); const name = form.name.value.trim();
        state.auth = { token }; // ghGet below uses it
        try {
          const { data, sha } = await ghGet();
          Object.assign(state, { data, sha, source: 'api', loadError: '' });
        } catch (e) {
          state.auth = { token: '' };
          throw new UserError(e.status === 401 ? 'GitHub did not accept that token. It may have expired: ask the admin for the current one.'
            : e.status === 403 || e.status === 404 ? `That token has no access to ${SITE.owner}/${SITE.repo}.` : `Sign-in failed: ${e.message}`);
        }
        store.set(KEY.auth, state.auth);
        state.name = name; store.set(KEY.name, name);
        closeModal(); render();
        toast(`Signed in as ${name} ✓`);
      });
    },
  });
}

function openAccount() {
  openModal({
    title: 'Account',
    body: `<form id="acc-form" class="stack">
      <label class="f"><span>Your name on entries (投入者氏名)</span><input name="name" value="${esc(state.name)}" required></label>
      <p class="small muted">Printed in the Word form, so use the name the lab expects (e.g. 後藤 照希 or Purin).</p>
      <details class="help"><summary>Invite a lab member</summary>
        <p class="small">Send them this sign-in link privately (LINE, Slack, email). Opening it fills in the lab token; they only type their name.</p>
        <button class="btn small" type="button" data-act="copy-join">Copy sign-in link</button>
      </details>
    </form>`,
    footer: '<button class="btn danger" data-act="signout" type="button">Sign out on this device</button><span class="spacer"></span><button class="btn primary" type="submit" form="acc-form">Save</button>',
    onMount(m) {
      const form = $('#acc-form', m);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        state.name = form.name.value.trim(); store.set(KEY.name, state.name);
        closeModal(); render(); toast('Saved ✓');
      });
    },
  });
}
actions['copy-join'] = async () => {
  try { await navigator.clipboard.writeText(joinLink()); toast('Sign-in link copied. Share it only with lab members.', 4000); }
  catch { prompt('Copy this sign-in link:', joinLink()); }
};
actions.signout = () => {
  if (!confirm('Sign out on this device?')) return;
  state.auth = { token: '' };
  store.del(KEY.auth);
  closeModal(); load({ quiet: true });
};

// ---------------------------------------------------------------- toast + boot
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

window.addEventListener('hashchange', () => {
  const t = takeJoinLink();
  if (t) { render(); openSignIn('Welcome! Enter your name to finish signing in.', t); return; }
  window.scrollTo(0, 0); render();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.data && !state.busy) load({ quiet: true }); });
$('#refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.classList.add('spin');
  try { await load(); } finally { btn.classList.remove('spin'); }
});
const joinToken = takeJoinLink();
load({ quiet: true });
if (joinToken) openSignIn('Welcome! Enter your name to finish signing in.', joinToken);
