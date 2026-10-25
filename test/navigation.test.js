const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(source = '', mode = 'source') {
  class MarkdownView {}
  const notices = [];
  const context = {
    module: { exports: {} },
    console: { error() {} },
    require(id) {
      if (id === '@codemirror/view') return { EditorView: {} };
      assert.equal(id, 'obsidian');
      return {
        MarkdownView,
        ItemView: class {},
        Plugin: class {},
        PluginSettingTab: class {},
        Notice: class { constructor(message) { notices.push(message); } },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  let value = source;
  let cursor;
  let focused = false;
  let edits = 0;
  let scrolled;
  const editor = {
    lastLine: () => value.split('\n').length - 1,
    getLine: line => value.split('\n')[line],
    getValue: () => value,
    replaceRange(text, pos) {
      const lines = value.split('\n');
      const offset = lines.slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.ch;
      value = value.slice(0, offset) + text + value.slice(offset);
      edits++;
    },
    setCursor: pos => { cursor = pos; },
    focus: () => { focused = true; },
    scrollIntoView(range) { scrolled = range.from; },
  };
  const file = { path: 'Sample.md' };
  const view = Object.assign(new MarkdownView(), {
    file, editor,
    getMode: () => mode,
    getState: () => ({ file: file.path, mode, customState: 'retained' }),
  });
  const leaf = {
    view,
    getViewState: () => ({ type: 'markdown', state: view.getState() }),
    async setViewState(state) {
      assert.equal(state.state.customState, 'retained');
      mode = state.state.mode;
    },
  };
  view.leaf = leaf;
  plugin.app = { workspace: {
    getActiveViewOfType: () => view,
    getLeavesOfType: () => [leaf],
    revealLeaf: async () => {},
    setActiveLeaf(target) { assert.equal(target, leaf); },
  } };
  plugin.syncScrollListener = () => {};
  plugin.scheduleRefresh = () => {};
  return { plugin, view, leaf, notices, editor, state: () => ({ value, cursor, focused, edits, mode, scrolled }) };
}

for (const [name, source, expected] of [
  ['empty note', '', ''],
  ['plain text', 'Keep this text', 'Keep this text\n'],
  ['existing newline', 'Keep this text\n', 'Keep this text\n'],
  ['existing blank lines', 'Keep this text\n\n', 'Keep this text\n\n'],
  ['ordered list', '1. Keep this item', '1. Keep this item\n'],
  ['whitespace', 'Keep this text\n  ', 'Keep this text\n  \n'],
  ['Unicode', '你好 🌿', '你好 🌿\n'],
  ['long note', 'Line\n'.repeat(10000) + 'End', 'Line\n'.repeat(10000) + 'End\n'],
]) {
  test(`jump to end preserves content: ${name}`, async () => {
    const f = setup(source);
    await f.plugin.jumpToEnd();
    const state = f.state();
    assert.equal(state.value, expected);
    assert.equal(state.cursor.line, expected.split('\n').length - 1);
    assert.equal(state.cursor.ch, 0);
    assert.equal(state.scrolled.line, state.cursor.line);
    assert.equal(state.focused, true);
    assert.equal(state.edits, source === expected ? 0 : 1);
    await f.plugin.jumpToEnd();
    assert.equal(f.state().value, expected);
    assert.equal(f.state().edits, state.edits);
  });
}

test('reading view becomes editable before inserting the newline', async () => {
  const f = setup('Text', 'preview');
  const replace = f.editor.replaceRange;
  f.editor.replaceRange = (...args) => {
    assert.equal(f.state().mode, 'source');
    replace(...args);
  };
  await f.plugin.jumpToEnd();
  assert.equal(f.state().mode, 'source');
  assert.equal(f.state().value, 'Text\n');
});

test('sidebar focus resolves the tracked note instead of an unrelated tab', async () => {
  const f = setup('Text');
  f.plugin.currentFile = f.view.file;
  f.plugin.app.workspace.getActiveViewOfType = () => null;
  f.plugin.app.workspace.getLeavesOfType = () => [{ view: {} }, f.leaf];
  await f.plugin.jumpToEnd();
  assert.equal(f.state().value, 'Text\n');
});

test('no Markdown note reports a notice without editing', async () => {
  const f = setup('Text');
  f.plugin.getCurrentMarkdownView = () => null;
  await f.plugin.jumpToEnd();
  assert.equal(f.notices.length, 1);
  assert.equal(f.state().edits, 0);
});

test('changing files during view activation cancels the edit', async () => {
  const f = setup('Text', 'preview');
  f.leaf.setViewState = async () => { f.view.file = { path: 'Other.md' }; };
  await f.plugin.jumpToEnd();
  assert.equal(f.state().edits, 0);
  assert.equal(f.plugin.jumpingToEnd, false);
});

test('overlapping clicks do not append extra lines', async () => {
  const f = setup('Text');
  let resume;
  f.plugin.app.workspace.revealLeaf = () => new Promise(resolve => { resume = resolve; });
  const first = f.plugin.jumpToEnd();
  await f.plugin.jumpToEnd();
  resume();
  await first;
  assert.equal(f.state().value, 'Text\n');
  assert.equal(f.state().edits, 1);
});

test('a failed view activation releases the guard for the next attempt', async () => {
  const f = setup('Text');
  f.plugin.app.workspace.revealLeaf = async () => { throw new Error('Unavailable'); };
  await f.plugin.jumpToEnd();
  assert.equal(f.plugin.jumpingToEnd, false);
  assert.equal(f.state().edits, 0);
  assert.equal(f.notices.length, 1);
  f.plugin.app.workspace.revealLeaf = async () => {};
  await f.plugin.jumpToEnd();
  assert.equal(f.state().value, 'Text\n');
});

for (const source of ['', '# Heading\n1. Keep this item', 'Line\n'.repeat(10000)]) {
  for (const mode of ['source', 'preview']) {
    test(`jump to start focuses the first position without edits: ${mode}, ${source.length} chars`, async () => {
      const f = setup(source, mode);
      await f.plugin.jumpToStart();
      const state = f.state();
      assert.equal(state.value, source);
      assert.equal(state.edits, 0);
      assert.equal(state.cursor.line, 0);
      assert.equal(state.cursor.ch, 0);
      assert.equal(state.scrolled.line, 0);
      assert.equal(state.focused, true);
      assert.equal(state.mode, 'source');
    });
  }
}

test('jump to start resolves the tracked note when the sidebar has focus', async () => {
  const f = setup('First\nLast');
  f.plugin.currentFile = f.view.file;
  f.plugin.app.workspace.getActiveViewOfType = () => null;
  await f.plugin.jumpToStart();
  assert.equal(f.state().cursor.line, 0);
  assert.equal(f.state().edits, 0);
});

test('jump to start handles missing notes and file changes without moving the cursor', async () => {
  const missing = setup('Text');
  missing.plugin.getCurrentMarkdownView = () => null;
  await missing.plugin.jumpToStart();
  assert.equal(missing.notices.length, 1);
  assert.equal(missing.state().cursor, undefined);

  const changed = setup('Text', 'preview');
  changed.leaf.setViewState = async () => { changed.view.file = { path: 'Other.md' }; };
  await changed.plugin.jumpToStart();
  assert.equal(changed.state().cursor, undefined);
  assert.equal(changed.plugin.jumpingToStart, false);
});

test('jump to start releases its guard after failure', async () => {
  const f = setup('Text');
  f.plugin.app.workspace.revealLeaf = async () => { throw new Error('Unavailable'); };
  await f.plugin.jumpToStart();
  assert.equal(f.plugin.jumpingToStart, false);
  assert.equal(f.notices.length, 1);
  f.plugin.app.workspace.revealLeaf = async () => {};
  await f.plugin.jumpToStart();
  assert.equal(f.state().cursor.line, 0);
});

test('start and end navigation cannot race during view activation', async () => {
  for (const firstMethod of ['jumpToStart', 'jumpToEnd']) {
    const f = setup('First\nLast');
    let resume;
    f.plugin.app.workspace.revealLeaf = () => new Promise(resolve => { resume = resolve; });
    const first = f.plugin[firstMethod]();
    await f.plugin.jumpToStart();
    await f.plugin.jumpToEnd();
    resume();
    await first;
    assert.equal(f.state().cursor.line, firstMethod === 'jumpToStart' ? 0 : 2);
    assert.equal(f.state().edits, firstMethod === 'jumpToStart' ? 0 : 1);
  }
});
