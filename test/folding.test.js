const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(cls = '') { this.classes = new Set(cls.split(' ')); this.children = []; this.style = {}; this.scrollTop = 0; }
  addClass(cls) { this.classes.add(cls); }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  setAttribute() {}
  addEventListener() {}
  createDiv(options = '') { return this.createEl('div', typeof options === 'string' ? { cls: options } : options); }
  createEl(tag, options = {}) {
    const element = new Element(options.cls ?? '');
    this.children.push(element);
    return element;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.classes.has(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

async function setup(store = { data: { outlineMode: 'remember' } }) {
  class MarkdownView {}
  class Plugin {
    async loadData() { return structuredClone(store.data); }
    async saveData(data) {
      if (store.write) await store.write(data);
      store.data = structuredClone(data);
    }
    registerEditorExtension() {}
    registerMarkdownPostProcessor() {}
    registerView() {}
    addRibbonIcon() { return { addClass() {} }; }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
  }
  const notices = [];
  const context = { module: { exports: {} }, console, window: { clearTimeout, setTimeout }, require(name) {
    if (name === '@codemirror/view') return { EditorView: { updateListener: { of: fn => fn } } };
    return { Plugin, MarkdownView, PluginSettingTab: class {}, ItemView: class { constructor() { this.contentEl = new Element(); } }, Notice: class { constructor(message) { notices.push(message); } }, setIcon() {} };
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  const events = {};
  const outlines = [];
  const markdown = Object.assign(new MarkdownView(), {
    file: { path: 'A.md' }, getMode: () => 'source',
    contentEl: new Element(),
    editor: { getValue: () => '# Parent\n## Child\n1. Item', getCursor: () => ({ line: 2, ch: 0 }) },
  });
  plugin.app = { workspace: {
    on() {}, onLayoutReady() {}, detachLeavesOfType() {},
    getActiveViewOfType: () => markdown,
    getLeavesOfType: type => type === 'mixed-outline-view' ? outlines : [],
  }, vault: { on(name, callback) { events[name] = callback; } } };
  await plugin.onload();
  let current = { file: { path: 'A.md', basename: 'A' }, source: '# Parent\n## Child\n1. Item' };
  plugin.getOutlineSource = async () => current;
  plugin.refreshViews = async () => {};
  const View = context.module.exports.__test.MixedOutlineView;
  const view = new View({}, plugin);
  outlines.push({ view });
  await view.render();
  return { plugin, view, store, View, markdown, events, notices,
    setFile(filePath, source = current.source) { current = { file: { path: filePath, basename: filePath }, source }; },
  };
}

const node = (view, title) => view.lastNodes.find(item => item.title === title);
const folded = (view, title) => view.collapsed.has(node(view, title).id);

test('manual folds and expansions survive file switches and plugin recreation', async () => {
  const f = await setup();
  await f.view.toggleNode(node(f.view, 'Parent'));
  await f.view.expandNode(node(f.view, 'Child'));
  f.setFile('B.md'); await f.view.render();
  assert.equal(folded(f.view, 'Parent'), false);
  await f.view.collapseAll();
  f.setFile('A.md'); await f.view.render();
  assert.equal(folded(f.view, 'Parent'), true);
  assert.equal(folded(f.view, 'Child'), false);

  const reloaded = await setup(f.store);
  assert.equal(folded(reloaded.view, 'Parent'), true);
  assert.equal(folded(reloaded.view, 'Child'), false);
  reloaded.setFile('B.md'); await reloaded.view.render();
  assert.equal(folded(reloaded.view, 'Parent'), true);
  assert.equal(folded(reloaded.view, 'Child'), true);
});

test('expand-all persists an explicitly expanded tree, including default-folded branches', async () => {
  const f = await setup();
  await f.view.expandAll();
  const reloaded = await setup(f.store);
  assert.equal(reloaded.view.collapsed.size, 0);
  await reloaded.view.collapseAll();
  const closed = await setup(f.store);
  assert.equal(folded(closed.view, 'Parent'), true);
  assert.equal(folded(closed.view, 'Child'), true);
});

test('inserting lines or changing label display limits does not move saved folding to another node', async () => {
  const f = await setup();
  const source = '# A very long parent heading for the folding test\n## Child\n1. Item';
  f.setFile('A.md', source); await f.view.render();
  await f.view.toggleNode(f.view.lastNodes[0]);
  const key = f.view.lastNodes[0].foldKey;
  f.plugin.settings.maxItemLength = 20;
  f.setFile('A.md', '\n\n' + source); await f.view.render();
  assert.equal(f.view.lastNodes[0].line, 2);
  assert.equal(f.view.lastNodes[0].foldKey, key);
  assert.equal(f.view.collapsed.has(f.view.lastNodes[0].id), true);
});

test('identical sibling headings keep separate fold states; list renumbering keeps identity', async () => {
  const f = await setup();
  f.setFile('A.md', '# Same\n1. First\n# Same\n1. Second'); await f.view.render();
  const headings = f.view.lastNodes.filter(n => n.type === 'heading');
  assert.notEqual(headings[0].foldKey, headings[1].foldKey);
  await f.view.toggleNode(headings[1]);
  await f.view.render();
  assert.equal(f.view.collapsed.has(headings[0].id), false);
  assert.equal(f.view.collapsed.has(headings[1].id), true);

  f.setFile('A.md', '1. Parent\n    1. Child'); await f.view.render();
  await f.view.collapseAll();
  const key = f.view.lastNodes[0].foldKey;
  f.setFile('A.md', '8. Parent\n    3. Child'); await f.view.render();
  assert.equal(f.view.lastNodes[0].foldKey, key);
  assert.equal(f.view.collapsed.has(f.view.lastNodes[0].id), true);
});

for (const mode of ['cursor', 'scroll', 'both']) {
  test(`${mode} follow never overwrites remembered manual folding`, async () => {
    const f = await setup();
    await f.view.toggleNode(node(f.view, 'Parent'));
    const saved = JSON.stringify(f.plugin.foldStateByFile);
    f.plugin.settings.outlineMode = mode;
    f.plugin.activeScrollPath = { filePath: 'A.md', line: 2, source: mode === 'scroll' ? 'scroll' : 'cursor' };
    f.plugin.scrollSyncVersion++;
    await f.view.render();
    assert.equal(folded(f.view, 'Parent'), false);
    await f.view.expandAll();
    assert.equal(JSON.stringify(f.plugin.foldStateByFile), saved);
    f.plugin.settings.outlineMode = 'remember';
    await f.view.render();
    assert.equal(folded(f.view, 'Parent'), true);
  });
}

test('remember mode suppresses both cursor and scroll following', async () => {
  const f = await setup();
  f.plugin.scheduleCursorSync(f.markdown, 2);
  f.plugin.scheduleScrollSync(0);
  await f.plugin.updateActiveOutlineFromScroll();
  await Promise.resolve();
  assert.equal(f.plugin.activeScrollPath, null);
  assert.equal(f.plugin.scrollTimer, null);
});

for (const target of ['remember', 'scroll']) {
  test(`queued cursor work is cancelled when switching to ${target} mode`, async () => {
    const f = await setup({ data: { outlineMode: 'cursor' } });
    f.plugin.scheduleCursorSync(f.markdown, 2);
    f.plugin.settings.outlineMode = target;
    await f.plugin.saveSettings();
    assert.notEqual(f.plugin.activeScrollPath?.source, 'cursor');
    if (f.plugin.scrollTimer) clearTimeout(f.plugin.scrollTimer);
  });
}

for (const target of ['remember', 'cursor']) {
  test(`switching to ${target} mode stops scroll work before a slow settings write`, async () => {
    const f = await setup({ data: { outlineMode: 'scroll' } });
    const removed = [];
    const handler = () => {};
    f.plugin.scrollSourceEl = { removeEventListener: (...args) => removed.push(args) };
    f.plugin.scrollHandler = handler;
    f.plugin.scrollTimer = setTimeout(() => assert.fail('disabled scroll task ran'), 20);
    f.plugin.activeScrollPath = { filePath: 'A.md', line: 1, source: 'scroll' };
    let release;
    f.store.write = () => new Promise(resolve => { release = resolve; });
    f.plugin.settings.outlineMode = target;
    const pending = f.plugin.saveSettings();
    assert.equal(f.plugin.scrollTimer, null);
    assert.equal(f.plugin.scrollSourceEl, null);
    assert.equal(removed.length, 1);
    assert.equal(removed[0][0], 'scroll');
    assert.equal(removed[0][1], handler);
    assert.equal(f.plugin.activeScrollPath, null);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(typeof release, 'function');
    release();
    await pending;
    assert.notEqual(f.plugin.activeScrollPath?.source, 'scroll');
  });
}

for (const mode of ['remember', 'cursor', 'scroll', 'both']) {
  test(`${mode} mode follows only its selected event sources`, async () => {
    const f = await setup({ data: { outlineMode: mode } });
    f.plugin.scheduleCursorSync(f.markdown, 2);
    await Promise.resolve();
    assert.equal(f.plugin.activeScrollPath?.source === 'cursor', ['cursor', 'both'].includes(mode));
    f.plugin.activeScrollPath = null;
    f.plugin.suppressScrollSyncUntil = 0;
    f.markdown.getMode = () => 'preview';
    f.markdown.getEphemeralState = () => ({ scroll: 2 });
    await f.plugin.updateActiveOutlineFromScroll();
    assert.equal(f.plugin.activeScrollPath?.source === 'scroll', ['scroll', 'both'].includes(mode));
  });
}

test('fold writes are serialized so slow older saves cannot replace the latest choice', async () => {
  const f = await setup();
  let release;
  let writes = 0;
  f.store.write = async () => {
    writes++;
    if (writes === 1) await new Promise(resolve => { release = resolve; });
  };
  const first = f.view.toggleNode(node(f.view, 'Parent'));
  await Promise.resolve(); await Promise.resolve();
  const second = f.view.toggleNode(node(f.view, 'Parent'));
  assert.equal(writes, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  const reloaded = await setup(f.store);
  assert.equal(folded(reloaded.view, 'Parent'), false);
});

test('renaming and deleting a note moves and cleans its remembered state', async () => {
  const f = await setup();
  await f.view.collapseAll();
  f.events.rename({ path: 'Renamed.md' }, 'A.md');
  await f.plugin.dataSavePromise;
  assert.equal(f.store.data.foldStateByFile['A.md'], undefined);
  assert.ok(f.store.data.foldStateByFile['Renamed.md']);
  f.setFile('Renamed.md'); await f.view.render();
  assert.equal(folded(f.view, 'Parent'), true);
  f.events.delete({ path: 'Renamed.md' });
  await f.plugin.dataSavePromise;
  assert.equal(f.store.data.foldStateByFile['Renamed.md'], undefined);
});

test('saved fold identities do not contain note text', async () => {
  const f = await setup();
  f.setFile('A.md', '# Private heading text\n1. Private list text'); await f.view.render();
  await f.view.collapseAll();
  const persisted = JSON.stringify(f.store.data.foldStateByFile);
  assert.equal(persisted.includes('Private'), false);
  assert.equal(persisted.includes('heading text'), false);
});

test('folder rename and deletion migrate descendant notes without matching sibling prefixes', async () => {
  const f = await setup();
  for (const file of ['Notes/A.md', 'Notes/Nested/B.md', 'Notes2/C.md']) {
    f.setFile(file); await f.view.render(); await f.view.collapseAll();
  }
  f.events.rename({ path: 'Archive' }, 'Notes');
  await f.plugin.dataSavePromise;
  assert.equal(f.store.data.foldStateByFile['Notes/A.md'], undefined);
  assert.ok(f.store.data.foldStateByFile['Archive/A.md']);
  assert.ok(f.store.data.foldStateByFile['Archive/Nested/B.md']);
  assert.ok(f.store.data.foldStateByFile['Notes2/C.md']);
  f.events.delete({ path: 'Archive' });
  await f.plugin.dataSavePromise;
  assert.equal(f.store.data.foldStateByFile['Archive/A.md'], undefined);
  assert.equal(f.store.data.foldStateByFile['Archive/Nested/B.md'], undefined);
  assert.ok(f.store.data.foldStateByFile['Notes2/C.md']);
});

test('a click immediately after rename saves to the new file without resurrecting the old path', async () => {
  const f = await setup();
  await f.view.collapseAll();
  const parent = node(f.view, 'Parent');
  f.setFile('Renamed.md');
  f.events.rename({ path: 'Renamed.md' }, 'A.md');
  await f.view.expandNode(parent);
  assert.equal(folded(f.view, 'Parent'), false);
  assert.equal(f.store.data.foldStateByFile['A.md'], undefined);
  assert.ok(f.store.data.foldStateByFile['Renamed.md']);
});

test('a stale click after deletion cannot recreate deleted fold preferences', async () => {
  const f = await setup();
  await f.view.collapseAll();
  const parent = node(f.view, 'Parent');
  f.events.delete({ path: 'A.md' });
  await f.view.expandNode(parent);
  await f.plugin.dataSavePromise;
  assert.equal(f.store.data.foldStateByFile['A.md'], undefined);
});

test('temporarily hidden branches keep their explicit manual expansion preferences', async () => {
  const f = await setup();
  await f.view.expandAll();
  f.plugin.settings.showOrderedLists = false;
  await f.view.render();
  await f.view.collapseAll();
  f.plugin.settings.showOrderedLists = true;
  await f.view.render();
  assert.equal(folded(f.view, 'Child'), false);
});

test('reading-view automatic follow uses the public preview position, never the hidden editor', async () => {
  const f = await setup({ data: { outlineMode: 'scroll' } });
  f.markdown.getMode = () => 'preview';
  f.markdown.getEphemeralState = () => ({ scroll: 49.75 });
  f.markdown.editor.getScrollInfo = () => assert.fail('Reading view must not use hidden editor scroll');
  await f.plugin.updateActiveOutlineFromScroll();
  assert.equal(f.plugin.activeScrollPath.line, 49);
  assert.equal(f.plugin.activeScrollPath.source, 'scroll');
});

test('legacy settings keep automatic follow; malformed state is ignored safely', async () => {
  const f = await setup({ data: { autoSyncToScroll: true, outlineBehavior: 'invalid', foldStateByFile: { 'A.md': null, 'B.md': { ok: true, invalid: 'true' } } } });
  assert.equal(f.plugin.settings.outlineMode, 'both');
  assert.equal(Object.hasOwn(f.plugin.settings, 'outlineBehavior'), false);
  assert.equal(Object.hasOwn(f.plugin.settings, 'autoSyncToScroll'), false);
  assert.equal(Object.hasOwn(f.plugin.settings, 'autoSyncToCursor'), false);
  assert.equal(f.plugin.foldStateByFile['A.md'], undefined);
  assert.equal(f.plugin.foldStateByFile['B.md'].ok, true);
  assert.equal(f.plugin.foldStateByFile['B.md'].invalid, undefined);
});

test('an older asynchronous render cannot replace a newer file', async () => {
  const f = await setup();
  let release;
  f.plugin.getOutlineSource = () => new Promise(resolve => { release = resolve; });
  const first = f.view.render();
  f.plugin.getOutlineSource = async () => ({ file: { path: 'B.md', basename: 'B' }, source: '# New\n1. Item' });
  await f.view.render();
  release({ file: { path: 'A.md', basename: 'A' }, source: '# Old\n1. Item' });
  await first;
  assert.equal(f.view.lastRenderedFilePath, 'B.md');
  assert.equal(f.view.lastNodes[0].title, 'New');
});
