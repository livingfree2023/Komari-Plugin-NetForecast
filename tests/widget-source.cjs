const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
const start = source.indexOf('const WIDGET_HEAD_HTML =');
const end = source.indexOf('\nfunction load()', start);
const context = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.widget = { head: WIDGET_HEAD_HTML, body: WIDGET_BODY_HTML };', context);
module.exports = { ...context.widget, source };
