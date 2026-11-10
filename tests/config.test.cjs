const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');

async function boot(config) {
  const routes = new Map();
  const crons = [];
  const injections = [];
  const server = {
    getConfig: async () => { await new Promise(resolve => setImmediate(resolve)); if (config instanceof Error) throw config; return config; },
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    cron: (expr, handler) => crons.push({ expr, handler }),
    injectHTML: (...args) => injections.push(args),
    registerRPC() {},
  };
  const context = { require: name => { if (name === 'server') return server; throw Error('No filesystem in test'); }, console, module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.module.exports.load();
  return { context, routes, crons, injections };
}

test('delayed host config controls cron, widget and overview reset day including UTC zero', async () => {
  const config = { default_reset_day: 22, warning_threshold: 75, timezone_offset: 0, enable_floating_widget: false, auto_collect_cron: '*/7 * * * *' };
  const app = await boot(config);
  let settings;
  await app.routes.get('GET /api/plugin/net-forecast/config')({}, { setHeader() {}, end: body => { settings = JSON.parse(body); } });
  assert.deepEqual(settings.config, config);
  assert.equal(app.crons[0].expr, '*/7 * * * *');
  assert.equal(app.injections.length, 0);
  let result;
  await app.routes.get('POST /api/plugin/net-forecast/overview')({ body: JSON.stringify({ clients: [{ uuid: 'test', name: 'test', traffic_limit: 1000 }] }) }, {
    setHeader() {}, end: body => { result = JSON.parse(body); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.timezone_offset, 0);
  assert.equal(result.nodes[0].traffic_reset_day, 22);
  assert.match(result.nodes[0].reset_day_desc, /22/);
  const forecast = app.context.calculateNodeForecast;
  assert.equal(forecast([], { uuid: 'test', traffic_reset_day: 12 }, 75, new Date(), 0, 22).traffic_reset_day, 12);
  assert.equal(forecast([], { uuid: 'test', traffic_reset_day: 12, expired_at: '2027-10-18' }, 75, new Date(), 0, 22).traffic_reset_day, 18);
});

test('empty host config retains documented defaults', async () => {
  const app = await boot({});
  assert.equal(app.crons[0].expr, '*/10 * * * *');
  assert.equal(app.injections.length, 1);
});


test('host config rejection fails initialization instead of silently using defaults', async () => {
  await assert.rejects(boot(new Error('configuration unavailable')), /configuration unavailable/);
});
