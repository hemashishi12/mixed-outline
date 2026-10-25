const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(mode = 'source') {
  class MarkdownView {}
  class TFile {
    constructor(filePath) { this.path = filePath; }
  }
  const notices = [];
  const context = {
    module: { exports: {} }, console,
    require(id) {
      if (id === '@codemirror/view') return { EditorView: {} };
      assert.equal(id, 'obsidian');
      return {
        MarkdownView, TFile, ItemView: class {}, Plugin: class {},
        PluginSettingTab: class {},
        Notice: class { constructor(message) { notices.push(message); } },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  plugin.settings = { outlineMode: 'remember' };
  const file = new TFile('中文 Note.md');
  const source = '# First\n\n1. One\n\nText\n\n1. Two\n';
  const calls = { cursor: [], scroll: [], focus: 0, read: 0, edits: 0, ephemeral: [], opened: [], active: [] };
  const editor = {
    setCursor(pos) { calls.cursor.push(pos); },
    scrollIntoView(range, center) { calls.scroll.push({ range, center }); },
    focus() { calls.focus++; },
    getValue() { calls.read++; return source; },
    replaceRange() { calls.edits++; assert.fail('revealing an outline item must not edit the note'); },
    setValue() { calls.edits++; assert.fail('revealing an outline item must not replace the note'); },
  };
  const view = Object.assign(new MarkdownView(), {
    file, editor, getMode: () => mode, getViewType: () => 'markdown',
    // Preview elements may not exist yet, and per-list line numbers may repeat.
    contentEl: { querySelectorAll() { assert.fail('navigation must not inspect rendered data-line markers'); } },
  });
  const leaf = {
    view,
    setEphemeralState(state) { calls.ephemeral.push(state); },
    async openFile(target, options) {
      calls.opened.push({ target, options });
      this.view = view;
      view.file = target;
    },
  };
  view.leaf = leaf;
  let leaves = [leaf];
  let recent = leaf;
  plugin.app = {
    vault: { getAbstractFileByPath: filePath => filePath === file.path ? file : null },
    workspace: {
      getLeavesOfType: () => leaves,
      getMostRecentLeaf: () => recent,
      getLeaf(type) { assert.equal(type, 'tab'); return leaf; },
      setActiveLeaf(target, options) { calls.active.push({ target, options }); },
    },
  };
  return {
    plugin, file, view, leaf, calls, notices, source, MarkdownView, TFile,
    node: { filePath: file.path, line: 6, ch: 3 },
    closeNote() { leaves = []; },
    setRecent(target) { recent = target; },
  };
}

test('reading mode delegates document-line navigation and focus to Obsidian', async () => {
  const f = setup('preview');
  f.plugin.pendingEditorText = 'stale';
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.ephemeral.length, 1);
  assert.equal(f.calls.ephemeral[0].line, 6);
  assert.equal(f.calls.ephemeral[0].focus, true);
  assert.equal(f.calls.active[0].target, f.leaf);
  assert.equal(f.calls.active[0].options.focus, true);
  assert.equal(f.calls.cursor.length, 0);
  assert.equal(f.calls.scroll.length, 0);
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.edits, 0);
  assert.equal(f.plugin.currentFile, f.file);
  assert.equal(f.plugin.pendingEditorText, null);
  assert.equal(f.view.getMode(), 'preview');
});

test('reading navigation does not require preview DOM or an initialized hidden editor', async () => {
  const f = setup('preview');
  f.view.contentEl = null;
  f.view.editor = null;
  f.view.previewMode = null;
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.ephemeral.length, 1);
  assert.equal(f.calls.ephemeral[0].line, f.node.line);
  assert.equal(f.calls.edits, 0);
});

for (const livePreview of [false, true]) {
  test(`source navigation preserves line, column and note contents (Live Preview: ${livePreview})`, async () => {
    const f = setup('source');
    f.view.getState = () => ({ source: !livePreview });
    await f.plugin.revealNode(f.node);
    assert.equal(f.calls.cursor.length, 1);
    assert.equal(f.calls.cursor[0].line, f.node.line);
    assert.equal(f.calls.cursor[0].ch, f.node.ch);
    assert.equal(f.calls.scroll[0].range.from, f.calls.cursor[0]);
    assert.equal(f.calls.scroll[0].range.to, f.calls.cursor[0]);
    assert.equal(f.calls.scroll[0].center, true);
    assert.equal(f.calls.focus, 1);
    assert.equal(f.calls.ephemeral.length, 0);
    assert.equal(f.calls.edits, 0);
    assert.equal(f.plugin.pendingEditorText, f.source);
  });
}

test('source nodes without a column navigate to column zero', async () => {
  const f = setup();
  delete f.node.ch;
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.cursor[0].ch, 0);
});

test('stale nodes for deleted notes report a notice without moving or editing', async () => {
  const f = setup();
  await f.plugin.revealNode({ ...f.node, filePath: 'Deleted.md' });
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /file not found/);
  assert.equal(f.calls.active.length, 0);
  assert.equal(f.calls.cursor.length, 0);
  assert.equal(f.calls.edits, 0);
});

test('folders and invalid node coordinates cannot trigger navigation', async () => {
  const f = setup();
  for (const node of [null, {}, { ...f.node, line: -1 }, { ...f.node, line: NaN }, { ...f.node, line: 1.5 }]) {
    await f.plugin.revealNode(node);
  }
  f.plugin.app.vault.getAbstractFileByPath = () => ({ path: 'Folder' });
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.active.length, 0);
  assert.equal(f.calls.edits, 0);
  assert.equal(f.notices.length, 1);
});

for (const mode of ['source', 'preview']) {
  test(`closed notes open before navigation in ${mode} mode`, async () => {
    const f = setup(mode);
    f.closeNote();
    let resume;
    f.leaf.openFile = async (target, options) => {
      f.calls.opened.push({ target, options });
      await new Promise(resolve => { resume = resolve; });
    };
    const pending = f.plugin.revealNode(f.node);
    assert.equal(f.calls.cursor.length + f.calls.ephemeral.length, 0);
    resume();
    await pending;
    assert.equal(f.calls.opened[0].target, f.file);
    assert.equal(f.calls.opened[0].options.active, true);
    assert.equal(f.calls.cursor.length + f.calls.ephemeral.length, 1);
    assert.equal(f.calls.edits, 0);
  });
}

test('the outline sidebar is never reused as the Markdown target leaf', async () => {
  const f = setup('preview');
  f.closeNote();
  f.setRecent({ view: { getViewType: () => 'mixed-outline-view' }, openFile() { assert.fail('must not replace the sidebar'); } });
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.opened.length, 1);
  assert.equal(f.calls.ephemeral.length, 1);
});

for (const mode of ['source', 'preview']) {
  test(`a file switch while openFile is pending cancels ${mode} navigation`, async () => {
    const f = setup(mode);
    f.closeNote();
    let resume;
    f.leaf.openFile = () => new Promise(resolve => { resume = resolve; });
    const pending = f.plugin.revealNode(f.node);
    f.view.file = new f.TFile('Other.md');
    resume();
    await pending;
    assert.equal(f.calls.cursor.length + f.calls.ephemeral.length, 0);
    assert.equal(f.plugin.currentFile, undefined);
    assert.equal(f.calls.edits, 0);
  });
}

test('a target leaf replaced by a non-Markdown view cancels navigation', async () => {
  const f = setup();
  f.closeNote();
  f.leaf.openFile = async () => { f.leaf.view = {}; };
  await f.plugin.revealNode(f.node);
  assert.equal(f.calls.cursor.length + f.calls.ephemeral.length, 0);
  assert.equal(f.calls.edits, 0);
});

test('a later outline click cancels an older pending navigation', async () => {
  const f = setup();
  f.closeNote();
  let resume;
  f.leaf.openFile = () => new Promise(resolve => { resume = resolve; });
  const first = f.plugin.revealNode(f.node);
  f.plugin.app.workspace.getLeavesOfType = () => [f.leaf];
  await f.plugin.revealNode({ ...f.node, line: 2 });
  resume();
  await first;
  assert.equal(f.calls.cursor.length, 1);
  assert.equal(f.calls.cursor[0].line, 2);
  assert.equal(f.calls.edits, 0);
});
