const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup() {
  class MarkdownView {}
  class Plugin {
    async loadData() { return {}; }
    registerEditorExtension(listener) { this.listener = listener; }
    registerView() {}
    addRibbonIcon() { return { addClass() {} }; }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
  }
  const context = {
    module: { exports: {} }, window: { clearTimeout }, console,
    require(id) {
      if (id === '@codemirror/view') return { EditorView: { updateListener: { of: fn => fn } } };
      assert.equal(id, 'obsidian');
      return { Plugin, MarkdownView, ItemView: class {}, PluginSettingTab: class {}, editorInfoField: 'editor-info' };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const p = new context.module.exports();
  const v = Object.assign(new MarkdownView(), {
    file: { path: 'Sample.md' },
    editor: { getValue: () => '# Parent\n1. Item', getCursor: () => ({ line: 1, ch: 0 }) },
    getMode: () => 'source',
  });
  p.app = { workspace: {
    on() {}, onLayoutReady() {}, detachLeavesOfType() {},
    getActiveViewOfType: () => v,
  }, vault: { on() {} } };
  await p.onload();
  let renders = 0;
  p.refreshViews = async () => { renders++; };
  const update = (line, info = v, extra = {}) => p.listener({
    view: { hasFocus: true }, selectionSet: true, docChanged: false, focusChanged: false,
    state: { field: () => info, doc: { lineAt: () => ({ number: line + 1 }) }, selection: { main: { head: 0 } } },
    ...extra,
  });
  return { p, v, update, renders: () => renders };
}

test('cursor listener accepts the editor view and wrapped editor info without scrolling', async () => {
  const { p, v, update, renders } = await setup();
  assert.equal(p.settings.autoSyncToCursor, true);
  assert.equal(p.settings.autoSyncToScroll, false);
  update(1);
  await Promise.resolve();
  assert.equal(p.activeScrollPath.line, 1);
  assert.equal(p.activeScrollPath.source, 'cursor');
  update(2, { view: v });
  await Promise.resolve();
  assert.equal(p.activeScrollPath.line, 2);
  assert.equal(renders(), 2);
});

test('only the latest selection in an update batch is rendered', async () => {
  const { p, update, renders } = await setup();
  update(1); update(2); update(3);
  await Promise.resolve();
  assert.equal(p.activeScrollPath.line, 3);
  assert.equal(renders(), 1);
});

test('typing and focus changes follow the cursor; unrelated updates do not', async () => {
  const { p, v, update, renders } = await setup();
  update(1, v, { selectionSet: false });
  await Promise.resolve();
  assert.equal(renders(), 0);
  update(2, v, { selectionSet: false, docChanged: true });
  await Promise.resolve();
  assert.equal(p.activeScrollPath.line, 2);
  update(3, v, { selectionSet: false, focusChanged: true });
  await Promise.resolve();
  assert.equal(p.activeScrollPath.line, 3);
});

test('disabled, unfocused, inactive, and reading views do not take over the outline', async () => {
  const { p, v, update, renders } = await setup();
  p.settings.autoSyncToCursor = false;
  update(1);
  await Promise.resolve();
  p.settings.autoSyncToCursor = true;
  update(1, v, { view: { hasFocus: false } });
  await Promise.resolve();
  p.app.workspace.getActiveViewOfType = () => null;
  update(1);
  await Promise.resolve();
  p.app.workspace.getActiveViewOfType = () => v;
  v.getMode = () => 'preview';
  update(1);
  await Promise.resolve();
  assert.equal(renders(), 0);
});

test('cursor cancels pending scroll sync and suppresses incidental scroll', async () => {
  const { p, update } = await setup();
  p.scrollTimer = setTimeout(() => assert.fail('stale scroll callback'), 10);
  update(1);
  await Promise.resolve();
  assert.equal(p.scrollTimer, null);
  assert.ok(p.suppressScrollSyncUntil > Date.now());
  p.settings.autoSyncToScroll = true;
  await p.updateActiveOutlineFromScroll();
  assert.equal(p.activeScrollPath.source, 'cursor');
});

test('unloading cancels queued cursor work', async () => {
  const { p, update, renders } = await setup();
  update(1);
  p.onunload();
  await Promise.resolve();
  assert.equal(renders(), 0);
});
