const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {
  module: { exports: {} },
  require(id) {
    if (id === '@codemirror/view') return { EditorView: {} };
    assert.equal(id, 'obsidian');
    return { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {} };
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
const { buildMixedOutlineTree } = context.module.exports.__test;
const settings = {
  showHeadings: true, showOrderedLists: true,
  stripMarkdownFormatting: true, maxItemLength: 160,
};

function outline(source) {
  const root = buildMixedOutlineTree(source, 'Parser.md', settings);
  const result = [];
  function visit(parent) {
    for (const child of parent.children) {
      result.push({
        title: child.title, parent: parent.type === 'root' ? null : parent.title,
        marker: child.displayMarker, line: child.line,
      });
      visit(child);
    }
  }
  visit(root);
  return result;
}

function structure(source) {
  return outline(source).map(({ title, parent, marker }) => [title, parent, marker]);
}

for (const width of [3, 4]) {
  test(`issue #2: ${width}-space ordered siblings survive hidden lists and paragraphs`, () => {
    const i = ' '.repeat(width);
    assert.deepEqual(structure([
      '# Section', '1. Parent', `${i}1. First`, `${i}   - Details`,
      `${i}     1. Hidden child`, '', `${i}   Description`, '',
      `${i}2. Second`, `${i}   - [x] Done`, `${i}     1. Hidden task child`,
      '', `${i}3. Third`, '2. Next parent',
    ].join('\n')), [
      ['Section', null, undefined], ['Parent', 'Section', '1.'],
      ['First', 'Parent', '1.'], ['Second', 'Parent', '2.'],
      ['Third', 'Parent', '3.'], ['Next parent', 'Section', '2.'],
    ]);
  });
}

test('loose ordered lists retain both hierarchy and numbering across blank lines', () => {
  assert.deepEqual(structure('4. Parent\n\n   7. First\n\n      Paragraph\n\n   1. Second\n\n1. Peer'), [
    ['Parent', null, '4.'], ['First', 'Parent', '7.'],
    ['Second', 'Parent', '8.'], ['Peer', null, '5.'],
  ]);
});

test('lazy paragraph continuations do not discard the parent list', () => {
  assert.deepEqual(structure('1. Parent\ncontinued text\n   1. Child\n      more text\n   1. Next'), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'], ['Next', 'Parent', '2.'],
  ]);
});

test('a dedented paragraph after a blank line ends the preceding list', () => {
  assert.deepEqual(structure('4. Old\n\nA new paragraph\n\n   1. New list'), [
    ['Old', null, '4.'], ['New list', null, '1.'],
  ]);
});

test('dedented continuation paragraphs keep only their actual ancestor', () => {
  assert.deepEqual(structure('1. Parent\n   1. Child\n      1. Deep\n\n   Parent description\n\n   1. Next child'), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'],
    ['Deep', 'Child', '1.'], ['Next child', 'Parent', '1.'],
  ]);
});

test('hidden unordered and task branches stay hidden until their real sibling', () => {
  assert.deepEqual(structure([
    '1. Parent', '   - Hidden bullet', '', '     Hidden description',
    '     1. Hidden ordered', '        1. Deep hidden', '',
    '   1. Visible', '   2. [ ] Hidden ordered task',
    '      1. Hidden task child', '   3. Visible again',
    '- Root bullet', '  1. Hidden root child', '1. Root visible',
  ].join('\n')), [
    ['Parent', null, '1.'], ['Visible', 'Parent', '1.'],
    ['Visible again', 'Parent', '2.'], ['Root visible', null, '1.'],
  ]);
});

test('headings nested under hidden bullets do not leak into the outline', () => {
  assert.deepEqual(structure('- Hidden\n  # Hidden heading\n  1. Hidden child\n# Visible\n1. Item'), [
    ['Visible', null, undefined], ['Item', 'Visible', '1.'],
  ]);
});

test('top-level indented code and its numeric lines stay out of the outline', () => {
  assert.deepEqual(structure('    1. Code\n\t2. Tabbed code\n\n1. Visible'), [
    ['Visible', null, '1.'],
  ]);
});

test('indented code is measured from the containing list content column', () => {
  assert.deepEqual(structure('1. Parent\n\n       1. Code\n\n   1. Child\n\n          1. More code\n\n   1. Next'), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'], ['Next', 'Parent', '2.'],
  ]);
});

test('top-level fences interrupt list context and ignore marker-looking code', () => {
  assert.deepEqual(structure('1. Before\n```md\n1. Code\n# Code heading\n```\n   1. After'), [
    ['Before', null, '1.'], ['After', null, '1.'],
  ]);
});

test('nested fences ignore code and preserve following ordered siblings', () => {
  assert.deepEqual(structure([
    '1. Parent', '   1. Child', '      ```md', '      1. Code',
    '      ``` not a closer', '      2. Still code', '      ```',
    '   1. Next',
  ].join('\n')), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'], ['Next', 'Parent', '2.'],
  ]);
});

test('a nested unclosed fence ends at its containing list boundary', () => {
  assert.deepEqual(structure('1. Parent\n   ~~~~\n   1. Code\n2. Peer\n   1. Child'), [
    ['Parent', null, '1.'], ['Peer', null, '2.'], ['Child', 'Peer', '1.'],
  ]);
});

test('a fence directly following an ordered marker protects its body', () => {
  assert.deepEqual(structure('1. ```md\n   1. Code\n   ```\n2. Peer'), [
    ['```md', null, '1.'], ['Peer', null, '2.'],
  ]);
});

test('fences inside indented code do not swallow subsequent real lists', () => {
  assert.deepEqual(structure('    ```\n    1. Code\n\n1. Visible\n   1. Child'), [
    ['Visible', null, '1.'], ['Child', 'Visible', '1.'],
  ]);
});

test('multi-digit markers require their full content indentation for children', () => {
  assert.deepEqual(structure('10. Parent\n    1. Child\n    1. Next child\n   2. Root peer'), [
    ['Parent', null, '10.'], ['Child', 'Parent', '1.'],
    ['Next child', 'Parent', '2.'], ['Root peer', null, '11.'],
  ]);
});

test('marker whitespace and tabs use actual column stops', () => {
  assert.deepEqual(structure('1.\tParent\n\t1. Child\n\t\t1. Deep\n\t2. Next\n2. Peer'), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'], ['Deep', 'Child', '1.'],
    ['Next', 'Parent', '2.'], ['Peer', null, '2.'],
  ]);
  assert.deepEqual(structure(' 1.\tParent\n    1. Child'), [
    ['Parent', null, '1.'], ['Child', 'Parent', '1.'],
  ]);
});

test('thematic breaks end list containers instead of becoming hidden bullets', () => {
  assert.deepEqual(structure('4. Before\n* * *\n   1. After'), [
    ['Before', null, '4.'], ['After', null, '1.'],
  ]);
});

test('node positions still refer to the original source lines', () => {
  assert.deepEqual(outline('---\ntitle: Example\n---\n# 标题\n\n1. 第一项\n\n   1. 子项').map(({ title, line }) => [title, line]), [
    ['标题', 3], ['第一项', 5], ['子项', 7],
  ]);
});
