const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class EventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = {}) {
    for (const listener of [...this.listeners.get(type) ?? []]) listener({ type, ...event });
  }
  countListeners() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

class Element extends EventTarget {
  constructor(tagName = 'div', classes = '', ownerDocument) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.classes = new Set(classes.split(/\s+/).filter(Boolean));
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.style = {};
    this.isConnected = true;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
  }
  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  hasClass(cls) { return this.classes.has(cls); }
  contains(node) {
    for (let current = node; current; current = current.parentElement ?? current.parentNode) if (current === this) return true;
    return false;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim();
      const tag = simple.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      for (const [, cls] of simple.matchAll(/\.([\w-]+)/g)) if (!this.classes.has(cls)) return false;
      for (const [, attr, value] of simple.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!this.attributes.has(attr) || (value != null && this.getAttribute(attr) !== value)) return false;
      }
      return true;
    });
  }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.nodeType !== 1) continue;
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

const fixtures = [];
afterEach(() => {
  for (const plugin of fixtures.splice(0)) plugin.onunload();
});

async function setup(mode = 'cursor') {
  class MarkdownView {}
  class Plugin {
    async loadData() { return { outlineMode: mode }; }
    async saveData() {}
    registerEditorExtension() {}
    registerMarkdownPostProcessor(processor) { this.postProcessors.push(processor); }
    registerView() {}
    addRibbonIcon() { return { addClass() {} }; }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
  }
  const context = {
    module: { exports: {} }, console, window: { clearTimeout, setTimeout },
    Element, HTMLElement: Element, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    require(name) {
      if (name === '@codemirror/view') return { EditorView: { updateListener: { of: fn => fn } } };
      assert.equal(name, 'obsidian');
      return { Plugin, MarkdownView, ItemView: class {}, PluginSettingTab: class {}, Notice: class {} };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  plugin.postProcessors = [];
  const document = new EventTarget();
  let selection = null;
  document.getSelection = () => selection;
  document.defaultView = { getSelection: () => selection };
  const contentEl = new Element('div', 'view-content', document);
  const root = contentEl.appendChild(new Element('div', 'markdown-preview-view', document));
  const calls = { edits: 0, editorMoves: 0, renders: 0 };
  const file = { path: 'Reading.md' };
  const files = new Map([[file.path, file]]);
  const events = {};
  const view = Object.assign(new MarkdownView(), {
    file, contentEl, previewMode: { containerEl: root },
    getMode: () => 'preview', getEphemeralState: () => ({ scroll: 50 }),
    editor: {
      getValue: () => '# Note', getCursor: () => ({ line: 0, ch: 0 }),
      setCursor() { calls.editorMoves++; }, scrollIntoView() { calls.editorMoves++; }, focus() { calls.editorMoves++; },
      replaceRange() { calls.edits++; }, setValue() { calls.edits++; },
    },
  });
  plugin.app = {
    workspace: {
      on() {}, onLayoutReady() {}, detachLeavesOfType() {},
      getActiveViewOfType: () => view,
      getLeavesOfType: type => type === 'markdown' ? [{ view }] : [],
    },
    vault: {
      on(name, callback) { events[name] = callback; },
      getAbstractFileByPath: path => files.get(path) ?? null,
    },
  };
  await plugin.onload();
  plugin.refreshViews = async () => { calls.renders++; };
  fixtures.push(plugin);
  const element = (tag = 'div', cls = '', parent = root) => parent.appendChild(new Element(tag, cls, document));
  const text = parent => parent.appendChild({ nodeType: 3, textContent: 'Reading text' });
  const mark = (section, info, sourcePath = view.file.path) => {
    const ctx = { sourcePath, getSectionInfo(target) { assert.equal(target, section); return info; } };
    for (const processor of plugin.postProcessors) processor(section, ctx);
    return ctx;
  };
  return { plugin, view, file, files, events, root, contentEl, document, calls, element, text, mark,
    select(focusNode, anchorNode = focusNode, isCollapsed = false) {
      selection = { focusNode, anchorNode, isCollapsed, rangeCount: 1, focusOffset: 0, anchorOffset: 0 };
    },
    clearSelection() { selection = null; },
    rename(newPath) {
      const oldPath = file.path;
      files.delete(oldPath);
      file.path = newPath;
      files.set(newPath, file);
      events.rename(file, oldPath);
    },
  };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('reading sections resolve restarted list data-line markers to document lines', async () => {
  const f = await setup();
  const first = f.element();
  const firstItem = f.element('li', '', first); firstItem.setAttribute('data-line', '3');
  f.mark(first, { text: 'Full document source', lineStart: 8, lineEnd: 18 });
  const second = f.element();
  const secondItem = f.element('li', '', second); secondItem.setAttribute('data-line', '3');
  f.mark(second, { text: 'Full document source', lineStart: 50, lineEnd: 65 });
  assert.equal(f.plugin.getReadingLine(f.view, firstItem), 11);
  assert.equal(f.plugin.getReadingLine(f.view, secondItem), 53);
});

test('nested list marker offsets are added once, using the innermost clicked item', async () => {
  const f = await setup();
  const section = f.element();
  const parent = f.element('li', '', section); parent.setAttribute('data-line', '1');
  const child = f.element('li', '', parent); child.setAttribute('data-line', '5');
  const label = f.text(f.element('strong', '', child));
  f.mark(section, { lineStart: 30, lineEnd: 40 });
  assert.equal(f.plugin.getReadingLine(f.view, label), 35);
});

test('headings and paragraphs without local line markers use their absolute section start', async () => {
  const f = await setup();
  for (const tag of ['h2', 'p']) {
    const section = f.element();
    const text = f.text(f.element(tag, '', section));
    f.mark(section, { lineStart: 72, lineEnd: 76 });
    assert.equal(f.plugin.getReadingLine(f.view, text), 72);
  }
});

test('reading section bounds are obtained at event time after surrounding text changes', async () => {
  const f = await setup();
  const section = f.element();
  const item = f.element('li', '', section); item.setAttribute('data-line', '2');
  const info = { lineStart: 20, lineEnd: 30 };
  f.mark(section, info);
  assert.equal(f.plugin.getReadingLine(f.view, item), 22);
  info.lineStart = 25; info.lineEnd = 35;
  assert.equal(f.plugin.getReadingLine(f.view, item), 27);
});

test('renaming a note preserves processed section identity and rebinds reading listeners', async () => {
  const f = await setup();
  const section = f.element();
  const item = f.element('li', '', section); item.setAttribute('data-line', '2');
  f.mark(section, { lineStart: 30, lineEnd: 40 });
  f.plugin.syncReadingListener();
  const handler = f.plugin.readingHandler;
  f.rename('Renamed.md');
  // Existing DOM and contexts retain their old sourcePath string; the live
  // vault file object carries the new path without another postprocessor run.
  assert.equal(f.plugin.getReadingLine(f.view, item), 32);
  assert.notEqual(f.plugin.readingHandler, handler);
  assert.equal(f.root.listeners.get('pointerup').size, 1);
  assert.equal(f.document.listeners.get('selectionchange').size, 1);
  f.root.dispatch('pointerup', { button: 0, target: item });
  await flush();
  assert.equal(f.plugin.activeScrollPath.filePath, 'Renamed.md');
  assert.equal(f.plugin.activeScrollPath.line, 32);
});

test('renaming cancels pending reading work until a new interaction uses the new path', async () => {
  const f = await setup();
  f.plugin.scheduleReadingSync(f.view, 31);
  f.rename('Renamed.md');
  await flush();
  assert.equal(f.plugin.activeScrollPath, null);
  assert.equal(f.calls.renders, 0);
});

test('deleting a note invalidates a queued reading update from its old DOM', async () => {
  const f = await setup();
  f.plugin.scheduleReadingSync(f.view, 31);
  f.files.delete(f.file.path);
  f.events.delete(f.file);
  await flush();
  assert.equal(f.plugin.activeScrollPath, null);
  assert.equal(f.calls.renders, 0);
});

test('recreating the same file path cannot apply queued selection from the deleted file', async () => {
  const f = await setup();
  f.plugin.scheduleReadingSync(f.view, 31);
  f.files.set(f.file.path, { path: f.file.path });
  await flush();
  assert.equal(f.plugin.activeScrollPath, null);
  assert.equal(f.calls.renders, 0);
});

test('old rendered sections cannot select a replacement note at the same path', async () => {
  const f = await setup();
  const section = f.element();
  const item = f.element('li', '', section); item.setAttribute('data-line', '2');
  f.mark(section, { lineStart: 30, lineEnd: 40 });
  const replacement = { path: f.file.path };
  f.files.set(replacement.path, replacement);
  f.view.file = replacement;
  assert.equal(f.plugin.getReadingLine(f.view, item), null);
  f.plugin.syncReadingListener();
  f.root.dispatch('pointerup', { button: 0, target: item });
  await flush();
  assert.equal(f.plugin.activeScrollPath, null);
  assert.equal(f.calls.renders, 0);
});

test('invalid or out-of-section local list offsets cannot produce a document target', async () => {
  const f = await setup();
  const section = f.element();
  const item = f.element('li', '', section);
  f.mark(section, { lineStart: 30, lineEnd: 40 });
  for (const offset of ['-1', 'bad', '40']) {
    item.setAttribute('data-line', offset);
    assert.equal(f.plugin.getReadingLine(f.view, item), null, offset);
  }
});

test('unregistered, external and unavailable section contexts cannot invent a reading line', async () => {
  const f = await setup();
  const plain = f.element('li'); plain.setAttribute('data-line', '90');
  assert.equal(f.plugin.getReadingLine(f.view, plain), null);
  const unknown = f.element(); f.mark(unknown, null);
  assert.equal(f.plugin.getReadingLine(f.view, unknown), null);
  const external = new Element('div', '', f.document); f.mark(external, { lineStart: 99, lineEnd: 100 });
  assert.equal(f.plugin.getReadingLine(f.view, external), null);
  const unrelated = f.element(); f.mark(unrelated, { lineStart: 12, lineEnd: 15 }, 'Other.md');
  assert.equal(f.plugin.getReadingLine(f.view, unrelated), null);
});

test('embedded notes never drive the outer note outline, including self-embeds', async () => {
  const f = await setup();
  for (const path of ['Other.md', 'Reading.md']) {
    const embed = f.element('div', 'internal-embed markdown-embed');
    const section = f.element('div', '', embed);
    const item = f.element('li', '', section); item.setAttribute('data-line', '1');
    f.mark(section, { lineStart: 40, lineEnd: 44 }, path);
    assert.equal(f.plugin.getReadingLine(f.view, item), null);
  }
});

for (const mode of ['remember', 'cursor', 'scroll', 'both']) {
  test(`${mode} mode follows reading clicks only when cursor following is selected`, async () => {
    const f = await setup(mode);
    const originalFolds = JSON.stringify(f.plugin.foldStateByFile);
    f.plugin.scheduleReadingSync(f.view, 31);
    await flush();
    const enabled = ['cursor', 'both'].includes(mode);
    assert.equal(f.plugin.activeScrollPath?.source === 'cursor', enabled);
    if (enabled) {
      assert.equal(f.plugin.activeScrollPath.line, 31);
      assert.equal(f.plugin.activeScrollPath.filePath, 'Reading.md');
      assert.equal(f.calls.renders, 1);
    } else assert.equal(f.calls.renders, 0);
    assert.equal(f.plugin.settings.outlineMode, mode);
    assert.equal(JSON.stringify(f.plugin.foldStateByFile), originalFolds);
    assert.equal(f.calls.edits, 0);
    assert.equal(f.calls.editorMoves, 0);
  });
}

test('only the latest reading location in an event batch is applied', async () => {
  const f = await setup();
  f.plugin.scheduleReadingSync(f.view, 3);
  f.plugin.scheduleReadingSync(f.view, 9);
  f.plugin.scheduleReadingSync(f.view, 21);
  await flush();
  assert.equal(f.plugin.activeScrollPath.line, 21);
  assert.equal(f.calls.renders, 1);
});

test('mode changes, file switches and unloading cancel queued reading work', async () => {
  for (const reason of ['mode', 'file', 'view', 'active note', 'unload']) {
    const f = await setup();
    f.plugin.scheduleReadingSync(f.view, 31);
    if (reason === 'mode') f.plugin.settings.outlineMode = 'remember';
    if (reason === 'file') f.view.file = { path: 'Other.md' };
    if (reason === 'view') f.view.getMode = () => 'source';
    if (reason === 'active note') f.plugin.app.workspace.getActiveViewOfType = () => ({ file: { path: 'Other.md' } });
    if (reason === 'unload') f.plugin.onunload();
    await flush();
    assert.equal(f.calls.renders, 0, reason);
    assert.equal(f.plugin.activeScrollPath, null, reason);
  }
});

test('reading events use selection focus and support keyboard selection changes', async () => {
  const f = await setup();
  const first = f.element(); f.mark(first, { lineStart: 12, lineEnd: 15 });
  const second = f.element(); f.mark(second, { lineStart: 42, lineEnd: 45 });
  const anchor = f.text(first);
  const focus = f.text(second);
  f.plugin.syncReadingListener();
  f.select(focus, anchor);
  f.document.dispatch('selectionchange', { target: f.document });
  await flush();
  assert.equal(f.plugin.activeScrollPath.line, 42);
  f.select(anchor, focus);
  // Native keyboard selection changes emit selectionchange before keyup.
  f.document.dispatch('selectionchange', { target: f.document });
  await flush();
  assert.equal(f.plugin.activeScrollPath.line, 12);
});

test('pointer events follow their actual text target without an existing selection', async () => {
  const f = await setup();
  const section = f.element(); f.mark(section, { lineStart: 55, lineEnd: 57 });
  const target = f.element('p', '', section);
  f.plugin.syncReadingListener();
  f.clearSelection();
  f.root.dispatch('pointerup', { button: 0, target });
  await flush();
  assert.equal(f.plugin.activeScrollPath.line, 55);
});

test('preview controls and selections outside the active note do not change the outline', async () => {
  const f = await setup();
  const section = f.element(); f.mark(section, { lineStart: 55, lineEnd: 57 });
  f.select(f.text(f.element('p', '', section)));
  f.plugin.syncReadingListener();
  for (const [tag, cls] of [['input', 'task-list-item-checkbox'], ['button', ''], ['div', 'collapse-indicator']]) {
    f.root.dispatch('pointerup', { button: 0, target: f.element(tag, cls, section) });
    await flush();
    assert.equal(f.plugin.activeScrollPath, null);
  }
  f.select({ nodeType: 3, parentElement: new Element('div', '', f.document) });
  f.document.dispatch('selectionchange', { target: f.document });
  await flush();
  assert.equal(f.plugin.activeScrollPath, null);
});

test('reading clicks win over their incidental scroll events in combined mode', async () => {
  const f = await setup('both');
  f.plugin.scrollTimer = setTimeout(() => assert.fail('stale scroll callback'), 20);
  f.plugin.scheduleReadingSync(f.view, 31);
  await flush();
  assert.equal(f.plugin.scrollTimer, null);
  assert.ok(f.plugin.suppressScrollSyncUntil > Date.now());
  await f.plugin.updateActiveOutlineFromScroll();
  assert.equal(f.plugin.activeScrollPath.source, 'cursor');
  assert.equal(f.plugin.activeScrollPath.line, 31);
});

test('page scrolling with an unchanged text selection keeps scroll following in combined mode', async () => {
  const f = await setup('both');
  const section = f.element(); f.mark(section, { lineStart: 12, lineEnd: 15 });
  const selected = f.text(section);
  f.plugin.syncReadingListener();
  f.select(selected);
  f.document.dispatch('selectionchange', { target: f.document });
  await flush();
  f.plugin.suppressScrollSyncUntil = 0;
  await f.plugin.updateActiveOutlineFromScroll();
  assert.equal(f.plugin.activeScrollPath.source, 'scroll');
  assert.equal(f.plugin.activeScrollPath.line, 50);
  f.root.dispatch('keyup', { key: 'PageDown', target: f.root });
  await flush();
  assert.equal(f.plugin.activeScrollPath.source, 'scroll');
  assert.equal(f.plugin.activeScrollPath.line, 50);
});

test('reading listeners detach when disabled, replaced, switched to source mode or unloaded', async () => {
  const f = await setup();
  f.plugin.syncReadingListener();
  assert.ok(f.root.countListeners() > 0);
  assert.ok(f.document.countListeners() > 0);
  f.plugin.syncReadingListener();
  const selectionListeners = f.document.listeners.get('selectionchange').size;
  assert.equal(selectionListeners, 1, 'resync must not duplicate the document listener');
  f.plugin.settings.outlineMode = 'remember';
  f.plugin.syncReadingListener();
  assert.equal(f.root.countListeners(), 0);
  assert.equal(f.document.countListeners(), 0);
  f.plugin.settings.outlineMode = 'cursor';
  f.plugin.syncReadingListener();
  f.view.getMode = () => 'source';
  f.plugin.syncReadingListener();
  assert.equal(f.root.countListeners(), 0);
  assert.equal(f.document.countListeners(), 0);
  f.view.getMode = () => 'preview';
  f.plugin.syncReadingListener();
  f.plugin.onunload();
  assert.equal(f.root.countListeners(), 0);
  assert.equal(f.document.countListeners(), 0);
});

test('replacing the preview root detaches old listeners and binds to the new root once', async () => {
  const f = await setup();
  f.plugin.syncReadingListener();
  const replacement = f.element('div', 'markdown-preview-view', f.contentEl);
  f.view.previewMode.containerEl = replacement;
  f.plugin.syncReadingListener();
  assert.equal(f.root.countListeners(), 0);
  assert.equal(replacement.listeners.get('pointerup').size, 1);
  assert.equal(replacement.listeners.get('keyup')?.size ?? 0, 0);
  assert.equal(f.document.listeners.get('selectionchange').size, 1);
  f.plugin.onunload();
  assert.equal(replacement.countListeners(), 0);
  assert.equal(f.document.countListeners(), 0);
});
