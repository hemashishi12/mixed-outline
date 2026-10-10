# Changelog

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
