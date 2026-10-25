const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup(data = {}) {
  const controls = [];
  const commands = [];
  const saved = [];
  const notices = [];
  let shown = true;
  const containerEl = {
    isShown: () => shown,
    isConnected: true,
    offsetParent: {},
    style: {},
    empty() { controls.length = 0; },
  };
  class Plugin {
    async loadData() { return structuredClone(data); }
    async saveData(value) { saved.push(structuredClone(value)); }
    registerEditorExtension() {}
    registerMarkdownPostProcessor() {}
    registerView() {}
    addRibbonIcon() { return { addClass() {} }; }
    addCommand(command) { commands.push(command); }
    addSettingTab(tab) { this.testSettingsTab = tab; }
    registerEvent() {}
  }
  class PluginSettingTab {
    constructor() { this.containerEl = containerEl; }
  }
  class Setting {
    constructor() { this.control = {}; controls.push(this.control); }
    setName(name) { this.control.name = name; return this; }
    setDesc(description) { this.control.description = description; return this; }
    addDropdown(callback) { return this.addControl('dropdown', callback); }
    addToggle(callback) { return this.addControl('toggle', callback); }
    addText(callback) { return this.addControl('text', callback); }
    addControl(type, callback) {
      const record = this.control;
      record.type = type;
      record.options = {};
      const component = {
        addOption(key, label) { record.options[key] = label; return this; },
        addOptions(options) { Object.assign(record.options, options); return this; },
        setValue(value) { record.value = value; return this; },
        setDisabled(value) { record.disabled = value; return this; },
        setPlaceholder(value) { record.placeholder = value; return this; },
        onChange(callback) {
          // Obsidian updates the select element before dispatching onChange.
          record.change = async value => { record.value = value; await callback(value); };
          return this;
        },
      };
      callback(component);
      return this;
    }
  }
  const context = {
    module: { exports: {} }, window: { clearTimeout, setTimeout }, console,
    require(name) {
      if (name === '@codemirror/view') return { EditorView: { updateListener: { of: listener => listener } } };
      assert.equal(name, 'obsidian');
      return {
        Plugin, PluginSettingTab, Setting, MarkdownView: class {}, ItemView: class {},
        Notice: class { constructor(message) { notices.push(message); } },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  const plugin = new context.module.exports();
  plugin.app = {
    workspace: {
      on() {}, onLayoutReady() {}, getActiveViewOfType: () => null,
      getLeavesOfType: () => [], detachLeavesOfType() {},
    },
    vault: { on() {} },
  };
  plugin.manifest = { id: 'mixed-outline' };
  await plugin.onload();
  plugin.testSettingsTab.id = 'mixed-outline';
  plugin.app.setting = { activeTab: plugin.testSettingsTab };
  return { plugin, controls, commands, saved, notices, containerEl,
    setShown(value) { shown = value; },
  };
}

function assertNoLegacyFields(settings) {
  for (const field of ['outlineBehavior', 'autoSyncToCursor', 'autoSyncToScroll']) {
    assert.equal(Object.hasOwn(settings, field), false, `legacy ${field} should be removed`);
  }
}

test('new installs default to remembered manual folding with one canonical mode field', async () => {
  const f = await setup();
  assert.equal(f.plugin.settings.outlineMode, 'remember');
  assertNoLegacyFields(f.plugin.settings);
  assert.equal(f.plugin.followsCursor(), false);
  assert.equal(f.plugin.followsScroll(), false);
  assert.equal(f.plugin.isFollowingOutline(), false);
});

for (const mode of ['remember', 'cursor', 'scroll', 'both']) {
  test(`valid ${mode} mode wins over contradictory legacy settings`, async () => {
    const f = await setup({ outlineMode: mode, outlineBehavior: 'remember', autoSyncToCursor: false, autoSyncToScroll: true });
    assert.equal(f.plugin.settings.outlineMode, mode);
    assert.equal(f.plugin.isFollowingOutline(), mode !== 'remember');
    assert.equal(f.plugin.followsCursor(), ['cursor', 'both'].includes(mode));
    assert.equal(f.plugin.followsScroll(), ['scroll', 'both'].includes(mode));
    assertNoLegacyFields(f.plugin.settings);
    await f.plugin.saveSettings();
    assert.equal(f.saved.at(-1).outlineMode, mode);
    assertNoLegacyFields(f.saved.at(-1));
  });
}

for (const [cursor, scroll, expected] of [
  [true, false, 'cursor'], [false, true, 'scroll'],
  [true, true, 'both'], [false, false, 'remember'],
]) {
  for (const behavior of [undefined, 'follow', 'invalid']) {
    test(`legacy ${String(behavior)} + cursor=${cursor}, scroll=${scroll} migrates to ${expected}`, async () => {
      const f = await setup({ outlineBehavior: behavior, autoSyncToCursor: cursor, autoSyncToScroll: scroll });
      assert.equal(f.plugin.settings.outlineMode, expected);
      assertNoLegacyFields(f.plugin.settings);
    });
  }
}

test('legacy remember mode takes precedence over enabled old follow toggles', async () => {
  const f = await setup({ outlineBehavior: 'remember', autoSyncToCursor: true, autoSyncToScroll: true });
  assert.equal(f.plugin.settings.outlineMode, 'remember');
});

for (const invalid of [null, '', 'follow', 'invalid', 4, false]) {
  test(`invalid new mode ${String(invalid)} falls back to legacy migration`, async () => {
    const f = await setup({ outlineMode: invalid, autoSyncToCursor: false, autoSyncToScroll: true });
    assert.equal(f.plugin.settings.outlineMode, 'scroll');
    assertNoLegacyFields(f.plugin.settings);
  });
}

test('missing or malformed old booleans use their historical defaults', async () => {
  for (const data of [
    { outlineBehavior: 'follow' }, { autoSyncToCursor: null, autoSyncToScroll: null },
    { autoSyncToCursor: 'false', autoSyncToScroll: 'true' },
  ]) {
    const f = await setup(data);
    assert.equal(f.plugin.settings.outlineMode, 'cursor');
  }
  const scroll = await setup({ autoSyncToScroll: true });
  assert.equal(scroll.plugin.settings.outlineMode, 'both');
  const noCursor = await setup({ autoSyncToCursor: false });
  assert.equal(noCursor.plugin.settings.outlineMode, 'remember');
});

test('invalid new mode without legacy fields falls back to the manual default', async () => {
  const f = await setup({ outlineMode: 'invalid' });
  assert.equal(f.plugin.settings.outlineMode, 'remember');
});

test('migration preserves unrelated settings and existing manual fold records', async () => {
  const folds = { 'A.md': { 'opaque-key': true, 'other-key': false } };
  const f = await setup({ outlineBehavior: 'remember', foldStateByFile: folds, showHeadings: false, maxItemLength: 83 });
  await f.plugin.saveSettings();
  assert.equal(f.saved.at(-1).showHeadings, false);
  assert.equal(f.saved.at(-1).maxItemLength, 83);
  assert.deepEqual(f.saved.at(-1).foldStateByFile, folds);
});

test('settings expose a single outline mode dropdown with all four choices', async () => {
  const f = await setup();
  f.plugin.testSettingsTab.display();
  const dropdowns = f.controls.filter(control => control.type === 'dropdown');
  assert.equal(dropdowns.length, 1);
  assert.match(dropdowns[0].name, /Outline mode/);
  assert.match(dropdowns[0].name, /大纲模式/);
  assert.deepEqual(Object.keys(dropdowns[0].options).sort(), ['both', 'cursor', 'remember', 'scroll']);
  assert.equal(dropdowns[0].value, 'remember');
  assert.equal(f.controls.some(control => /Outline behavior|大纲行为|Follow cursor|跟随光标|Auto sync to scroll position/.test(control.name)), false);
});

test('each dropdown choice saves the mode and keeps the rendered selection current', async () => {
  const f = await setup();
  f.plugin.testSettingsTab.display();
  for (const mode of ['cursor', 'scroll', 'both', 'remember']) {
    const dropdown = f.controls.find(control => control.type === 'dropdown');
    await dropdown.change(mode);
    assert.equal(f.plugin.settings.outlineMode, mode);
    assert.equal(f.saved.at(-1).outlineMode, mode);
    assert.equal(f.controls.find(control => control.type === 'dropdown').value, mode);
  }
});

for (const [initial, expected] of [
  ['remember', 'scroll'], ['scroll', 'remember'],
  ['cursor', 'both'], ['both', 'cursor'],
]) {
  test(`existing scroll toggle command maps ${initial} to ${expected} and refreshes open settings`, async () => {
    const f = await setup({ outlineMode: initial });
    f.plugin.testSettingsTab.display();
    const command = f.commands.find(command => command.id === 'toggle-auto-sync-to-scroll');
    assert.ok(command, 'the previous command ID must remain available for existing shortcuts');
    const before = f.controls.find(control => control.type === 'dropdown');
    assert.equal(before.value, initial);
    f.plugin.activeScrollPath = { filePath: 'A.md', line: 5, source: initial === 'cursor' ? 'cursor' : 'scroll' };
    await command.callback();
    assert.equal(f.plugin.settings.outlineMode, expected);
    assert.equal(f.saved.at(-1).outlineMode, expected);
    assert.equal(f.controls.find(control => control.type === 'dropdown').value, expected);
    assert.equal(f.plugin.activeScrollPath, null);
    assertNoLegacyFields(f.saved.at(-1));
  });
}

test('changing this plugin settings does not redraw another active settings tab', async () => {
  const f = await setup({ outlineMode: 'cursor' });
  f.plugin.app.setting.activeTab = { plugin: {}, display() { assert.fail('unrelated settings tab was redrawn'); } };
  await f.plugin.toggleAutoSyncToScroll();
  assert.equal(f.plugin.settings.outlineMode, 'both');
  assert.equal(f.saved.at(-1).outlineMode, 'both');
});

test('rapid scroll shortcut presses persist the latest mode and show it in open settings', async () => {
  const f = await setup({ outlineMode: 'cursor' });
  f.plugin.testSettingsTab.display();
  await Promise.all([f.plugin.toggleAutoSyncToScroll(), f.plugin.toggleAutoSyncToScroll()]);
  assert.equal(f.plugin.settings.outlineMode, 'cursor');
  assert.equal(f.saved.at(-1).outlineMode, 'cursor');
  assert.equal(f.controls.find(control => control.type === 'dropdown').value, 'cursor');
});
