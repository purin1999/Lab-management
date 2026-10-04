// Compares waste/data.json before and after a push and posts a Discord message
// for every tank that went past the alert threshold. Run by .github/workflows/waste-alert.yml.
import { execFileSync } from 'node:child_process';

const TANK_MAX_L = 10.0;
const ALERT_THRESHOLD_L = 9.0;
const FILE = 'waste/data.json';

function read(rev) {
  try { return JSON.parse(execFileSync('git', ['show', `${rev}:${FILE}`], { encoding: 'utf8' })); } catch { return null; }
}
function totals(data) {
  const out = {};
  for (const e of data?.entries || []) out[e.tank] = (out[e.tank] || 0) + e.solvents.reduce((a, s) => a + s.L, 0);
  return out;
}

const before = process.env.BEFORE && !/^0+$/.test(process.env.BEFORE) ? read(process.env.BEFORE) : null;
const after = read('HEAD');
if (!before || !after) { console.log('Nothing to compare.'); process.exit(0); }

const was = totals(before); const now = totals(after);
const alerts = after.tanks
  .filter((t) => !t.archived && (was[t.id] || 0) <= ALERT_THRESHOLD_L && (now[t.id] || 0) > ALERT_THRESHOLD_L)
  .map((t) => `⚠️ Tank ${t.id} (${t.type}) is almost full: ${now[t.id].toFixed(3)} / ${TANK_MAX_L} L`);

if (!alerts.length) { console.log('No tank crossed the threshold.'); process.exit(0); }
console.log(alerts.join('\n'));
if (!process.env.DISCORD_WEBHOOK) { console.log('::warning::DISCORD_WEBHOOK secret is not set, so no message was sent.'); process.exit(0); }

const res = await fetch(process.env.DISCORD_WEBHOOK, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: alerts.join('\n') }),
});
console.log(`Discord: HTTP ${res.status}`);
if (!res.ok) process.exit(1);
