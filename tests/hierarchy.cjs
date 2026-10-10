const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function run(api) {
  const settings = { showHeadings: true, showOrderedLists: true, stripMarkdownFormatting: true, maxItemLength: 160 };
  let count = 0;
  function check(name, source, expected, overrides = {}) {
    const root = api.buildMixedOutlineTree(source, 'test.md', { ...settings, ...overrides });
    const parents = [];
    function walk(node) {
      for (const child of node.children) {
        parents.push([child.line, node.type === 'root' ? null : node.line]);
        walk(child);
      }
    }
    walk(root);
    assert.deepEqual(JSON.parse(JSON.stringify(parents)), expected, name);
    count++;
    return root;
  }
  for (let level = 1; level <= 6; level++) {
    const heading = '#'.repeat(level);
    check(`list before H${level}`, `1. Before\n${heading} Heading`, [[0, null], [1, null]]);
    check(`H${level} before list`, `${heading} Heading\n1. After\n2. Peer`, [[0, null], [1, 0], [2, 0]]);
    check(`nested list before H${level}`, `1. Before\n   1. Nested\n      1. Deep\n${heading} Heading`, [[0, null], [1, 0], [2, 1], [3, null]]);
    for (let parent = 1; parent < level; parent++) {
      check(`H${parent}, list, H${level}`, `${'#'.repeat(parent)} Parent\n1. Before\n   1. Nested\n${heading} Child\n1. After`, [[0, null], [1, 0], [2, 1], [3, 0], [4, 3]]);
    }
  }
  check('same and shallower headings end previous sections', '# Top\n## Section\n1. Item\n### Child\n1. Child item\n## Peer\n1. Peer item\n# Next', [[0, null], [1, 0], [2, 1], [3, 1], [4, 3], [5, 0], [6, 5], [7, null]]);
  check('lists hidden preserve heading hierarchy', '# Top\n1. Hidden\n### Child', [[0, null], [2, 0]], { showOrderedLists: false });
  check('headings hidden keep lists visible', '# Hidden\n1. One\n2. Two', [[1, null], [2, null]], { showHeadings: false });
  const root = check('scroll path excludes previous list', '1. Before\n   1. Nested\n### Heading\n1. After', [[0, null], [1, 0], [2, null], [3, 2]]);
  assert.deepEqual(Array.from(api.findNodePathForLine(root.children, 2), node => node.line), [2]);
  assert.deepEqual(Array.from(api.findNodePathForLine(root.children, 3), node => node.line), [2, 3]);
  assert.equal(root.children[0].displayMarker, '1.');
  assert.equal(root.children[1].children[0].displayMarker, '1.');
  return `${count} hierarchy cases passed, including scroll paths and numbering`;
}

module.exports = { run };
if (require.main === module) {
  const pluginPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'main.js');
  const context = { module: { exports: {} }, require: name => {
    if (name === '@codemirror/view') return { EditorView: {} };
    if (name !== 'obsidian') throw new Error(`Unexpected dependency: ${name}`);
    return { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {} };
  } };
  vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8'), context, { filename: pluginPath });
  console.log(run(context.module.exports.__test));
}
