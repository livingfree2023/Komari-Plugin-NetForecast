// Deterministic host/overview fixtures for browser checks only; never packaged into the plugin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const { head, body } = require('./widget-source.cjs');
const out = process.env.NF_TEST_OUTPUT || 'test-results';
const data = { ok: true, summary: { safe_count: 1, warning_count: 1, no_quota_count: 1 }, nodes: [
  { node_id: 'a', node_name: 'LAX.HDZ', status: 'SAFE', has_quota: true, traffic_limit_bytes: 1024 ** 4, traffic_reset_day: 4, usage_ratio: 0.4, cumulative: { billable_bytes: 1024 ** 3 }, cycle: { daysRemaining: 13 } },
  { node_id: 'b', node_name: 'Warning node', status: 'WARNING', has_quota: true, traffic_limit_bytes: 1024 ** 4, usage_ratio: 0.95 },
  { node_id: 'c', node_name: 'Uncapped', status: 'NO_QUOTA', has_quota: false }
] };
function fixture(kind = 'blue') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * {box-sizing:border-box} html,body {margin:0;min-height:100%;font-family:monospace;font-size:16px;color:#15324f;background:#eef4fb}
  #app {min-height:100vh;padding:24px;background-color:#e8f0f8;background-image:linear-gradient(45deg,#e8f0f8aa,#c6d9ecaa);color:#15324f}
  main {min-height:90vh} .grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  .server-card {min-height:130px;padding:18px;background:#fff;background-image:linear-gradient(120deg,#ffffffcc,#ddebfacc);border:2px dashed #8ea6bd;border-radius:7px 15px;box-shadow:2px 3px 8px #284e6a33;color:#15324f}
  main a, main button {color:#174cba} .host-picker {display:block;margin:0 0 16px;padding:8px;font:inherit}
  [data-theme=dark] #app, #app[data-theme=dark] {background-color:#163d70;background-image:linear-gradient(90deg,#ffffff08 1px,transparent 1px),linear-gradient(#ffffff08 1px,transparent 1px);background-size:12px 12px;color:#edf4ff}
  [data-theme=dark] .server-card {background-color:#204a7d;background-image:linear-gradient(110deg,#204a7dcc,#173859cc);border:2px dashed #728ba9;color:#edf4ff;box-shadow:2px 3px 8px #0005}
  [data-theme=dark] main a {color:#8fc9ff}
  @media(max-width:500px){#app{padding:12px}.grid{grid-template-columns:1fr}.server-card{min-height:100px}}
  ${kind === 'minimal' ? '#app, .server-card {background:transparent!important;border:0!important;box-shadow:none!important;border-radius:0!important} html,body{background:transparent;color:transparent}' : ''}
  ${kind === 'auto' ? '@media(prefers-color-scheme:dark){html,body{background:#101827;color:#f1f5f9}#app{background:#101827;color:#f1f5f9}.server-card{background:#1e293b;color:#f1f5f9;border-color:#64748b}}' : ''}
  </style>${head}</head><body><div id="app"><main>
  <select class="host-picker" aria-label="Node"><option>LAX.HDZ</option><option>Other node</option></select>
  <div class="grid"><article class="server-card"><a href="/instance/a">LAX.HDZ</a><p>CPU / Network / Memory</p></article><article class="server-card"><a href="/instance/b">Other node</a><p>Traffic</p></article></div>
  <div id="updates"></div></main></div>${body}</body></html>`;
}
async function setup(browser, viewport, kind) {
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://nf.test/**', route => route.request().url().includes('/texture.svg') ? route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0h1v20H0z" fill="gray"/></svg>'}) : route.request().url().includes('/api/plugin/net-forecast/overview')
    ? route.fulfill({json:data}) : route.fulfill({contentType:'text/html',body:fixture(kind)}));
  await page.goto('http://nf.test/instance/a');
  await page.waitForFunction(() => document.querySelector('#nf-floating-widget').style.getPropertyValue('--nf-page-bg'));
  await page.locator('#nfTriggerBtn').click();
  await page.locator('.nf-node-card').first().waitFor();
  return {context,page,errors};
}
async function styles(page) {
  return page.evaluate(() => {
    const get = q => { const el=document.querySelector(q), s=getComputedStyle(el), r=el.getBoundingClientRect();
      return { bg:s.backgroundColor,image:s.backgroundImage,size:s.backgroundSize,border:s.borderTop,borders:[s.borderTop,s.borderRight,s.borderBottom,s.borderLeft],radius:s.borderRadius,shadow:s.boxShadow,attachment:s.backgroundAttachment,origin:s.backgroundOrigin,clip:s.backgroundClip,blend:s.backgroundBlendMode,font:s.fontFamily,fontSize:s.fontSize,color:s.color,rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right} }; };
    return { page:get('#app'), host:get('.server-card'), panel:get('#nfWidgetCard'), card:get('.nf-node-card'), header:get('.nf-header'), footer:get('.nf-footer'), picker:get('.host-picker'), filters:get('.nf-filter-bar'), kpi:get('.nf-kpi-bar'), rootFont:get('#nf-floating-widget').fontSize,
      scheme:getComputedStyle(document.querySelector('#nf-floating-widget')).colorScheme };
  });
}
function matches(s, viewport) {
  assert.equal(s.panel.bg,s.page.bg); assert.equal(s.panel.image,s.page.image); assert.equal(s.panel.size,s.page.size);
  assert.equal(s.card.bg,s.host.bg); assert.equal(s.card.image,s.host.image); assert.equal(s.card.color,s.host.color);
  for(const key of ['attachment','origin','clip','blend']) {assert.equal(s.panel[key],s.page[key]);assert.equal(s.card[key],s.host[key]);}
  assert.deepEqual(s.card.borders,s.host.borders); assert.equal(s.panel.border,s.host.border);
  assert.equal(s.card.radius,s.host.radius); assert.equal(s.panel.radius,s.host.radius); assert.equal(s.card.shadow,s.host.shadow);
  assert.equal(s.panel.color,s.page.color); assert.equal(s.panel.font,s.page.font); assert.equal(s.rootFont,s.page.fontSize);
  assert.equal(s.header.bg,'rgba(0, 0, 0, 0)'); assert.equal(s.footer.bg,'rgba(0, 0, 0, 0)');
  assert.ok(s.panel.rect.x>=0 && s.panel.rect.right<=viewport.width && s.panel.rect.y>=0 && s.panel.rect.bottom<=viewport.height);
  assert.ok(s.filters.rect.y >= s.kpi.rect.bottom - 1); assert.ok(s.kpi.rect.y>=s.header.rect.bottom-1);
  assert.ok(s.footer.rect.bottom<=s.panel.rect.bottom+1);
}
for (const viewport of [{width:1360,height:1000},{width:390,height:844}]) {
  test(`theme matching and retained interactions ${viewport.width}px`, async () => {
    const browser = await chromium.launch({headless:true, executablePath:process.env.NF_CHROMIUM_PATH});
    try {
      const {page,context,errors}=await setup(browser,viewport);
      await page.waitForTimeout(1150);
      const light=await styles(page); matches(light,viewport);
      const hostBefore=await page.locator('#app').getAttribute('style');
      await page.screenshot({path:`${out}/light-${viewport.width}.png`});
      await page.evaluate(()=>document.documentElement.dataset.theme='dark');
      await page.waitForTimeout(1200);
      const dark=await styles(page); matches(dark,viewport); assert.equal(dark.scheme,'dark');
      assert.notEqual(dark.panel.bg,light.panel.bg); assert.equal(await page.locator('#app').getAttribute('style'),hostBefore);
      await page.screenshot({path:`${out}/dark-${viewport.width}.png`});
      await page.evaluate(()=>delete document.documentElement.dataset.theme); await page.waitForTimeout(1200); matches(await styles(page),viewport);
      await page.evaluate(()=>document.documentElement.dataset.theme='dark'); await page.waitForTimeout(1200);
      // No host picker injection or overlap with the floating title bar after drag.
      assert.equal(await page.locator('select').count(),1);
      await page.locator('#nfBtnAlert').click(); assert.equal(await page.locator('.nf-node-card').count(),1); assert.match(await page.locator('.nf-node-card').innerText(),/Warning/);
      await page.locator('#nfBtnAll').click(); assert.equal(await page.locator('.nf-node-card').count(),3);
      // Rapid widget-only updates must not cause theme feedback or periodic discovery.
      const count=await page.evaluate(()=>{window.nfReads=0;const original=document.elementsFromPoint.bind(document);document.elementsFromPoint=(...args)=>{window.nfReads++;return original(...args)};return window.nfReads});
      await page.evaluate(()=>{for(let i=0;i<100;i++)document.querySelector('#nfWhTitle').textContent='Forecast '+i});
      await page.waitForTimeout(1300); assert.equal(await page.evaluate(()=>window.nfReads),count);
      // pushState + replace of host samples, then back/hash navigation.
      await page.evaluate(()=>{history.pushState({},'', '/');document.querySelector('.grid').innerHTML='<article class="server-card" style="background-color:rgb(51,65,85);border:3px dotted rgb(140,160,180);border-radius:18px"><a href="/instance/a">Replacement</a><p>Node</p></article>'});
      await page.waitForTimeout(1300);
      assert.equal((await styles(page)).card.bg,'rgb(51, 65, 85)'); assert.match((await styles(page)).card.border,/3px dotted/);
      await page.evaluate(()=>history.pushState({},'', '/admin')); await page.waitForTimeout(150);
      assert.equal(await page.locator('#nf-floating-widget').isVisible(),false);
      await page.evaluate(()=>history.replaceState({},'', '/#/instance/a')); await page.waitForTimeout(150);
      await page.locator('#nfTriggerBtn').click(); await page.locator('#nfWidgetCard').waitFor();
      assert.match(await page.locator('#nfWhTitle').innerText(),/LAX/);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#nfWidgetCard').isVisible(),false);
      // Drag still moves and persists the trigger.
      const trigger=await page.locator('#nfTriggerBtn').boundingBox();
      await page.mouse.move(trigger.x+24,trigger.y+24); await page.mouse.down(); await page.mouse.move(55,130,{steps:8}); await page.mouse.up();
      const moved=await page.locator('#nfTriggerBtn').boundingBox();assert.ok(Math.abs(moved.x-trigger.x)>20); assert.ok(await page.evaluate(()=>localStorage.getItem('nf_btn_pos_v2')));
      await page.locator('#nfTriggerBtn').click(); await page.waitForTimeout(300);
      const panel=await page.locator('#nfWidgetCard').boundingBox(); assert.ok(panel.y>=moved.y+moved.height+9); assert.ok(panel.x>=0 && panel.x+panel.width<=viewport.width);
      await page.screenshot({path:`${out}/drag-${viewport.width}.png`});
      await page.locator('#nfCloseBtn').click(); assert.equal(await page.locator('#nfWidgetCard').isVisible(),false);
      assert.deepEqual(errors,[]); await context.close();
    } finally { await browser.close(); }
  });
}
test('system dark switch, missing surfaces, stylesheet changes and delayed rendering',async()=>{
  const browser=await chromium.launch({headless:true, executablePath:process.env.NF_CHROMIUM_PATH});
  try {
    let {page,context,errors}=await setup(browser,{width:1000,height:800},'auto');
    await page.emulateMedia({colorScheme:'dark'}); await page.waitForTimeout(1200);
    assert.equal((await styles(page)).scheme,'dark');assert.equal((await styles(page)).panel.bg,'rgb(16, 24, 39)');
    await page.emulateMedia({colorScheme:'light'});await page.waitForTimeout(1200);assert.equal((await styles(page)).scheme,'light');
    await page.evaluate(()=>{const style=document.createElement('style');style.textContent='#app{background-color:rgb(226,232,240)!important;background-image:none!important}';document.head.append(style)});
    await page.waitForTimeout(1200);assert.equal((await styles(page)).panel.bg,'rgb(226, 232, 240)');
    assert.deepEqual(errors,[]);await context.close();
    ({page,context,errors}=await setup(browser,{width:390,height:844},'minimal'));
    let fallback=await styles(page);assert.equal(fallback.panel.bg,'rgb(248, 250, 252)');assert.notEqual(fallback.card.color,'rgba(0, 0, 0, 0)');
    await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(1200);assert.equal((await styles(page)).panel.bg,'rgb(15, 23, 42)');
    await page.evaluate(()=>{document.querySelector('.grid').innerHTML='<article class="server-card" style="background:rgb(44,55,66)!important;border:0!important"><a href="/instance/a">Late node</a></article>'});
    await page.waitForTimeout(1300);assert.equal((await styles(page)).card.bg,'rgb(44, 55, 66)');
    assert.deepEqual(errors,[]);await context.close();
  } finally {await browser.close()}
});
fs.mkdirSync(out,{recursive:true});

test('classless link wrappers, ancestor theme changes, asymmetric borders and image URLs',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.NF_CHROMIUM_PATH});
  try {
    const viewport={width:1200,height:900};const {page,context,errors}=await setup(browser,viewport);
    await page.evaluate(()=>{
      const card=document.querySelector('.server-card');card.className='plain-surface';
      card.style.cssText='min-height:130px;padding:18px;background-color:rgb(241,245,249);background-image:url("/texture.svg");background-size:20px 20px;background-position:3px 4px;background-repeat:repeat-x;background-attachment:fixed;background-origin:content-box;background-clip:padding-box;background-blend-mode:multiply;border-top:3px dotted rgb(30,50,70);border-right:0;border-bottom:2px double rgb(50,60,70);border-left:1px solid rgb(70,80,90);border-radius:0;box-shadow:none;color:rgb(20,30,40)';
      document.querySelector('#app').style.fontFamily='Arial';document.querySelector('#app').style.fontSize='18px';
      history.replaceState({},'', '/instance/a?theme=plain');
    });
    await page.waitForTimeout(1400);
    let result=await page.evaluate(()=>{const h=getComputedStyle(document.querySelector('.plain-surface')),c=getComputedStyle(document.querySelector('.nf-node-card')),p=getComputedStyle(document.querySelector('#nfWidgetCard'));return {host:[h.backgroundColor,h.backgroundImage,h.backgroundSize,h.backgroundPosition,h.backgroundAttachment,h.backgroundOrigin,h.backgroundClip,h.backgroundBlendMode,h.borderTop,h.borderRight,h.borderBottom,h.borderLeft,h.borderRadius,h.boxShadow],card:[c.backgroundColor,c.backgroundImage,c.backgroundSize,c.backgroundPosition,c.backgroundAttachment,c.backgroundOrigin,c.backgroundClip,c.backgroundBlendMode,c.borderTop,c.borderRight,c.borderBottom,c.borderLeft,c.borderRadius,c.boxShadow],font:p.fontFamily,size:getComputedStyle(document.querySelector('#nf-floating-widget')).fontSize}});
    assert.deepEqual(result.card,result.host);assert.equal(result.font,'Arial');assert.equal(result.size,'18px');
    // A theme class on a wrapper must be seen even when the sampled card is opaque.
    await page.evaluate(()=>{document.querySelector('#app').dataset.theme='dark'});await page.waitForTimeout(1200);assert.equal((await stylesForPanel(page)).bg,'rgb(22, 61, 112)');
    assert.deepEqual(errors,[]);await context.close();
  } finally {await browser.close()}
});
async function stylesForPanel(page){return page.locator('#nfWidgetCard').evaluate(el=>({bg:getComputedStyle(el).backgroundColor}));}

test('empty host defers late-surface discovery and ignores rapid host text/graph updates',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NF_CHROMIUM_PATH});
 try{
  const {page,context,errors}=await setup(browser,{width:1000,height:800},'minimal');await page.waitForTimeout(1200);
  await page.evaluate(()=>{window.nfReads=0;const orig=document.elementsFromPoint.bind(document);document.elementsFromPoint=(...args)=>{window.nfReads++;return orig(...args)};const card=document.createElement('article');card.className='node-late';card.style.cssText='width:200px;height:100px;background:rgb(40,55,70);color:white;border:1px solid gray';card.textContent='Late rendered node';document.querySelector('#updates').append(card);for(let i=0;i<100;i++){const div=document.createElement('div');div.textContent=String(i);document.querySelector('#updates').append(div)}});
  await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>window.nfReads),0);
  await page.waitForTimeout(4100);assert.equal(await page.evaluate(()=>window.nfReads),3);
  assert.equal(await page.locator('.nf-node-card').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(40, 55, 70)');
  assert.deepEqual(errors,[]);await context.close();
 }finally{await browser.close()}
});
