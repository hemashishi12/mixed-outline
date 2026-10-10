const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('37 heading/list hierarchy cases, scroll paths, and numbering', () => {
  execFileSync(process.execPath, [path.join(__dirname, '../tests/hierarchy.cjs')], { stdio: 'pipe' });
});
