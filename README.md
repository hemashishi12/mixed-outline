# Mixed Outline

Mixed Outline is a local Obsidian plugin that shows Markdown headings and numbered list items together in one navigable outline.

It is useful for notes that are structured with both headings and ordered lists, such as reading notes, plans, research outlines, and long-form drafts.

## Features

- Opens a dedicated `Mixed Outline` view in the right sidebar.
- Shows headings and ordered Markdown list items in a single tree.
- Clicks an outline item to jump to the matching line in the active Markdown file.
- Refreshes automatically when the editor changes, the active file changes, or the current file is modified.
- Provides toolbar buttons for refresh, collapse all, and expand all.
- Can automatically sync the outline to the current scroll position.
- Skips YAML frontmatter and fenced code blocks while parsing.
- Cleans common inline Markdown syntax for easier reading.
- Supports startup auto-open through plugin settings.

## Commands

The plugin registers these Obsidian commands:

- `Open mixed outline`
- `Refresh mixed outline`
- `Toggle auto sync outline to scroll position`

It also adds a ribbon icon with the `list-tree` icon.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Show headings | On | Include Markdown headings such as `#`, `##`, and `###`. |
| Show ordered lists | On | Include numbered list items such as `1.` and `2)`. |
| Strip Markdown formatting | On | Hide common inline Markdown syntax in the outline text. |
| Maximum item length | `160` | Trim very long outline items. Values are clamped between `20` and `500`. |
| Open on startup | Off | Open the Mixed Outline view when Obsidian starts. |
| Auto sync to scroll position | Off | While browsing a Markdown file, expand only the outline path for the visible position and collapse other branches. |

## Scroll Sync

The `Toggle auto sync outline to scroll position` command enables or disables automatic outline syncing.

When enabled, Mixed Outline listens to scrolling in the active Markdown view. It finds the outline item at the current visible line, expands that item's ancestor path, highlights the matching outline row, and collapses unrelated branches.

For example, if the current visible position is inside:

```text
H1
└── H2
    └── 1. Current section
        └── 1. Child section
```

Mixed Outline expands `H1` and `H2`, highlights `1. Current section`, and keeps `1. Child section` collapsed unless the scroll position moves into it.

## Outline Rules

Mixed Outline parses the active Markdown document line by line.

Headings are detected from ATX heading syntax:

```markdown
# Heading 1
## Heading 2
### Heading 3
```

Ordered list items are detected from numbered Markdown list syntax:

```markdown
1. First item
2. Second item
   1. Nested item
```

The list level is calculated relative to the nearest heading. For example, a top-level numbered item under `## Topic` is displayed as a child of that heading.

The plugin intentionally hides:

- unordered list items, such as `- item`, `+ item`, and `* item`
- task list items, such as `- [ ] task`
- ordered list items nested under hidden unordered or task lists
- content inside fenced code blocks
- YAML frontmatter

## Architecture

The plugin is implemented as a small single-file Obsidian plugin in `main.js`, with styles in `styles.css`.

Main parts:

- `MixedOutlinePlugin`: plugin lifecycle, Obsidian command registration, event handling, view activation, settings persistence, and navigation back to Markdown lines.
- `MixedOutlineView`: the right-sidebar `ItemView`, toolbar rendering, tree rendering, active scroll path rendering, collapse state, and click handling.
- `MixedOutlineSettingTab`: plugin settings UI.
- `buildMixedOutlineTree()`: converts parsed outline entries into a nested tree.
- `parseMixedOutlineEntries()`: scans Markdown source and extracts heading/list outline entries.
- `addDisplayMarkers()`: recalculates display numbering for ordered list items.
- `findNodePathForLine()`: finds the outline path that contains the current visible Markdown line.

The plugin exports a small `__test` object from `main.js` for parser-focused testing:

```js
module.exports.__test = {
  buildMixedOutlineTree,
  parseMixedOutlineEntries,
  addDisplayMarkers,
};
```

## Files

```text
mixed-outline/
├── manifest.json
├── main.js
├── styles.css
└── README.md
```

## Development Notes

This plugin currently ships as compiled JavaScript only. There is no TypeScript source tree in this plugin directory.

When changing parser behavior, focus on these functions:

- `parseHeading()`
- `parseListItem()`
- `parseMixedOutlineEntries()`
- `buildMixedOutlineTree()`

When changing UI behavior, focus on:

- `MixedOutlineView.render()`
- `MixedOutlineView.renderNode()`
- `styles.css`
