#!/usr/bin/env node
// mmx-debug.mjs — paste a MiniMax API response to see what cc-hud would print
// Usage:
//   1. Get a real API response:
//        curl -sH "Authorization: Bearer $TOKEN" https://api.minimaxi.com/v1/token_plan/remains > resp.json
//   2. ./scripts/mmx-debug.mjs < resp.json
//      or ./scripts/mmx-debug.mjs '<your json>'
//
// Shows the output of cc-hud's current aggregation logic (Token Plan Plus: sum usage / max total)

const args = process.argv.slice(2);
let jsonInput = '';

for (const arg of args) {
  if (!arg.startsWith('--')) jsonInput += arg + ' ';
}

if (!jsonInput.trim()) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk.toString());
  jsonInput = chunks.join('');
}

if (!jsonInput.trim()) {
  console.error('Usage: mmx-debug.mjs [json | < response.json]');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(jsonInput);
} catch (e) {
  console.error('JSON parse failed:', e.message);
  process.exit(1);
}

const remains = data.model_remains ?? [];

console.log('\n┌─ API response overview ───────────────────────┐');
console.log(`│  model_remains count: ${remains.length}`);
console.log('└────────────────────────────────────────────────┘\n');

if (remains.length === 0) {
  console.log('❌ model_remains is an empty array — cc-hud will show no rate-limit data');
  process.exit(0);
}

// Mirror src/mmx.ts aggregatePlan logic
// API populates *_remaining_percent with the real value; *_usage_count is 0.
function aggregatePlan(remains) {
  if (remains.length === 0) return null;
  const active = remains.find(m => m.current_interval_status === 1) ?? remains[0];
  const now = Date.now();
  const quota = {
    fiveHourUsedPct: Math.max(0, 100 - active.current_interval_remaining_percent),
    fiveHourResetsAt: now + active.remains_time,
    sevenDayUsedPct: Math.max(0, 100 - active.current_weekly_remaining_percent),
    sevenDayResetsAt: now + active.weekly_remains_time,
  };
  return Object.values(quota).every(Number.isFinite) ? quota : null;
}

// Print a summary of each record
console.log('Records:');
remains.forEach((m, i) => {
  const status = m.current_interval_status;
  const active = status === 1 ? '✓ active' : '○ inactive';
  const fiveHrRemH = (m.remains_time / 3600000).toFixed(1);
  const weeklyRemD = (m.weekly_remains_time / 86400000).toFixed(1);
  console.log(`  [${i}] ${m.model_name}  (${active})`);
  console.log(`      5h remaining: ${m.current_interval_remaining_percent}%  → used: ${100 - m.current_interval_remaining_percent}%  (${fiveHrRemH}h left)`);
  console.log(`      7d remaining: ${m.current_weekly_remaining_percent}%  → used: ${100 - m.current_weekly_remaining_percent}%  (${weeklyRemD}d left)`);
});

const q = aggregatePlan(remains);
if (!q) {
  console.log('\n❌ aggregatePlan returned null — cc-hud shows no rate-limit data');
  process.exit(0);
}

const fiveHrRemH = ((q.fiveHourResetsAt - Date.now()) / 3600000).toFixed(1);
const weeklyRemD = ((q.sevenDayResetsAt - Date.now()) / 86400000).toFixed(1);

console.log('\n┌─ cc-hud aggregatePlan output (Token Plan Plus) ┐');
console.log(`│  5h: ${q.fiveHourUsedPct}%  (${fiveHrRemH}h until reset)`);
console.log(`│  7d: ${q.sevenDayUsedPct}%  (${weeklyRemD}d until reset)`);
console.log('│  Algorithm: pick status=1 entry, used% = 100 - remaining_percent');
console.log('│  (general = active plan quota, video/etc = inactive)');
console.log('└────────────────────────────────────────────────┘\n');

console.log('💡 Compare against your dashboard:');
console.log('   - if the 5h % matches the dashboard → the fix is right');
console.log('   - if it does not match → probably per-model quotas (not the Plus plan); compare against older versions');
