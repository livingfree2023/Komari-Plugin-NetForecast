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

const forecastHistory = [
  { date: '2026-11-11', in_bytes: 5000, out_bytes: 5000 },
  { date: '2026-11-09', in_bytes: 7000, out_bytes: 7000 },
  { date: '2026-11-06', in_bytes: 12, out_bytes: 8 },
  { date: '2026-11-07', in_bytes: 30, out_bytes: 12 },
  { date: '2026-11-09', in_bytes: 5, out_bytes: 20, is_today: true },
  { date: '2026-11-10', in_bytes: 4, out_bytes: 3, timestamp: now.getTime() + 8 * 3600_000 },
];
const forecastNode = {
  uuid: 'sample',
  expired_at: '2026-12-07',
  traffic_limit: 5000,
  net_total_down: 10000,
  net_total_up: 20000,
};

for (const [mode, expected] of Object.entries({ sum: 74, upload: 35, download: 39, max: 39, min: 35 })) {
  test(`${mode}: plan usage, actual chart and warning share the billing cycle`, () => {
    const result = context.calculateNodeForecast(forecastHistory, { ...forecastNode, traffic_limit_type: mode }, 90, now, 8);
    const today = result.chart_series.find(point => point.is_today);
    assert.equal(result.cycle.cycleStart, '2026-11-07');
    assert.equal(result.cumulative.billable_bytes, expected);
    assert.equal(result.chart_series[0].cumulative_billable, context.computeBillableAmount(30, 12, mode));
    assert.equal(today.cumulative_billable, expected);
    assert.deepEqual([today.in_bytes, today.out_bytes], [4, 3]);
    assert.equal(result.chart_series.at(-1).cumulative_billable, result.projected.billable_bytes);
    assert.deepEqual([result.daily_avg.in_bytes, result.daily_avg.out_bytes], [15, 14]);
    assert.equal(result.status, 'SAFE');
    assert.equal(result.exhaustion_date, undefined);
  });
}

test('a raw counter without baseline samples cannot create billing usage', () => {
  const result = context.calculateNodeForecast([], forecastNode, 90, now, 8);
  assert.equal(result.cumulative.billable_bytes, 0);
  assert.equal(result.projected.billable_bytes, 0);
  assert.equal(result.chart_series.find(point => point.is_today).total_bytes, 0);
});

test('TypeScript source and deployed script produce identical cycle series', () => {
  const ts = require('typescript');
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/forecast.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const typed = { exports: {} };
  vm.runInNewContext(compiled, typed);
  const history = [row('2026-10-30', 90), ...visible];
  const args = [history, 'sum', cycle, 1, 1, 60, 30, 30, now, 8];
  assert.equal(JSON.stringify(typed.exports.buildCycleSeries(...args)), JSON.stringify(context.buildCycleSeries(...args)));

  const forecastArgs = [forecastHistory, forecastNode, 90, now, 8];
  const deployed = context.calculateNodeForecast(...forecastArgs);
  const reference = typed.exports.calculateNodeForecast(...forecastArgs);
  for (const field of ['cumulative', 'daily_avg', 'projected', 'status', 'chart_series']) {
    assert.equal(JSON.stringify(reference[field]), JSON.stringify(deployed[field]), field);
  }
});

for (const page of ['admin', 'public']) {
  test(`${page}: a live counter needs a baseline, and today's increment survives a counter reset`, () => {
    const html = fs.readFileSync(path.join(__dirname, `../pages/${page}.html`), 'utf8');
    const start = html.indexOf('function readNetworkCounter(');
    const end = html.indexOf('\n    }\n', html.indexOf('return result;', start)) + '\n    }'.length;
    const { aggregateDailyFromRecords, readNetworkCounter } = vm.runInNewContext(
      html.slice(start, end) + '\n({ aggregateDailyFromRecords, readNetworkCounter });'
    );
    assert.equal(readNetworkCounter(null), null);
    assert.equal(readNetworkCounter(0, 50), 0);

    const cold = aggregateDailyFromRecords([], 1000, 2000, now, 8).at(-1);
    assert.equal(cold.total_bytes, 0);
    const data = [
      { time: '2026-11-09T15:00:00Z', net_total_up: 100, net_total_down: 200 },
      { time: '2026-11-09T17:00:00Z', net_total_up: 125, net_total_down: 230 },
      { time: '2026-11-10T02:00:00Z', net_total_up: 2, net_total_down: 3 },
    ];
    const today = aggregateDailyFromRecords(data, 4, 8, now, 8).at(-1);
    assert.equal(today.date, '2026-11-10');
    assert.equal(today.timestamp, now.getTime());
    assert.deepEqual([today.in_bytes, today.out_bytes], [38, 29]);
    const reset = { ...data[2], net_total_up: 0, net_total_down: 0 };
    const zeroBaseline = aggregateDailyFromRecords([...data.slice(0, 2), reset], 4, 8, now, 8).at(-1);
    assert.deepEqual([zeroBaseline.in_bytes, zeroBaseline.out_bytes], [38, 29]);
  });
}

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
