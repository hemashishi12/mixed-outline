const {
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
} = require("obsidian");

const VIEW_TYPE_MIXED_OUTLINE = "mixed-outline-view";

const DEFAULT_SETTINGS = {
  showHeadings: true,
  showOrderedLists: true,
  stripMarkdownFormatting: true,
  maxItemLength: 160,
  openOnStartup: false,
  autoSyncToScroll: false,
};

class MixedOutlinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.currentFile = null;
    this.pendingEditorText = null;
    this.refreshTimer = null;
    this.scrollTimer = null;
    this.scrollSourceEl = null;
    this.scrollHandler = null;
    this.activeScrollPath = null;
    this.scrollSyncVersion = 0;
    this.suppressScrollSyncUntil = 0;

    this.registerView(
      VIEW_TYPE_MIXED_OUTLINE,
      (leaf) => new MixedOutlineView(leaf, this)
    );

    const ribbonButton = this.addRibbonIcon("list-tree", "Open Mixed Outline", () => {
      this.activateView(true);
    });
    ribbonButton.addClass("mixed-outline-ribbon-button");

    this.addCommand({
      id: "open-mixed-outline",
      name: "Open mixed outline",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "refresh-mixed-outline",
      name: "Refresh mixed outline",
      callback: () => this.refreshViews(),
    });

    this.addCommand({
      id: "toggle-auto-sync-to-scroll",
      name: "Toggle auto sync outline to scroll position",
      callback: () => this.toggleAutoSyncToScroll(),
    });

    this.addSettingTab(new MixedOutlineSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) {
          return;
        }

        this.currentFile = view.file;
        this.pendingEditorText = editor.getValue();
        this.scheduleRefresh();
        this.scheduleScrollSync();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (isMarkdownFile(file)) {
          this.currentFile = file;
          this.pendingEditorText = null;
          this.scheduleRefresh();
          this.syncScrollListener();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (!(view instanceof MarkdownView) || !view.file) {
          return;
        }

        this.currentFile = view.file;
        this.pendingEditorText = view.editor.getValue();
        this.scheduleRefresh();
        this.syncScrollListener();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!isMarkdownFile(file) || file.path !== this.currentFile?.path) {
          return;
        }

        this.pendingEditorText = null;
        this.scheduleRefresh();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncScrollListener();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.captureCurrentMarkdownFile();
      this.syncScrollListener();
      if (this.settings.openOnStartup) {
        this.activateView(false);
      } else {
        this.refreshViews();
      }
    });
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.scrollTimer) {
      window.clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }

    this.detachScrollListener();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MIXED_OUTLINE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncScrollListener();
    await this.refreshViews();
  }

  async toggleAutoSyncToScroll() {
    this.settings.autoSyncToScroll = !this.settings.autoSyncToScroll;
    await this.saveSettings();
    if (this.settings.autoSyncToScroll) {
      this.scheduleScrollSync(0);
    } else {
      this.activeScrollPath = null;
    }
    new Notice(
      `Mixed Outline: auto sync to scroll ${
        this.settings.autoSyncToScroll ? "enabled" : "disabled"
      }`
    );
  }

  captureCurrentMarkdownFile() {
    const view = this.getCurrentMarkdownView();
    if (!view?.file) {
      return;
    }

    this.currentFile = view.file;
    this.pendingEditorText = view.editor.getValue();
  }

  getCurrentMarkdownView() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file) {
      return activeView;
    }

    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    const matchingLeaf = markdownLeaves.find((leaf) => {
      const view = leaf.view;
      return (
        view instanceof MarkdownView &&
        view.file?.path === this.currentFile?.path
      );
    });

    if (matchingLeaf?.view instanceof MarkdownView) {
      return matchingLeaf.view;
    }

    const firstMarkdownLeaf = markdownLeaves.find(
      (leaf) => leaf.view instanceof MarkdownView && leaf.view.file
    );

    return firstMarkdownLeaf?.view ?? null;
  }

  async getOutlineSource() {
    const view = this.getCurrentMarkdownView();
    if (view?.file) {
      this.currentFile = view.file;
      this.pendingEditorText = view.editor.getValue();
      return {
        file: view.file,
        source: this.pendingEditorText,
      };
    }

    if (this.currentFile) {
      return {
        file: this.currentFile,
        source: await this.app.vault.cachedRead(this.currentFile),
      };
    }

    return {
      file: null,
      source: "",
    };
  }

  scheduleRefresh(delay = 80) {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews();
    }, delay);
  }

  syncScrollListener() {
    this.detachScrollListener();

    if (!this.settings.autoSyncToScroll) {
      return;
    }

    const view = this.getCurrentMarkdownView();
    if (!(view instanceof MarkdownView) || !view.file) {
      return;
    }

    const scrollEl = getMarkdownScrollElement(view);
    if (!scrollEl) {
      return;
    }

    this.scrollSourceEl = scrollEl;
    this.scrollHandler = () => this.scheduleScrollSync();
    scrollEl.addEventListener("scroll", this.scrollHandler, { passive: true });
    this.scheduleScrollSync(0);
  }

  detachScrollListener() {
    if (this.scrollSourceEl && this.scrollHandler) {
      this.scrollSourceEl.removeEventListener("scroll", this.scrollHandler);
    }

    this.scrollSourceEl = null;
    this.scrollHandler = null;
  }

  scheduleScrollSync(delay = 80) {
    if (!this.settings.autoSyncToScroll) {
      return;
    }

    if (this.scrollTimer) {
      window.clearTimeout(this.scrollTimer);
    }

    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      this.updateActiveOutlineFromScroll();
    }, delay);
  }

  suppressScrollSync(duration = 700) {
    this.suppressScrollSyncUntil = Date.now() + duration;
  }

  async updateActiveOutlineFromScroll() {
    if (!this.settings.autoSyncToScroll) {
      return;
    }

    if (Date.now() < this.suppressScrollSyncUntil) {
      return;
    }

    const view = this.getCurrentMarkdownView();
    if (!(view instanceof MarkdownView) || !view.file) {
      return;
    }

    const visibleLine = getCurrentVisibleLine(view);
    if (!Number.isFinite(visibleLine)) {
      return;
    }

    this.currentFile = view.file;
    this.pendingEditorText = view.editor?.getValue?.() ?? this.pendingEditorText;
    this.activeScrollPath = {
      filePath: view.file.path,
      line: Math.max(0, visibleLine),
    };
    this.scrollSyncVersion += 1;

    await this.refreshViews();
  }

  async refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIXED_OUTLINE);
    await Promise.all(
      leaves.map(async (leaf) => {
        if (leaf.view instanceof MixedOutlineView) {
          await leaf.view.render();
        }
      })
    );
  }

  async activateView(reveal = true) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MIXED_OUTLINE)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_MIXED_OUTLINE,
        active: true,
      });
    }

    if (reveal) {
      this.app.workspace.revealLeaf(leaf);
    }

    await this.refreshViews();
  }

  async revealNode(node) {
    const file = this.app.vault.getAbstractFileByPath(node.filePath);
    if (!(file instanceof TFile)) {
      new Notice("Mixed Outline: file not found");
      return;
    }

    let leaf = this.findMarkdownLeaf(file);

    if (!leaf) {
      leaf = this.app.workspace.getMostRecentLeaf?.();
      if (!leaf || leaf.view?.getViewType?.() === VIEW_TYPE_MIXED_OUTLINE) {
        leaf = this.app.workspace.getLeaf("tab");
      }
      await leaf.openFile(file, { active: true });
    } else {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return;
    }

    const pos = { line: node.line, ch: node.ch ?? 0 };
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: pos }, true);
    view.editor.focus();

    this.currentFile = file;
    this.pendingEditorText = view.editor.getValue();
  }

  findMarkdownLeaf(file) {
    return this.app.workspace.getLeavesOfType("markdown").find((leaf) => {
      const view = leaf.view;
      return view instanceof MarkdownView && view.file?.path === file.path;
    });
  }
}

class MixedOutlineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collapsed = new Set();
    this.lastNodes = [];
    this.lastRenderedFilePath = null;
    this.lastAppliedScrollSyncVersion = -1;
  }

  getViewType() {
    return VIEW_TYPE_MIXED_OUTLINE;
  }

  getDisplayText() {
    return "Mixed Outline";
  }

  getIcon() {
    return "list-tree";
  }

  async onOpen() {
    this.contentEl.addClass("mixed-outline-view");
    await this.render();
  }

  async render() {
    const { file, source } = await this.plugin.getOutlineSource();
    const container = this.contentEl;
    const previousTreeEl = container.querySelector(".mixed-outline-tree");
    const previousScrollTop = previousTreeEl?.scrollTop ?? 0;
    const previousFilePath = this.lastRenderedFilePath;

    container.empty();
    container.addClass("mixed-outline-view");

    const toolbar = container.createDiv("mixed-outline-toolbar");
    const titleEl = toolbar.createDiv("mixed-outline-title");
    titleEl.setText(file ? file.basename : "No active Markdown file");

    const actionsEl = toolbar.createDiv("mixed-outline-actions");
    createIconButton(actionsEl, "refresh-cw", "Refresh", () => {
      this.plugin.refreshViews();
    });
    createIconButton(actionsEl, "chevrons-down-up", "Collapse all", () => {
      this.collapseAll();
    });
    createIconButton(actionsEl, "chevrons-up-down", "Expand all", () => {
      this.expandAll();
    });

    if (!file) {
      this.lastRenderedFilePath = null;
      container.createDiv({
        cls: "mixed-outline-empty",
        text: "Open a Markdown file to show its mixed outline.",
      });
      this.lastNodes = [];
      return;
    }

    const root = buildMixedOutlineTree(source, file.path, this.plugin.settings);
    this.lastNodes = flattenTree(root.children);
    const hasScrollSyncForFile =
      this.plugin.settings.autoSyncToScroll &&
      this.plugin.activeScrollPath?.filePath === file.path;
    const shouldSyncToScroll =
      hasScrollSyncForFile &&
      this.lastAppliedScrollSyncVersion !== this.plugin.scrollSyncVersion;

    if (shouldSyncToScroll) {
      this.syncCollapsedToLine(root.children, this.plugin.activeScrollPath.line);
      this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    } else if (!hasScrollSyncForFile) {
      this.activeNodeId = null;
    }

    if (!shouldSyncToScroll && previousFilePath !== file.path) {
      this.collapsed.clear();
      this.collapseNodesWithChildren(this.lastNodes);
    }
    this.lastRenderedFilePath = file.path;

    if (root.children.length === 0) {
      container.createDiv({
        cls: "mixed-outline-empty",
        text: "No headings or list items found.",
      });
      return;
    }

    const treeEl = container.createDiv("mixed-outline-tree");
    for (const child of root.children) {
      this.renderNode(child, treeEl, 0);
    }

    if (shouldSyncToScroll && this.activeNodeId) {
      scrollNodeIntoView(treeEl, this.activeNodeId);
    }

    if (previousFilePath === file.path) {
      restoreScrollTop(treeEl, previousScrollTop);
    }
  }

  renderNode(node, parentEl, depth) {
    const itemEl = parentEl.createDiv("mixed-outline-item");
    itemEl.addClass(`is-${node.type}`);

    const rowEl = itemEl.createDiv("mixed-outline-row");
    rowEl.setAttribute("data-line", String(node.line + 1));
    rowEl.setAttribute("data-node-id", node.id);
    rowEl.style.paddingLeft = `${4 + depth * 14}px`;
    if (node.id === this.activeNodeId) {
      rowEl.addClass("is-active");
    }

    const toggleEl = rowEl.createDiv("mixed-outline-toggle");
    const hasChildren = node.children.length > 0;
    const isCollapsed = this.collapsed.has(node.id);

    if (hasChildren) {
      toggleEl.setAttribute("role", "button");
      toggleEl.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
      setIcon(toggleEl, isCollapsed ? "chevron-right" : "chevron-down");
      toggleEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleNode(node);
      });
    } else {
      toggleEl.addClass("is-placeholder");
    }

    const markerEl = rowEl.createDiv("mixed-outline-marker");
    markerEl.setText(getNodeMarker(node));

    const textEl = rowEl.createDiv("mixed-outline-text");
    textEl.setText(node.title || "(empty)");

    rowEl.addEventListener("click", () => {
      if (hasChildren && this.collapsed.has(node.id)) {
        this.plugin.suppressScrollSync();
        this.expandNode(node);
      }
      this.plugin.revealNode(node);
    });

    if (!hasChildren || isCollapsed) {
      return;
    }

    const childrenEl = itemEl.createDiv("mixed-outline-children");
    for (const child of node.children) {
      this.renderNode(child, childrenEl, depth + 1);
    }
  }

  toggleNode(node) {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;

    if (this.collapsed.has(node.id)) {
      this.collapsed.delete(node.id);
    } else {
      this.collapsed.add(node.id);
    }

    this.render();
  }

  expandNode(node) {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapsed.delete(node.id);
    this.render();
  }

  collapseAll() {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapseNodesWithChildren(this.lastNodes);
    this.render();
  }

  collapseNodesWithChildren(nodes) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        this.collapsed.add(node.id);
      }
    }
  }

  expandAll() {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapsed.clear();
    this.activeNodeId = null;
    this.render();
  }

  syncCollapsedToLine(nodes, line) {
    const activePath = findNodePathForLine(nodes, line);
    const activeNode = activePath[activePath.length - 1] ?? null;
    const expandedIds = new Set(activePath.slice(0, -1).map((node) => node.id));

    this.activeNodeId = activeNode?.id ?? null;
    this.collapsed.clear();

    for (const node of flattenTree(nodes)) {
      if (node.children.length > 0 && !expandedIds.has(node.id)) {
        this.collapsed.add(node.id);
      }
    }
  }
}

class MixedOutlineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show headings")
      .setDesc("Include Markdown headings in the mixed outline.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showHeadings).onChange(async (value) => {
          this.plugin.settings.showHeadings = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show ordered lists")
      .setDesc("Include numbered list items such as 1. and 2.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showOrderedLists).onChange(async (value) => {
          this.plugin.settings.showOrderedLists = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Strip Markdown formatting")
      .setDesc("Display cleaner outline text by hiding common inline Markdown syntax.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stripMarkdownFormatting)
          .onChange(async (value) => {
            this.plugin.settings.stripMarkdownFormatting = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum item length")
      .setDesc("Trim very long outline items.")
      .addText((text) =>
        text
          .setPlaceholder("160")
          .setValue(String(this.plugin.settings.maxItemLength))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxItemLength = Number.isFinite(parsed)
              ? Math.max(20, Math.min(parsed, 500))
              : DEFAULT_SETTINGS.maxItemLength;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open on startup")
      .setDesc("Open the Mixed Outline view when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openOnStartup).onChange(async (value) => {
          this.plugin.settings.openOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto sync to scroll position")
      .setDesc("While browsing a Markdown file, expand only the outline path for the visible position and collapse other branches.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncToScroll)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncToScroll = value;
            if (!value) {
              this.plugin.activeScrollPath = null;
            }
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.scheduleScrollSync(0);
            }
          })
      );
  }
}

function buildMixedOutlineTree(source, filePath, settings) {
  const entries = addDisplayMarkers(
    parseMixedOutlineEntries(source, filePath, settings)
  );
  const root = {
    id: `${filePath}:root`,
    type: "root",
    effectiveLevel: 0,
    children: [],
  };
  const stack = [root];

  for (const entry of entries) {
    while (
      stack.length > 1 &&
      stack[stack.length - 1].effectiveLevel >= entry.effectiveLevel
    ) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    parent.children.push(entry);
    entry.children = [];
    stack.push(entry);
  }

  return root;
}

function parseMixedOutlineEntries(source, filePath, settings) {
  const lines = source.split(/\r\n|\n|\r/);
  const entries = [];
  const headingStack = [];
  const listStack = [];
  const hiddenListStack = [];
  let nextListRunId = 1;
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let inFrontmatter = lines[0]?.trim() === "---";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (inFrontmatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line.trim())) {
        inFrontmatter = false;
      }
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const heading = parseHeading(line, settings);
    if (heading) {
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= heading.level
      ) {
        headingStack.pop();
      }

      headingStack.push({ level: heading.level, line: index });
      listStack.length = 0;
      hiddenListStack.length = 0;
      nextListRunId += 1;

      if (settings.showHeadings) {
        entries.push({
          id: makeNodeId(filePath, "heading", index),
          filePath,
          type: "heading",
          title: heading.title,
          line: index,
          ch: heading.ch,
          headingLevel: heading.level,
          effectiveLevel: heading.level,
          children: [],
        });
      }

      continue;
    }

    const listItem = parseListItem(line, settings);
    if (!listItem) {
      listStack.length = 0;
      hiddenListStack.length = 0;
      nextListRunId += 1;
      continue;
    }

    const indent = getVisualIndent(listItem.indent);
    while (
      hiddenListStack.length > 0 &&
      indent <= hiddenListStack[hiddenListStack.length - 1]
    ) {
      hiddenListStack.pop();
    }

    if (listItem.hidden || hiddenListStack.length > 0) {
      hiddenListStack.push(indent);
      listStack.length = 0;
      nextListRunId += 1;
      continue;
    }

    if (listStack.length === 0 && indent >= 4) {
      continue;
    }

    while (listStack.length > 0 && indent <= listStack[listStack.length - 1].indent) {
      listStack.pop();
    }

    const parentList = listStack[listStack.length - 1];
    const listRunId =
      parentList && indent > parentList.indent ? parentList.runId : nextListRunId;
    listStack.push({ indent, line: index, runId: listRunId });

    const baseHeadingLevel =
      headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0;
    const listNesting = listStack.length - 1;

    entries.push({
      id: makeNodeId(filePath, "list", index),
      filePath,
      type: "list",
      title: listItem.title,
      line: index,
      ch: listItem.ch,
      ordered: listItem.ordered,
      task: listItem.task,
      marker: listItem.marker,
      startNumber: listItem.startNumber,
      listLevel: listNesting + 1,
      listRunId,
      effectiveLevel: baseHeadingLevel + listNesting + 1,
      children: [],
    });
  }

  return entries;
}

function parseHeading(line, settings) {
  const match = line.match(/^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/);
  if (!match) {
    return null;
  }

  const rawText = match[3].replace(/[ \t]+#+[ \t]*$/, "");
  return {
    level: match[2].length,
    title: cleanDisplayText(rawText, settings),
    ch: match[1].length,
  };
}

function parseListItem(line, settings) {
  const match = line.match(/^([ \t]*)(?:(\d{1,9})([.)])|([-+*]))[ \t]+(.*)$/);
  if (!match) {
    return null;
  }

  const ordered = match[2] != null;
  const marker = ordered ? `${match[2]}${match[3]}` : match[4];
  const startNumber = ordered ? Number.parseInt(match[2], 10) : null;
  const rawText = match[5] ?? "";
  const task = /^\[[ xX-]\][ \t]+/.test(rawText);

  const hidden = task || !ordered || !settings.showOrderedLists;

  return {
    indent: match[1],
    ordered,
    marker,
    startNumber,
    task,
    hidden,
    title: cleanDisplayText(rawText.replace(/^\[[ xX-]\][ \t]+/, ""), settings),
    ch: match[1].length,
  };
}

function addDisplayMarkers(entries) {
  const counters = new Map();

  for (const entry of entries) {
    if (entry.type === "heading") {
      for (const key of [...counters.keys()]) {
        const [, level] = key.split(":");
        if (Number(level) >= entry.effectiveLevel) {
          counters.delete(key);
        }
      }
      continue;
    }

    if (entry.type !== "list") {
      continue;
    }

    for (const key of [...counters.keys()]) {
      const [, level] = key.split(":");
      if (Number(level) > entry.effectiveLevel) {
        counters.delete(key);
      }
    }

    const counterKey = `${entry.listRunId}:${entry.effectiveLevel}`;
    const currentNumber =
      counters.get(counterKey) ??
      (Number.isFinite(entry.startNumber) ? entry.startNumber - 1 : 0);
    const nextNumber = currentNumber + 1;
    counters.set(counterKey, nextNumber);
    entry.displayMarker = `${nextNumber}${entry.marker.endsWith(")") ? ")" : "."}`;
  }

  return entries;
}

function cleanDisplayText(text, settings) {
  let value = String(text ?? "").trim();

  if (settings.stripMarkdownFormatting) {
    value = value
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/<[^>]+>/g, "");
  }

  const maxLength = Number.isFinite(settings.maxItemLength)
    ? settings.maxItemLength
    : DEFAULT_SETTINGS.maxItemLength;

  if (value.length > maxLength) {
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
  }

  return value;
}

function getVisualIndent(indent) {
  let width = 0;
  for (const char of indent) {
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function makeNodeId(filePath, type, line) {
  return `${filePath}:${type}:${line}`;
}

function flattenTree(nodes) {
  const result = [];
  const stack = [...nodes].reverse();

  while (stack.length > 0) {
    const node = stack.pop();
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }

  return result;
}

function findNodePathForLine(nodes, line) {
  let bestPath = [];

  function visit(node, path) {
    if (node.line <= line) {
      bestPath = [...path, node];
    }

    for (const child of node.children) {
      if (child.line > line) {
        break;
      }
      visit(child, [...path, node]);
    }
  }

  for (const node of nodes) {
    if (node.line > line) {
      break;
    }
    visit(node, []);
  }

  return bestPath;
}

function getNodeMarker(node) {
  if (node.type === "heading") {
    return `H${node.headingLevel}`;
  }

  if (node.task) {
    return "[]";
  }

  return node.displayMarker ?? node.marker ?? (node.ordered ? "1." : "-");
}

function createIconButton(parentEl, icon, label, onClick) {
  const button = parentEl.createEl("button", {
    cls: "clickable-icon mixed-outline-icon-button",
    attr: {
      "aria-label": label,
      title: label,
      type: "button",
    },
  });

  setIcon(button, icon);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  return button;
}

function restoreScrollTop(element, scrollTop) {
  element.scrollTop = scrollTop;

  if (typeof window?.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      element.scrollTop = scrollTop;
    });
  }
}

function scrollNodeIntoView(treeEl, nodeId) {
  if (typeof window?.requestAnimationFrame !== "function") {
    return;
  }

  window.requestAnimationFrame(() => {
    const rowEl = treeEl.querySelector(
      `[data-node-id="${cssEscape(nodeId)}"]`
    );
    rowEl?.scrollIntoView?.({ block: "nearest" });
  });
}

function getCurrentVisibleLine(view) {
  const editor = view.editor;

  try {
    const scrollInfo = editor?.getScrollInfo?.();
    if (scrollInfo && typeof editor?.lineAtHeight === "function") {
      const line = editor.lineAtHeight(scrollInfo.top + 24, "local");
      if (Number.isFinite(line)) {
        return line;
      }
    }
  } catch (error) {
    // Fall back to rendered Markdown line markers below.
  }

  const previewLine = getPreviewVisibleLine(view);
  if (Number.isFinite(previewLine)) {
    return previewLine;
  }

  const cursor = editor?.getCursor?.();
  return Number.isFinite(cursor?.line) ? cursor.line : null;
}

function getPreviewVisibleLine(view) {
  const scrollEl = getMarkdownScrollElement(view);
  if (!scrollEl) {
    return null;
  }

  const markers = [...view.contentEl.querySelectorAll("[data-line]")];
  const scrollRect = scrollEl.getBoundingClientRect();
  let bestLine = null;
  let bestTop = Number.NEGATIVE_INFINITY;

  for (const marker of markers) {
    const line = Number.parseInt(marker.getAttribute("data-line"), 10);
    if (!Number.isFinite(line)) {
      continue;
    }

    const rect = marker.getBoundingClientRect();
    if (rect.top <= scrollRect.top + 24 && rect.top > bestTop) {
      bestTop = rect.top;
      bestLine = line;
    }
  }

  if (bestLine != null) {
    return bestLine;
  }

  const firstVisible = markers.find((marker) => {
    const rect = marker.getBoundingClientRect();
    return rect.bottom >= scrollRect.top && rect.top <= scrollRect.bottom;
  });

  return firstVisible
    ? Number.parseInt(firstVisible.getAttribute("data-line"), 10)
    : null;
}

function getMarkdownScrollElement(view) {
  const candidates = [
    view.contentEl.querySelector(".cm-scroller"),
    view.contentEl.querySelector(".markdown-preview-view"),
    view.contentEl.querySelector(".view-content"),
  ].filter(Boolean);

  return (
    candidates.find((element) => element.scrollHeight > element.clientHeight) ??
    candidates[0] ??
    null
  );
}

function cssEscape(value) {
  if (typeof window?.CSS?.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function isMarkdownFile(file) {
  return file instanceof TFile && file.extension === "md";
}

module.exports = MixedOutlinePlugin;
module.exports.__test = {
  buildMixedOutlineTree,
  parseMixedOutlineEntries,
  addDisplayMarkers,
  findNodePathForLine,
};
