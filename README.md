<p align="center">
  <img src="docs/hero.svg" alt="Mixed Outline — Find your place. Keep writing." width="100%">
</p>

<p align="center">
  <a href="https://github.com/hemashishi12/mixed-outline/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/hemashishi12/mixed-outline?style=flat-square&amp;color=a89aff"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-75dbd2?style=flat-square"></a>
  <img alt="Obsidian 1.5.0 or later" src="https://img.shields.io/badge/Obsidian-1.5.0%2B-8175d8?style=flat-square">
  <img alt="No runtime dependencies" src="https://img.shields.io/badge/runtime_dependencies-0-75dbd2?style=flat-square">
</p>

<p align="center">
  <b>Headings and numbered lists, together in one navigable outline.</b><br>
  Follow the structure of a long note, then jump straight to your next thought.
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#jump-to-end">Jump to end</a> ·
  <a href="CHANGELOG.md">What's new</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Why Mixed Outline?

Your ideas do not always fit inside headings. Reading notes, project plans, study guides, and long drafts often carry their structure in numbered lists too. Mixed Outline brings both into a single sidebar tree, so you can navigate the way you actually write.

| Feature | What it does |
| --- | --- |
| **One connected outline** | Combines Markdown headings and numbered list items, including nested lists. |
| **Click to navigate** | Takes you to the matching line in the note. |
| **Jump to end ✨** | Moves to the bottom, focuses the editor, and leaves an empty line ready for writing. |
| **Follow your reading** | Optional scroll sync expands the current path and highlights your position. |
| **Keep the tree tidy** | Collapse or expand the outline with a single click. |
| **Stay up to date** | Refreshes as you edit or switch notes. |

The illustration above uses fictional sample content. No personal vault screenshots are included.

## Installation

### From Obsidian

1. Open **Settings → Community plugins → Browse**.
2. Search for **Mixed Outline**, install it, and enable it.
3. Click the **Open Mixed Outline** ribbon icon, or run **Mixed Outline: Open mixed outline** from the command palette.

Already installed? Open **Settings → Community plugins → Check for updates** and update Mixed Outline.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/hemashishi12/mixed-outline/releases/latest). Place all three in `<your-vault>/.obsidian/plugins/mixed-outline/`, reload Obsidian, and enable the plugin. Preserve `data.json` when upgrading; it contains your settings.

Requires **Obsidian 1.5.0+**. The plugin uses Obsidian APIs without Node.js or Electron runtime dependencies and declares support for desktop and mobile. Version 1.1.0 was verified in desktop Obsidian; mobile has not been separately tested.

## Jump to end

Click the **down arrow above a horizontal line**, the last button in the outline toolbar. Its tooltip is **跳转到最后 / Jump to end**.

The button brings the current note into editing mode, scrolls the final cursor position into view, and focuses the editor so you can start typing immediately.

- If the note ends with text, one newline is appended.
- If an empty final line already exists, the cursor moves there. Repeated clicks do not accumulate blank lines.
- Empty notes are ready to type into without inserting extra lines.
- Reading view switches to editing first. Live Preview and Source mode remain editable.
- Existing text, including selected text and the contents of a final list item, is preserved.

You can also run **Mixed Outline: Jump to end / 跳转到最后** from the command palette, or assign it a hotkey under **Settings → Hotkeys**. The toolbar button is disabled when no Markdown note is available.

## A small example

```markdown
# Launch notes
## Plan
1. Define the idea
2. Sketch the experience
   1. Keep the outline clear
   2. Make writing effortless
## Next steps
1. Share what you learned
```

The headings and numbered items appear together. Nested list items sit beneath their parent, and each entry links back to its source line.

Mixed Outline recognizes ATX headings (`#` through `######`) and ordered list markers such as `1.` or `2)`. It skips YAML frontmatter, fenced code blocks, unordered lists, and task lists. Ordered items nested inside hidden unordered or task lists are also omitted.

## Settings & commands

| Setting | Default | Purpose |
| --- | --- | --- |
| Show headings | On | Include Markdown headings. |
| Show ordered lists | On | Include numbered Markdown list items. |
| Strip Markdown formatting | On | Simplify inline formatting in outline labels. |
| Maximum item length | 160 | Limit label length, from 20 to 500 characters. |
| Open on startup | Off | Open the sidebar when Obsidian starts. |
| Auto sync to scroll position | Off | Follow the visible section, expanding its ancestors and collapsing unrelated branches. |

Available commands: **Open mixed outline**, **Refresh mixed outline**, **Jump to end / 跳转到最后**, and **Toggle auto sync outline to scroll position**.

## Privacy

Mixed Outline processes note content locally. It makes no network requests, collects no telemetry, and needs no account. Its settings are stored in the vault's plugin `data.json`. Jump to end edits only the targeted note and only appends a newline when needed.

## Development

This is a small, directly editable JavaScript plugin. **There is no build step or dependency installation.**

```sh
git clone https://github.com/hemashishi12/mixed-outline.git
cd mixed-outline
node --check main.js
node --test
```

Use Node.js 18+ for the tests. Copy the three plugin files into a development vault and reload the plugin to try changes.

| File | Purpose |
| --- | --- |
| `main.js` | Plugin lifecycle, parser, outline UI, navigation, and settings. |
| `styles.css` | Theme-aware sidebar styling. |
| `manifest.json` | Plugin identity, version, and minimum Obsidian version. |
| `versions.json` | Release compatibility mapping. |
| `test/` | Navigation regression tests using Node's built-in test runner. |

Implementation notes:

- Reading view must switch to `source` view state before placing an editable caret. This state covers both Source mode and Live Preview.
- Use `editor.replaceRange()` at the final position to preserve selected text and normal undo history. Do not rewrite the whole note or simulate Enter, which can continue a list.
- Recheck the target file after asynchronous view changes, and ignore overlapping invocations.
- Clicking the sidebar can change the active pane. Resolve the current Markdown view using the existing active/recent-note tracking.
- For Windows installations where `obsidian` is not on PATH, invoke `Obsidian.com` in the installation directory to use CLI diagnostics. Background-window timers can be throttled during live checks.

To release: update `manifest.json`, add the version to `versions.json`, and publish a GitHub release with an exact numeric tag such as `1.1.0` (**no `v` prefix**). Attach `main.js`, `manifest.json`, and `styles.css`. The existing Obsidian community catalog entry points at this repository; normal plugin updates do not require another catalog submission.

## Feedback & license

[Report a bug or suggest an improvement](https://github.com/hemashishi12/mixed-outline/issues). Include your Obsidian version, plugin version, and a minimal example using non-private sample text.

Released under the [MIT License](LICENSE).
