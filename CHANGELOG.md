# Changelog

## 1.4.0 — 2026-10-25

- Replace separate behavior/follow controls with one **Outline mode / 大纲模式** dropdown: **Remember manual folding per file / 按文件记住手动折叠** (default for new installations), **Follow cursor / 跟随光标**, **Follow scroll / 跟随滚动**, and **Follow cursor and scroll / 同时跟随光标与滚动**. Following never overwrites saved manual folds.
- Preserve a valid selected mode and remembered folds on upgrade. Keep older remember-mode settings; otherwise migrate the previous cursor/scroll combination to its matching mode, including both when both were enabled. Both disabled or no prior mode/follow settings use remember mode. The new-installation default does not override existing follow preferences.
- Rename the existing scroll-sync command to **Toggle scroll following / 切换滚动跟随** while retaining its command ID and hotkeys. It switches remember ↔ scroll or cursor ↔ both; disabling scroll-only following returns to remember mode.
- Restore manual expansion/collapse after switching notes, sidebar recreation, and plugin reload. Use line-independent hashed identities; migrate state on file/folder renames and clean it on deletion. Serialize saves and ignore stale renders.
- Fix missing/misparented ordered siblings after unordered/task details, blank lines, and continuation paragraphs. Preserve list numbering and exclude hidden descendants and nested code blocks.
- Integrate the Reading view navigation fix identified in PR #3 using public `setEphemeralState`, with asynchronous-target guards. Read preview scroll position through public view state instead of hidden-editor or relative DOM coordinates.
- Support all four outline modes in Reading view: cursor following responds to rendered-note clicks and text selections, scroll following tracks the visible section, combined following responds to both, and remember mode keeps manual folds. Resolve clicked/selected lines through current Markdown postprocessor section information and validated list-relative offsets.
- Add regression coverage for folding persistence, mode interactions, list parsing, and Reading view navigation. All 150 automated tests pass, including 25 Reading-view tests; 40 desktop Obsidian checks cover the Reading-mode changes. Mobile and the minimum supported app version have not been separately tested.

## 1.3.0 — 2026-10-25

### Added

- **Jump to start / 滚动到顶部** moves to the first character and focuses the editor without changing note content. Reading view switches to editing first.
- A new start-navigation command supports a custom hotkey under **Settings → Hotkeys**. The existing end command now also includes **滚动到底部** in its name for easier discovery; its command ID and assigned hotkeys are preserved. Neither command has a default hotkey.
- Regression coverage for start navigation, empty and long notes, Reading view, sidebar focus, file changes, activation failures, and opposing navigation commands.

### Changed

- The first toolbar button is now an up-to-line arrow instead of Refresh. Manual refresh remains available in the command palette.
- Start/end navigation ignores overlapping invocations to prevent competing view changes.

### Upgrade notes

Existing settings and end-navigation hotkeys are preserved. Requires Obsidian 1.5.0+. All 31 automated tests pass, with 8 desktop runtime checks covering the toolbar, navigation commands, scrolling, content preservation, and Reading view. Mobile and minimum-version compatibility have not been separately tested.

### 中文说明

新增「滚动到顶部」，替换工具栏原来的刷新按钮；手动刷新仍可通过命令面板执行。在「设置 → 快捷键」中搜索 Mixed Outline，可分别绑定或修改顶部、底部快捷键。已有底部快捷键和插件设置保留。顶部定位不修改正文；底部继续保留按需补一个换行并聚焦空白末行的行为。

## 1.2.0 — 2026-10-10

### Added

- **Follow cursor / 跟随光标**, enabled by default: clicking, keyboard navigation, and edits immediately highlight and expand the matching outline entry without scrolling. The selected heading or parent list reveals its direct children; unrelated branches collapse.
- An independent cursor-follow setting alongside the existing optional scroll sync. Reading view continues to use scroll sync.
- Regression coverage for cursor events, inactive editors, rapid selection changes, unload cleanup, and 37 heading/list hierarchy cases.

### Fixed

- Headings after numbered lists no longer become children of those lists, including H2–H6 and skipped heading levels. A heading attaches only to its heading parent; lists under a heading remain siblings of its child headings.
- Cursor-triggered scrolling no longer immediately overwrites the selected position with the viewport's first line.
- Revealing the active outline entry no longer gets undone by restoring an old outline scroll position.

### Upgrade notes

Existing settings are preserved. Cursor follow starts enabled; disable **Follow cursor / 跟随光标** for manual control. No note migration is required. Requires Obsidian 1.5.0+; desktop tested, mobile and minimum-version compatibility not separately tested.

### 中文说明

新增默认开启的「跟随光标」：点击正文、方向键移动或编辑时，立即展开并高亮对应大纲，不再等待滚动。修复数字列表把后面的标题折叠进去的问题，支持二至六级标题及跳级标题。升级保留原设置，可单独关闭光标跟随。

## 1.1.0 — 2026-10-08

- Add **Jump to end / 跳转到最后** as the last outline toolbar button and as a command that can be assigned a hotkey.
- Focus the Markdown editor at an empty final line, scrolling the cursor into view. Append one newline only when the last line contains text; repeated clicks reuse an existing empty line.
- Switch Reading view to editing before placing the cursor. Preserve the existing note text and selection contents.
- Guard against overlapping clicks and a note changing while its view opens.
- Add English and Chinese documentation, a demo using sample content, and release compatibility metadata.

## 1.0.6

- Previous public version with a mixed heading/list outline, navigation, collapse/expand controls, and optional scroll synchronization.
