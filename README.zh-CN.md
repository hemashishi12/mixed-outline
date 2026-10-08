<p align="center"><img src="docs/hero.svg" alt="Mixed Outline：找到位置，继续写作" width="100%"></p>

<h1 align="center">Mixed Outline · 混合大纲</h1>
<p align="center">把标题和有序列表放进同一棵大纲树，快速定位，随时续写。</p>
<p align="center"><a href="README.md">English</a> · <a href="https://github.com/hemashishi12/mixed-outline/releases/latest">最新版本</a> · <a href="CHANGELOG.md">更新记录</a></p>

## 为写作结构而生

读书笔记、学习提纲、项目计划和长文草稿，常常同时使用标题与编号列表。Mixed Outline 把它们组合在右侧栏，点击即可定位到原文。

- **混合大纲**：同时展示标题、有序列表及嵌套层级。
- **跳转到最后**：一步到达文末，把光标放在空行，立即接着写。
- **跟随阅读位置**：可选的滚动同步会展开当前路径、高亮当前位置。
- **展开与折叠**：工具栏一键整理大纲。
- **实时刷新**：编辑内容或切换笔记时自动更新。

上方为使用虚构内容制作的示意图。仓库不包含私人知识库截图。

## 安装与更新

1. 打开 Obsidian **设置 → 第三方插件 → 浏览**。
2. 搜索 **Mixed Outline**，安装并启用。
3. 点击左侧功能区的插件图标，或在命令面板运行 **Mixed Outline: Open mixed outline**。

已安装的用户可在第三方插件设置中点击 **检查更新**。

手动安装：从[最新 Release](https://github.com/hemashishi12/mixed-outline/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<你的库>/.obsidian/plugins/mixed-outline/`，重载 Obsidian 后启用。升级时保留存储个人设置的 `data.json`。

最低要求为 **Obsidian 1.5.0**。插件使用 Obsidian API，无 Node.js / Electron 运行时依赖，声明兼容桌面端和移动端。本次 1.1.0 已在桌面端实测，移动端尚未单独验证。

## 新功能：跳转到最后

工具栏最右侧新增一个 **向下箭头落到横线** 的按钮，悬浮提示为 **跳转到最后 / Jump to end**。

点击后，插件激活当前笔记的编辑器，滚动到文末并聚焦光标：

| 笔记状态 | 点击后的行为 |
| --- | --- |
| 最后一行有文字 | 在末尾补一个换行，光标放到新行开头。 |
| 已有空白末行 | 直接将光标放到该行，反复点击不会堆积空行。 |
| 空笔记 | 在第一行直接开始输入。 |
| 阅读模式 | 先切换到编辑状态，再定位文末。 |
| 末尾是编号列表或有选中文本 | 保留原文，追加换行时不会删除选中内容或自动补列表编号。 |

命令面板同样可以运行 **Mixed Outline: Jump to end / 跳转到最后**。可在 **设置 → 快捷键** 中为它绑定快捷键。没有可用 Markdown 笔记时，工具栏按钮不可用。

## 大纲识别规则

支持 `#` 到 `######` 的 ATX 标题，以及 `1.`、`2)` 等有序列表标记。编号条目按所属标题和缩进组织层级。

跳过 YAML 属性区、围栏代码块、无序列表、任务列表，以及藏在无序列表或任务列表下面的编号条目。

## 设置

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| Show headings | 开 | 显示标题。 |
| Show ordered lists | 开 | 显示有序列表。 |
| Strip Markdown formatting | 开 | 简化标签中的 Markdown 标记。 |
| Maximum item length | 160 | 限制标签长度，可设为 20–500。 |
| Open on startup | 关 | 启动时自动打开大纲。 |
| Auto sync to scroll position | 关 | 跟随正文滚动，展开当前位置的祖先路径并折叠其他分支。 |

## 隐私与开发

笔记内容只在本地处理，无网络请求、遥测或账户要求。设置保存在插件的 `data.json` 中；“跳转到最后”只会在需要时为目标笔记追加一个换行。

这是一个可直接编辑的 JavaScript 插件，不需要构建或安装依赖。使用 Node.js 18+ 执行：

```sh
node --check main.js
node --test
```

修改后将三个插件文件复制到测试库并重载插件。架构说明、维护经验和发布方式见 [English README 的 Development 部分](README.md#development)。Release 标签必须与清单版本一致且不带 `v` 前缀；为已有插件发布更新无需重新提交市场收录申请。

欢迎[反馈问题](https://github.com/hemashishi12/mixed-outline/issues)，请附上版本号与不含私人内容的最小复现示例。

[MIT License](LICENSE)
