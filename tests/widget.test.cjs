const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { head, body, source } = require('./widget-source.cjs');
test('Goja template produces executable browser JavaScript', () => {
  new vm.Script(source);
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [, script] of scripts) new vm.Script(script);
  assert.equal(source.slice(source.indexOf('const WIDGET_BODY_HTML'), source.indexOf('\nfunction load()')).includes('\\'), false);
});
test('all widget CSS rules are scoped, including media rules', () => {
  const css = head.replace(/<[^>]+>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (selector.startsWith('@') || /^(from|to|\d+%)$/.test(selector)) continue;
    for (const part of selector.split(',')) assert.ok(part.trim().startsWith('#nf-floating-widget'), part);
  }
});
