const {
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  editorInfoField,
  setIcon,
} = require("obsidian");
const { EditorView } = require("@codemirror/view");

const VIEW_TYPE_MIXED_OUTLINE = "mixed-outline-view";

const DEFAULT_SETTINGS = {
  showHeadings: true,
  showOrderedLists: true,
  stripMarkdownFormatting: true,
  maxItemLength: 160,
  openOnStartup: false,
  outlineMode: "remember",
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
    this.cursorSyncRequest = 0;
    this.readingSections = new WeakMap();
    this.readingRoot = null;
    this.readingDocument = null;
    this.readingHandler = null;

    this.registerMarkdownPostProcessor((element, context) => {
      // Section boundaries belong to the document; list data-line offsets belong
      // to that section. Keep the context to resolve fresh bounds after rerenders.
      this.readingSections.set(element, {
        context, sourcePath: context.sourcePath,
        file: this.app.vault.getAbstractFileByPath?.(context.sourcePath),
      });
    });

    this.registerEditorExtension(EditorView.updateListener.of((update) => {
      if (!update.view.hasFocus ||
          !(update.selectionSet || update.docChanged || update.focusChanged)) {
        return;
      }
      const info = update.state.field(editorInfoField, false);
      const view = info instanceof MarkdownView ? info : info?.view;
      if (view instanceof MarkdownView) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1;
        this.scheduleCursorSync(view, line);
      }
    }));

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
      id: "jump-to-start",
      name: "Jump to start / 滚动到顶部",
      callback: () => this.jumpToStart(),
    });

    this.addCommand({
      id: "jump-to-end",
      name: "Jump to end / 跳转到最后（滚动到底部）",
      callback: () => this.jumpToEnd(),
    });

    this.addCommand({
      id: "toggle-auto-sync-to-scroll",
      name: "Toggle scroll following / 切换滚动跟随",
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
        this.scheduleCursorSync(view);
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

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.cursorSyncRequest += 1;
      this.syncReadingListener();
      this.updateFoldViews(oldPath, file.path);
      const paths = Object.keys(this.foldStateByFile).filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
      if (paths.length === 0) return;
      for (const path of paths) {
        this.foldStateByFile[file.path + path.slice(oldPath.length)] = this.foldStateByFile[path];
        delete this.foldStateByFile[path];
      }
      this.persistData().catch(error => console.error("Mixed Outline: could not move fold state", error));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.updateFoldViews(file.path, null);
      const paths = Object.keys(this.foldStateByFile).filter(path => path === file.path || path.startsWith(`${file.path}/`));
      if (paths.length === 0) return;
      for (const path of paths) delete this.foldStateByFile[path];
      this.persistData().catch(error => console.error("Mixed Outline: could not remove fold state", error));
    }));

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
    this.cursorSyncRequest += 1;
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.scrollTimer) {
      window.clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }

    this.detachScrollListener();
    this.detachReadingListener();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MIXED_OUTLINE);
  }

  async loadSettings() {
    const data = await this.loadData() ?? {};
    const { foldStateByFile, outlineBehavior, autoSyncToCursor, autoSyncToScroll, ...settings } = data;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    if (!["remember", "cursor", "scroll", "both"].includes(settings.outlineMode)) {
      // Preserve existing follow preferences; new installs start in remember mode.
      const hasLegacyMode = ["outlineBehavior", "autoSyncToCursor", "autoSyncToScroll"]
        .some(key => Object.prototype.hasOwnProperty.call(data, key));
      const cursor = typeof autoSyncToCursor === "boolean" ? autoSyncToCursor : true;
      const scroll = typeof autoSyncToScroll === "boolean" ? autoSyncToScroll : false;
      this.settings.outlineMode = !hasLegacyMode || outlineBehavior === "remember"
        ? "remember" : cursor ? (scroll ? "both" : "cursor") : (scroll ? "scroll" : "remember");
    }
    this.foldStateByFile = Object.create(null);
    if (foldStateByFile && typeof foldStateByFile === "object" && !Array.isArray(foldStateByFile)) {
      for (const [filePath, states] of Object.entries(foldStateByFile)) {
        if (!states || typeof states !== "object" || Array.isArray(states)) continue;
        this.foldStateByFile[filePath] = Object.fromEntries(
          Object.entries(states).filter(([, collapsed]) => typeof collapsed === "boolean")
        );
      }
    }
  }

  isFollowingOutline() {
    return this.settings.outlineMode !== "remember";
  }

  followsCursor() {
    return ["cursor", "both"].includes(this.settings.outlineMode);
  }

  followsScroll() {
    return ["scroll", "both"].includes(this.settings.outlineMode);
  }

  persistData() {
    // Serialize snapshots so a slow earlier write cannot overwrite a newer fold.
    const data = JSON.parse(JSON.stringify({ ...this.settings, foldStateByFile: this.foldStateByFile }));
    this.dataSavePromise = (this.dataSavePromise ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.saveData(data));
    return this.dataSavePromise;
  }

  rememberFoldState(filePath, nodes, collapsed) {
    // Keep preferences for nodes temporarily hidden by display settings.
    const states = Object.assign(Object.create(null), this.foldStateByFile[filePath]);
    for (const node of nodes) {
      if (node.children.length > 0) states[node.foldKey] = collapsed.has(node.id);
    }
    this.foldStateByFile[filePath] = states;
    return this.persistData().catch(error => {
      console.error("Mixed Outline: could not save fold state", error);
      new Notice("Mixed Outline: could not save outline folding. Please try again.");
    });
  }

  updateFoldViews(oldPath, newPath) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIXED_OUTLINE)) {
      const view = leaf.view;
      const path = view?.lastRenderedFilePath;
      if (!(view instanceof MixedOutlineView) ||
          !(path === oldPath || path?.startsWith(`${oldPath}/`))) continue;
      view.renderVersion += 1;
      if (newPath === null) {
        view.lastRenderedFilePath = null;
        view.lastNodes = [];
        view.collapsed.clear();
        view.activeNodeId = null;
      } else {
        view.lastRenderedFilePath = newPath + path.slice(oldPath.length);
        for (const node of view.lastNodes) {
          const previousId = node.id;
          node.filePath = view.lastRenderedFilePath;
          node.id = makeNodeId(node.filePath, node.type, node.line);
          if (view.collapsed.delete(previousId)) view.collapsed.add(node.id);
          if (view.activeNodeId === previousId) view.activeNodeId = node.id;
        }
      }
    }
    this.scheduleRefresh();
  }

  async saveSettings() {
    this.cursorSyncRequest += 1;
    this.activeScrollPath = null;
    if (this.scrollTimer) {
      window.clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    this.detachScrollListener();
    this.detachReadingListener();
    this.suppressScrollSyncUntil = 0;
    await this.persistData();
    this.syncScrollListener();
    this.scheduleCursorSync(this.getCurrentMarkdownView());
    await this.refreshViews();
  }

  async toggleAutoSyncToScroll() {
    const nextMode = { remember: "scroll", scroll: "remember", cursor: "both", both: "cursor" };
    this.settings.outlineMode = nextMode[this.settings.outlineMode];
    await this.saveSettings();
    const tab = this.app.setting?.activeTab;
    if (tab?.plugin === this) tab.display();
    new Notice(
      `Mixed Outline: auto sync to scroll ${
        this.followsScroll() ? "enabled" : "disabled"
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

  scheduleCursorSync(view, line = view?.editor?.getCursor?.().line) {
    if (!this.followsCursor() || !Number.isFinite(line)) return;
    const request = ++this.cursorSyncRequest;
    // Finish the CodeMirror update first, without waiting for a debounce timer.
    Promise.resolve().then(() => {
      if (request !== this.cursorSyncRequest || !this.followsCursor() ||
          !(view instanceof MarkdownView) || !view.file ||
          view.getMode() !== "source" ||
          this.app.workspace.getActiveViewOfType(MarkdownView) !== view) return;
      if (this.scrollTimer) {
        window.clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      }
      // Cursor movement can scroll the editor. Keep that scroll from replacing
      // the selected line with the first visible line.
      this.suppressScrollSync(200);
      this.currentFile = view.file;
      this.pendingEditorText = view.editor.getValue();
      this.activeScrollPath = { filePath: view.file.path, line, source: "cursor" };
      this.scrollSyncVersion += 1;
      return this.refreshViews();
    }).catch(error => console.error("Mixed Outline: cursor sync failed", error));
  }

  getReadingRoot(view) {
    return view.previewMode?.containerEl ?? view.contentEl?.querySelector?.(".markdown-preview-view");
  }

  getReadingLine(view, target) {
    if (view.getMode?.() !== "preview" || !view.file) return null;
    const root = this.getReadingRoot(view);
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    if (!element || !root?.contains(element) || element.isConnected === false ||
        element.closest?.(".markdown-embed, .internal-embed")) return null;
    let section = element;
    while (section && root.contains(section)) {
      const record = this.readingSections.get(section);
      if (record) {
        if ((record.file?.path ?? record.sourcePath) !== view.file.path ||
            (record.file && record.file !== view.file)) return null;
        let info;
        try { info = record.context.getSectionInfo(section); } catch { return null; }
        if (!Number.isInteger(info?.lineStart) || info.lineStart < 0 ||
            !Number.isInteger(info.lineEnd) || info.lineEnd < info.lineStart) return null;
        const item = element.closest?.("li[data-line]");
        if (item && section.contains(item)) {
          const offset = item.getAttribute("data-line");
          if (!/^\d+$/.test(offset ?? "")) return null;
          const line = info.lineStart + Number(offset);
          return Number.isSafeInteger(line) && line <= info.lineEnd ? line : null;
        }
        return info.lineStart;
      }
      if (section === root) break;
      section = section.parentElement;
    }
    return null;
  }

  scheduleReadingSync(view, line) {
    if (!this.followsCursor() || !Number.isInteger(line) || line < 0 || !view?.file) return;
    const filePath = view.file.path;
    const request = ++this.cursorSyncRequest;
    Promise.resolve().then(() => {
      if (request !== this.cursorSyncRequest || !this.followsCursor() ||
          !(view instanceof MarkdownView) || view.getMode() !== "preview" ||
          view.file?.path !== filePath || this.getCurrentMarkdownView() !== view ||
          (this.app.vault.getAbstractFileByPath &&
           this.app.vault.getAbstractFileByPath(filePath) !== view.file)) return;
      if (this.scrollTimer) {
        window.clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      }
      this.suppressScrollSync(200);
      this.currentFile = view.file;
      this.pendingEditorText = null;
      this.activeScrollPath = { filePath, line, source: "cursor" };
      this.scrollSyncVersion += 1;
      return this.refreshViews();
    }).catch(error => console.error("Mixed Outline: reading selection sync failed", error));
  }

  syncReadingListener() {
    this.detachReadingListener();
    if (!this.followsCursor()) return;
    const view = this.getCurrentMarkdownView();
    if (!(view instanceof MarkdownView) || view.getMode() !== "preview" || !view.file) return;
    const root = this.getReadingRoot(view);
    if (!root?.ownerDocument) return;
    const doc = root.ownerDocument;
    const filePath = view.file.path;
    const handler = event => {
      if (this.readingRoot !== root || view.file?.path !== filePath ||
          (event.type === "pointerup" && event.button > 0)) return;
      const interactive = 'a, button, input, textarea, select, [contenteditable="true"], .collapse-indicator';
      const eventElement = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (eventElement?.closest?.(interactive)) return;
      const selection = doc.getSelection();
      const target = event.type === "pointerup" && (!selection || selection.isCollapsed)
        ? event.target : selection?.focusNode;
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      if (element?.closest?.(interactive)) return;
      const line = this.getReadingLine(view, target);
      if (line !== null) this.scheduleReadingSync(view, line);
    };
    this.readingRoot = root;
    this.readingDocument = doc;
    this.readingHandler = handler;
    root.addEventListener("pointerup", handler);
    // selectionchange also covers keyboard selection. Keyup alone can report
    // an old selection after PageDown scrolls, overriding scroll following.
    doc.addEventListener("selectionchange", handler);
  }

  detachReadingListener() {
    if (this.readingHandler) {
      this.readingRoot?.removeEventListener("pointerup", this.readingHandler);
      this.readingDocument?.removeEventListener("selectionchange", this.readingHandler);
    }
    this.readingRoot = null;
    this.readingDocument = null;
    this.readingHandler = null;
  }

  syncScrollListener() {
    this.syncReadingListener();
    this.detachScrollListener();

    if (!this.followsScroll()) {
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
    if (!this.followsScroll()) {
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
    if (!this.followsScroll()) {
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
      source: "scroll",
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
    if (!node || typeof node.filePath !== "string" ||
        !Number.isInteger(node.line) || node.line < 0) {
      return;
    }

    const request = this.revealNodeRequest = (this.revealNodeRequest ?? 0) + 1;
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
    // Opening a closed note is asynchronous. A later click or file switch must
    // not move the cursor in the note that replaced the requested target.
    if (request !== this.revealNodeRequest || !(view instanceof MarkdownView) ||
        view.file?.path !== file.path) {
      return;
    }

    if (view.getMode() === "preview") {
      // Obsidian applies the line after the preview is ready. Rendered data-line
      // attributes can be block-relative, so they cannot locate a document line.
      leaf.setEphemeralState({ line: node.line, focus: true });
      this.pendingEditorText = null;
      this.scheduleReadingSync(view, node.line);
    } else {
      const pos = { line: node.line, ch: node.ch ?? 0 };
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
      view.editor.focus();
      this.pendingEditorText = view.editor.getValue();
    }

    this.currentFile = file;
  }

  async jumpToStart() {
    if (this.jumpingToStart || this.jumpingToEnd) return;

    const view = this.getCurrentMarkdownView();
    if (!view?.file) {
      new Notice("Mixed Outline: open a Markdown note first.");
      return;
    }

    this.jumpingToStart = true;
    const file = view.file;
    const leaf = view.leaf;
    try {
      if (view.getMode() === "preview") {
        await leaf.setViewState({
          ...leaf.getViewState(),
          state: { ...view.getState(), mode: "source" },
        });
      }
      await this.app.workspace.revealLeaf(leaf);
      if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== file) return;

      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      const editor = leaf.view.editor;
      const pos = { line: 0, ch: 0 };
      editor.setCursor(pos);
      editor.focus();
      editor.scrollIntoView({ from: pos, to: pos }, true);

      this.currentFile = file;
      this.pendingEditorText = editor.getValue();
      this.syncScrollListener();
      this.scheduleRefresh();
    } catch (error) {
      console.error("Mixed Outline: jump to start failed", error);
      new Notice("Mixed Outline: could not jump to the start of this note.");
    } finally {
      this.jumpingToStart = false;
    }
  }

  async jumpToEnd() {
    if (this.jumpingToEnd || this.jumpingToStart) return;

    const view = this.getCurrentMarkdownView();
    if (!view?.file) {
      new Notice("Mixed Outline: open a Markdown note first.");
      return;
    }

    this.jumpingToEnd = true;
    const file = view.file;
    const leaf = view.leaf;
    try {
      // Reading view has no editable caret; retain the note's other view state.
      if (view.getMode() === "preview") {
        await leaf.setViewState({
          ...leaf.getViewState(),
          state: { ...view.getState(), mode: "source" },
        });
      }
      await this.app.workspace.revealLeaf(leaf);

      // A note may have changed while the view was being opened.
      if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== file) return;

      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      const editor = leaf.view.editor;
      let line = editor.lastLine();
      const lastText = editor.getLine(line);
      // Reuse an existing empty final line, so repeated clicks do not add blanks.
      if (lastText.length > 0) {
        editor.replaceRange("\n", { line, ch: lastText.length });
        line += 1;
      }
      const pos = { line, ch: 0 };
      editor.setCursor(pos);
      editor.focus();
      editor.scrollIntoView({ from: pos, to: pos }, true);

      this.currentFile = file;
      this.pendingEditorText = editor.getValue();
      this.syncScrollListener();
      this.scheduleRefresh();
    } catch (error) {
      console.error("Mixed Outline: jump to end failed", error);
      new Notice("Mixed Outline: could not jump to the end of this note.");
    } finally {
      this.jumpingToEnd = false;
    }
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
    this.lastOutlineBehavior = null;
    this.renderVersion = 0;
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
    const renderVersion = ++this.renderVersion;
    const { file, source } = await this.plugin.getOutlineSource();
    if (renderVersion !== this.renderVersion) return;
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
    const startButton = createIconButton(
      actionsEl,
      "arrow-up-to-line",
      "滚动到顶部 / Jump to start",
      () => this.plugin.jumpToStart()
    );
    startButton.addClass("mixed-outline-jump-to-start");
    startButton.disabled = !file;
    createIconButton(actionsEl, "chevrons-down-up", "Collapse all", () => {
      this.collapseAll();
    });
    createIconButton(actionsEl, "chevrons-up-down", "Expand all", () => {
      this.expandAll();
    });

    const jumpButton = createIconButton(
      actionsEl,
      "arrow-down-to-line",
      "跳转到最后 / Jump to end",
      () => this.plugin.jumpToEnd()
    );
    jumpButton.addClass("mixed-outline-jump-to-end");
    jumpButton.disabled = !file;

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
    assignFoldKeys(root.children, source);
    this.lastNodes = flattenTree(root.children);
    const remember = !this.plugin.isFollowingOutline();
    const syncEnabled = this.plugin.activeScrollPath?.source === "cursor"
      ? this.plugin.followsCursor()
      : this.plugin.followsScroll();
    const hasScrollSyncForFile =
      !remember &&
      syncEnabled &&
      this.plugin.activeScrollPath?.filePath === file.path;
    const shouldSyncToScroll =
      hasScrollSyncForFile &&
      this.lastAppliedScrollSyncVersion !== this.plugin.scrollSyncVersion;

    if (remember) {
      this.restoreFoldState(root.children, file.path);
      this.activeNodeId = null;
    } else if (shouldSyncToScroll) {
      this.syncCollapsedToLine(root.children, this.plugin.activeScrollPath.line,
        this.plugin.activeScrollPath.source === "cursor");
      this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    } else if (!hasScrollSyncForFile) {
      this.activeNodeId = null;
    }

    if (!remember && !shouldSyncToScroll &&
        (previousFilePath !== file.path || this.lastOutlineBehavior !== "follow")) {
      this.collapsed.clear();
      this.collapseNodesDeeperThanDepth(root.children, 0);
    }
    this.lastRenderedFilePath = file.path;
    this.lastOutlineBehavior = remember ? "remember" : "follow";

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

    if (!shouldSyncToScroll && previousFilePath === file.path) {
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

  async toggleNode(node) {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;

    if (this.collapsed.has(node.id)) {
      this.collapsed.delete(node.id);
    } else {
      this.collapsed.add(node.id);
    }

    await this.rememberFoldState();
    await this.render();
  }

  async expandNode(node) {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapsed.delete(node.id);
    await this.rememberFoldState();
    await this.render();
  }

  async collapseAll() {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapseNodesWithChildren(this.lastNodes);
    await this.rememberFoldState();
    await this.render();
  }

  collapseNodesWithChildren(nodes) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        this.collapsed.add(node.id);
      }
    }
  }

  async expandAll() {
    this.lastAppliedScrollSyncVersion = this.plugin.scrollSyncVersion;
    this.collapsed.clear();
    this.activeNodeId = null;
    await this.rememberFoldState();
    await this.render();
  }

  rememberFoldState() {
    if (this.plugin.isFollowingOutline() || !this.lastRenderedFilePath) return;
    return this.plugin.rememberFoldState(this.lastRenderedFilePath, this.lastNodes, this.collapsed);
  }

  restoreFoldState(nodes, filePath) {
    this.collapsed.clear();
    this.collapseNodesDeeperThanDepth(nodes, 0);
    const states = this.plugin.foldStateByFile[filePath] ?? {};
    for (const node of flattenTree(nodes)) {
      if (node.children.length === 0) continue;
      if (states[node.foldKey] === true) this.collapsed.add(node.id);
      else if (states[node.foldKey] === false) this.collapsed.delete(node.id);
    }
  }

  syncCollapsedToLine(nodes, line, expandActive = false) {
    const activePath = findNodePathForLine(nodes, line);
    const activeNode = activePath[activePath.length - 1] ?? null;
    const expandedIds = new Set(
      (expandActive ? activePath : activePath.slice(0, -1)).map((node) => node.id)
    );

    this.activeNodeId = activeNode?.id ?? null;
    this.collapsed.clear();

    for (const node of flattenTree(nodes)) {
      if (node.children.length > 0 && !expandedIds.has(node.id)) {
        this.collapsed.add(node.id);
      }
    }
  }

  collapseNodesDeeperThanDepth(nodes, expandedDepth, depth = 0) {
    for (const node of nodes) {
      if (node.children.length > 0 && depth > expandedDepth) {
        this.collapsed.add(node.id);
      }

      this.collapseNodesDeeperThanDepth(node.children, expandedDepth, depth + 1);
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
      .setName("Outline mode / 大纲模式")
      .setDesc("Remember manual folds, follow the cursor or clicked/selected text in Reading view, follow scrolling, or both. / 默认按文件记住手动折叠；跟随光标在阅读模式中跟随点击或选中文字，也可选择滚动跟随或两者。")
      .addDropdown(dropdown => dropdown
        .addOption("remember", "Remember manual folding per file / 按文件记住手动折叠")
        .addOption("cursor", "Follow cursor / 跟随光标")
        .addOption("scroll", "Follow scroll / 跟随滚动")
        .addOption("both", "Follow cursor and scroll / 同时跟随光标与滚动")
        .setValue(this.plugin.settings.outlineMode)
        .onChange(async value => {
          this.plugin.settings.outlineMode = value;
          await this.plugin.saveSettings();
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
    // A heading ends the preceding list, even when heading levels are skipped.
    // Only headings can be ancestors of another heading.
    while (
      stack.length > 1 &&
      ((entry.type === "heading" && stack[stack.length - 1].type === "list") ||
        stack[stack.length - 1].effectiveLevel >= entry.effectiveLevel)
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
  let nextListRunId = 1;
  let fence = null;
  let afterBlank = false;
  let inFrontmatter = lines[0]?.trim() === "---";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (inFrontmatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line.trim())) {
        inFrontmatter = false;
      }
      continue;
    }

    if (!line.trim()) {
      afterBlank = true;
      continue;
    }

    const indent = getVisualIndent(line.match(/^[ \t]*/)[0]);
    if (fence) {
      // A fence nested in a list ends when the containing item ends, even if
      // the author did not include a closing fence before the next item.
      if (indent >= fence.contentIndent) {
        const closing = line.trim().match(/^(`{3,}|~{3,})[ \t]*$/);
        if (
          indent <= fence.contentIndent + 3 &&
          closing &&
          closing[1][0] === fence.char &&
          closing[1].length >= fence.length
        ) {
          fence = null;
          afterBlank = true;
        }
        continue;
      }
      fence = null;
    }

    const heading = parseHeading(line, settings);
    if (heading) {
      while (listStack.length && indent < listStack[listStack.length - 1].contentIndent) {
        listStack.pop();
      }
      if (listStack[listStack.length - 1]?.hidden) {
        continue;
      }
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= heading.level
      ) {
        headingStack.pop();
      }

      headingStack.push({ level: heading.level, line: index });
      listStack.length = 0;
      afterBlank = false;

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

    const thematicBreak = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
    const listItem = thematicBreak ? null : parseListItem(line, settings);
    if (!listItem) {
      const opening = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
      // Loose lists retain their ancestry across blank/continuation lines.
      // A dedented paragraph after a blank or an explicit block boundary ends it.
      if (afterBlank || opening || /^\s*>/.test(line) || thematicBreak) {
        while (listStack.length && indent < listStack[listStack.length - 1].contentIndent) {
          listStack.pop();
        }
      }
      const parent = listStack[listStack.length - 1];
      const contentIndent = parent?.contentIndent ?? 0;
      if (
        opening &&
        indent >= contentIndent && indent <= contentIndent + 3 &&
        (opening[1][0] !== "`" || !opening[2].includes("`"))
      ) {
        fence = { char: opening[1][0], length: opening[1].length, contentIndent };
      }
      afterBlank = Boolean(opening || thematicBreak || /^\s*>/.test(line));
      continue;
    }

    let previousSibling = null;
    while (listStack.length && indent < listStack[listStack.length - 1].contentIndent) {
      previousSibling = listStack.pop();
    }

    const parentList = listStack[listStack.length - 1];
    const contentIndent = parentList?.contentIndent ?? 0;
    if (indent >= contentIndent + 4) {
      // Four extra columns are an indented code block, not a nested list.
      afterBlank = false;
      continue;
    }

    const listRunId =
      previousSibling &&
      previousSibling.ordered === listItem.ordered &&
      previousSibling.delimiter === listItem.marker.slice(-1)
        ? previousSibling.runId
        : nextListRunId++;
    const hidden = listItem.hidden || Boolean(parentList?.hidden);
    listStack.push({
      indent,
      contentIndent: listItem.contentIndent,
      line: index,
      runId: listRunId,
      ordered: listItem.ordered,
      delimiter: listItem.marker.slice(-1),
      hidden,
    });
    afterBlank = false;

    const opening = listItem.rawText.match(/^(`{3,}|~{3,})(.*)$/);
    if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      fence = {
        char: opening[1][0], length: opening[1].length,
        contentIndent: listItem.contentIndent,
      };
    }

    if (hidden) {
      continue;
    }

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
  const match = line.match(/^([ \t]*)(?:(\d{1,9})([.)])|([-+*]))(?:([ \t]+)(.*)|$)/);
  if (!match) {
    return null;
  }

  const ordered = match[2] != null;
  const marker = ordered ? `${match[2]}${match[3]}` : match[4];
  const startNumber = ordered ? Number.parseInt(match[2], 10) : null;
  const rawText = match[6] ?? "";
  const task = /^\[[ xX-]\](?:[ \t]+|$)/.test(rawText);
  const markerEnd = getVisualIndent(match[1]) + marker.length;
  const padding = getVisualIndent(match[5] ?? " ", markerEnd) - markerEnd;

  const hidden = task || !ordered || !settings.showOrderedLists;

  return {
    indent: match[1],
    contentIndent: markerEnd + (padding <= 4 ? padding : 1),
    rawText,
    ordered,
    marker,
    startNumber,
    task,
    hidden,
    title: cleanDisplayText(rawText.replace(/^\[[ xX-]\](?:[ \t]+|$)/, ""), settings),
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

function getVisualIndent(indent, startColumn = 0) {
  let width = startColumn;
  for (const char of indent) {
    width += char === "\t" ? 4 - (width % 4) : 1;
  }
  return width;
}

function makeNodeId(filePath, type, line) {
  return `${filePath}:${type}:${line}`;
}

function assignFoldKeys(nodes, source) {
  const lines = source.split(/\r\n|\n|\r/);
  function visit(children, parentKey = "") {
    const occurrences = new Map();
    for (const node of children) {
      const label = String(lines[node.line] ?? node.title)
        .replace(node.type === "heading" ? /^ {0,3}#{1,6}(?:[ \t]+|$)/ : /^[ \t]*\d{1,9}[.)][ \t]+/, "")
        .replace(node.type === "heading" ? /[ \t]+#+[ \t]*$/ : /$^/, "")
        .trim().replace(/[ \t]+/g, " ");
      const identity = `${node.type}:${hashFoldIdentity(label)}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      node.foldKey = `${parentKey}/${identity}:${occurrence}`;
      visit(node.children, node.foldKey);
    }
  }
  visit(nodes);
}

function hashFoldIdentity(value) {
  // Store opaque identities, not note titles. Two independent 32-bit hashes
  // keep keys compact without relying on Node APIs (the plugin also runs mobile).
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    first = Math.imul(first ^ char, 16777619);
    second = Math.imul(second, 33) ^ char;
  }
  return `${(first >>> 0).toString(36)}.${(second >>> 0).toString(36)}`;
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
  if (view.getMode?.() === "preview") return getPreviewVisibleLine(view);
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
  try {
    // Reading view reports its document line through the public view state.
    // DOM data-line markers are block-relative; the hidden editor is unrelated.
    const scroll = view.getEphemeralState?.()?.scroll;
    return Number.isFinite(scroll) ? Math.max(0, Math.floor(scroll)) : null;
  } catch (error) {
    return null;
  }
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
  MixedOutlineView,
  assignFoldKeys,
  buildMixedOutlineTree,
  parseMixedOutlineEntries,
  addDisplayMarkers,
  findNodePathForLine,
};
