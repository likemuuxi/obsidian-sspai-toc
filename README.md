# Obsidian Sspai TOC Plugin

[中文版](#中文说明) below

An Obsidian plugin that adds a floating Table of Contents styled after [Sspai (少数派)](https://sspai.com/). It features a minimalist design with intelligent active state highlighting, providing a clean and focused reading experience.

![Demo](https://raw.githubusercontent.com/obsidianmd/obsidian-sample-plugin/master/header.png) *<!-- Replace with actual screenshot if available -->*

## Features

- **Minimalist "Sspai" Design**: 
  - A clean, floating right-side TOC.
  - Dashed lines indicate hierarchy depth.
  - Parent items fade out to reduce visual noise, spotlighting only the active section.
- **Intelligent Visibility**:
  - Only the active header's text is fully visible.
  - Parent nodes of the active header remain visible to show context.
  - Other headers fade into subtle dashed lines.
- **Dual-Mode Support**:
  - **Editing Mode (Live Preview)**: Accurate scroll tracking using CodeMirror 6 API.
  - **Reading Mode**: Robust synchronization using text-based header matching, ensuring the TOC stays correct even with lazy-loading or embedded content.
- **Smooth Navigation**:
  - Click any item to smoothly scroll to that section.
  - Uses native Obsidian navigation for consistent behavior.
- **Dynamic Positioning**:
  - The "Active" state triggers at the user's natural reading position (approx. 1/3 down the screen), not just at the very top.

## Installation

### Manual Installation
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the Releases page.
2. Create a folder named `obsidian-sspai-toc` in your Obsidian vault's `.obsidian/plugins/` directory.
3. Move the downloaded files into that folder.
4. Reload Obsidian and enable the plugin in Settings.

## Usage
Once enabled, the TOC will automatically appear on the right side of your Markdown notes. It persists across different views and handles sidebar interactions gracefully.

---

<a name="中文说明"></a>
# Obsidian Sspai TOC 插件 (少数派风格目录)

一款模仿 [少数派 (Sspai)](https://sspai.com/) 文章目录样式的 Obsidian 插件。它采用了极简设计，通过智能的高亮和隐藏逻辑，为您提供专注、纯净的阅读体验。

## 核心特性

- **少数派风格极简设计**: 
  - 悬浮于右侧的优雅目录。
  - 使用长短不一的短横线代表标题层级。
  - **智能隐藏**: 也就是该插件的精髓——非当前阅读的标题会自动隐藏文字，仅显示层级横线；只有当前激活的标题及其父级标题会显示文字。减少视觉干扰，让您专注于当下。
- **双模式完美支持**:
  - **编辑模式 (Live Preview)**: 基于 CodeMirror 6 API 的精确光标与滚动追踪。
  - **阅读模式**: 采用鲁棒的“文本匹配”算法，完美解决阅读模式下长文懒加载（Virtualization）导致的目录不同步问题。
- **流畅导航**:
  - 点击目录项即可平滑滚动至对应段落。
  - 使用 Obsidian 原生跳转 API，体验丝般顺滑。
- **符合直觉的阅读线**:
  - 激活状态的判定线位于屏幕约 1/3 处，符合人类自然的阅读视线，而非死板的屏幕顶部。

## 安装方法

### 手动安装
1. 下载最新发行版中的 `main.js`, `manifest.json`, `styles.css` 文件。
2. 在您的 Obsidian 仓库 `.obsidian/plugins/` 目录下新建文件夹 `obsidian-sspai-toc`。
3. 将下载的文件放入该文件夹。
4. 重启 Obsidian 并在设置中启用插件。

## 使用说明
启用插件后，目录将自动出现在 Markdown 笔记的右侧。
- 点击侧边栏或其他面板时，目录会保持静默，不会突然消失。
- 只有当您切换到非文档视图（如白板）时才会自动隐藏。

---
**Author / 作者**: Muuxi
**License**: MIT
