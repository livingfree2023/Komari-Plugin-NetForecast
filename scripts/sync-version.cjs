const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'komari-plugin.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Package and manifest versions differ');
for (const file of ['pages/admin.html', 'pages/public.html']) {
  const target = path.join(root, file);
  const source = fs.readFileSync(target, 'utf8');
  const pattern = /<span>NetForecast v\d+\.\d+\.\d+<\/span>/g;
  if ([...source.matchAll(pattern)].length !== 1) throw new Error(`Missing or ambiguous version footer: ${file}`);
  const updated = source.replace(pattern, `<span>NetForecast v${manifest.version}</span>`);
  if (process.argv.includes('--check')) {
    if (updated !== source) throw new Error(`Footer version differs from manifest: ${file}`);
  } else {
    fs.writeFileSync(target, updated);
  }
}
