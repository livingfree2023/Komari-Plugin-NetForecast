const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = { require: () => ({}), module: { exports: {} } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8'), context);
const now = new Date('2026-11-10T04:00:00Z');
const cycle = context.calculateBillingCycle(7, now, 8);
const row = (date, n) => ({ date, in_bytes: n, out_bytes: n, total_bytes: n * 2 });
const visible = [row('2026-11-07', 3), row('2026-11-08', 2), row('2026-11-09', 1), row('2026-11-10', 0.5)];

for (const mode of ['sum', 'upload', 'download', 'max', 'min']) {
  test(`${mode}: previous cycle, future and overwritten records cannot change the cycle line`, () => {
    const billable = context.computeBillableAmount(30, 30, mode);
    const build = history => context.buildCycleSeries(history, mode, cycle, 1, 1, billable, 30, 30, now, 8);
    const clean = build(visible);
    const contaminated = build([row('2026-10-30', 90), row('2026-11-07', 200), ...visible, row('2026-11-11', 100)]);
    assert.deepEqual(contaminated, clean);
    const todayIndex = clean.findIndex(point => point.is_today);
    assert.equal(clean[todayIndex].cumulative_billable, billable);
    assert.equal(clean[todayIndex].in_bytes, 0.5);
    assert.equal(clean[todayIndex].out_bytes, 0.5);
    const increment = context.computeBillableAmount(6.5, 6.5, mode) - context.computeBillableAmount(6, 6, mode);
    assert.equal(clean[todayIndex].cumulative_billable - clean[todayIndex - 1].cumulative_billable, increment);
  });
}

test('cold start keeps bars empty while anchoring current cumulative', () => {
  const series = context.buildCycleSeries([], 'sum', cycle, 1, 1, 60, 30, 30, now, 8);
  const today = series.find(point => point.is_today);
  assert.equal(today.cumulative_billable, 60);
  assert.equal(today.total_bytes, 0);
  assert.ok(series.filter(point => !point.is_today && !point.is_forecast).every(point => point.cumulative_billable === null));
});


test('TypeScript source and deployed script produce identical cycle series', () => {
  const ts = require('typescript');
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/forecast.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const typed = { exports: {} };
  vm.runInNewContext(compiled, typed);
  const history = [row('2026-10-30', 90), ...visible];
  const args = [history, 'sum', cycle, 1, 1, 60, 30, 30, now, 8];
  assert.equal(JSON.stringify(typed.exports.buildCycleSeries(...args)), JSON.stringify(context.buildCycleSeries(...args)));
});


for (const date of ['2026-11-07T00:00:00Z', '2026-11-10T04:00:00Z', '2026-12-06T12:00:00Z']) {
  test(`reset boundary does not add an extra forecast day: ${date}`, () => {
    const time = new Date(date);
    const billingCycle = context.calculateBillingCycle(7, time, 8);
    const points = context.buildCycleSeries([], 'sum', billingCycle, 2, 3, 60, 30, 30, time, 8);
    const today = points.find(point => point.is_today);
    assert.equal(today.cumulative_billable, 60);
    assert.equal(points.at(-1).cumulative_billable, 60 + 5 * billingCycle.daysRemaining);
    assert.ok(points.filter(point => point.is_forecast).every(point => point.total_bytes === 0));
  });
}
