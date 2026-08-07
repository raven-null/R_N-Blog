# 个人博客 · 渡鸦NULL

一个基于纯前端技术的个人博客，部署于 GitHub Pages（<https://ravennull.work>），无需后端即可运行。

## ✨ 特性

- 🚀 **纯前端** - HTML5 / CSS3 / 原生 JS（ES6+），无需后端，直接部署 GitHub Pages
- 📝 **Markdown 文章** - `posts` 目录丢入 `.md` 文件即可显示
- 🏷️ **标签体系** - 标签按钮弹出面板，展示全部标签及文章计数，支持筛选
- 🎨 **十套主题** - Dark / Light / Cyberpunk / Sepia / Neon / Nord / Dracula / Ocean / Forest / Sunset，自动持久化
- 🖼️ **四视图** - 文章（瀑布流卡片）/ 图库（灯箱相册）/ 每日新闻（资讯列表，按出品方筛选）/ 我的（个人仪表盘），顶栏滑块切换
- 📰 **每日新闻** - 后端 NewsNow API 聚合 17 个热门来源，每小时更新；失败自动回退本地数据；按新闻出品方筛选
- 💬 **留言系统** - 文章页与「我的」仪表盘均支持留言，数据存于后端 Netlify Blobs（`/api/comments`）
- 📚 **阅读体验** - 阅读工具栏（字号 / 行距 / 字体 / 护眼 / 夜间 / 专注）、目录、进度条、代码复制、图片灯箱
- ⚡ **动画** - Anime.js 驱动卡片入场、视图切换等动效
- 🤖 **AI 助手** - 内置智谱 GLM-4 对话助手，支持流式输出与划词问答
- 📱 **响应式** - 适配各种屏幕尺寸，移动端悬浮球快捷操作

## 🚀 快速开始

### 本地运行

```bash
# 方式一：Node.js
npm install -g http-server
http-server -p 8080

# 方式二：Python
python -m http.server 8080

# 方式三：VS Code Live Server
# 右键 index.html -> Open with Live Server
```

> 本地运行无后端时，每日新闻与留言会显示"功能暂时不可用"或回退本地数据；完整功能需部署后端（见下文「后端服务」）。

### 部署到 GitHub Pages

1. Fork 或克隆本仓库
2. 根目录已包含 `.nojekyll` 与 `CNAME`（域名 `ravennull.work`），确保 GitHub Pages 正确处理文件与自定义域名
3. 在仓库 Settings 中启用 GitHub Pages，Source 选择 `main` 分支、目录 `/ (root)`
4. 根目录的 `feed.xml` 提供 RSS 订阅
5. 等待数分钟即可通过域名访问

### 后端服务（可选，用于资讯与留言）

每日新闻与留言功能依赖 Netlify 后端（`https://r-n-blog-server.netlify.app`，代码在独立仓库 `02-blog-server`）。后端不可用时：

- **每日新闻**：自动回退读取本地 `data/recommendations.json`
- **留言**：显示「留言功能暂时不可用」

## 📝 添加文章

### 步骤一：创建 Markdown 文件

在 `posts` 目录创建 `.md` 文件，如 `my-new-article.md`。

### 步骤二：添加 Frontmatter

文件开头必须包含 Frontmatter：

```yaml
---
title: 文章标题
date: 2026-08-05
tags: [技术, 生活]
author: 渡鸦NULL
excerpt: 文章摘要，显示在首页卡片上
image: images/BG/01_BG.webp  # 可选，封面图片
update: 2026-08-06            # 可选，更新时间
---

正文内容...
```

| 字段 | 必填 | 说明 |
|------|------|------|
| title | 是 | 文章标题 |
| date | 是 | 发布日期 |
| tags | 是 | 标签数组 |
| author | 否 | 作者名 |
| excerpt | 否 | 文章摘要 |
| image | 否 | 封面图片路径 |
| update | 否 | 更新时间 |

### 步骤三：更新 manifest.json

在 `posts/manifest.json` 中添加文件名：

```json
[
    "01-blog-usage-guide.md",
    "my-new-article.md"
]
```

### 步骤四：刷新页面

刷新博客页面，新文章将自动显示。

## 🖼️ 图库加图

图库图片存放于 `images/R-N-picture` 目录，添加后运行脚本生成索引：

```bash
node scripts/build-gallery.js
```

运行完成后提交生成的文件即可，图库支持灯箱查看、左右切换、下载、幻灯片放映与页码跳转。

## 📰 每日新闻

「每日新闻」视图以**列表形式**展示聚合资讯（无卡片图片），顶部按**新闻出品方**筛选。数据优先来自后端 NewsNow API（`/api/news`，聚合 17 个热门来源、每小时更新），失败时回退本地 `data/recommendations.json`；点击新闻在新窗口打开原文或站内阅读。

**更新方式：**

1. **自动（推荐，每日更新）**：GitHub Actions 每天 08:00 运行 `node scripts/update-news.js` 抓取各来源 RSS 自动生成并提交；也可在 Actions 页面手动触发 `Update News Daily`
2. **手动**：直接编辑 `data/recommendations.json` 提交推送即可

- 本地生成：`node scripts/update-news.js`（`--dry` 预览不落盘）
- 校验：`node scripts/check-recommendations.js`（`--check` 追加链接体检）

## 💬 留言

文章页底部与「我的」仪表盘均提供留言功能：

- 填写**昵称**（必填）与**留言内容**（必填），邮箱可选（不会被公开）
- 数据通过后端 `/api/comments` 存于 **Netlify Blobs**，按 `postId` 隔离（文章用文件名，仪表盘用 `dashboard`）
- 单篇文章最多 500 条；内容最多 5000 字；超 3 个链接视为垃圾信息会被拦截

## 🎨 主题

点击顶栏主题按钮切换，共十套风格：Dark（暗黑，默认）、Light（白色）、Cyberpunk（赛博朋克）、Sepia（复古纸张）、Neon（霓虹）、Nord（冷色调灰蓝）、Dracula、Ocean、Forest、Sunset。

所有 UI 元素（导航栏、卡片、滚动条、粒子等）均跟随主题变化，选择自动保存到本地存储。

## 🔍 搜索

导航栏搜索框输入关键词，按标题、摘要、标签即时筛选文章。

## 📑 目录

文章页左侧固定目录栏，支持目录搜索与折叠，默认展开；阅读时自动高亮当前章节，点击平滑滚动定位。

## 🖼️ 图片灯箱

文章图片与图库图片均支持灯箱查看：点击放大、缩放与拖拽、`ESC` 关闭；图库灯箱额外支持左右切换、下载、幻灯片与页码。

## 📋 代码复制

代码块右上角一键复制，点击显示"已复制"，2 秒后自动恢复。

## 🤖 AI 助手

文章页内置 AI 对话助手（智谱 GLM-4）：

- 流式输出与停止生成、Markdown 渲染
- 复制 / 重新生成回复，多会话管理
- 窗口位置记忆、未读消息角标、字数统计
- `/` 快捷指令；划词选中正文即可快速问答（解释 / 翻译 / 润色）

## 📱 移动端

- 顶栏视图切换、吸顶导航自动适配
- 阅读目录通过移动端悬浮球访问
- 悬浮球含返回、首页、主题、AI 助手等快捷操作
- 图片灯箱支持触摸缩放

## 📁 项目结构

```
├── index.html / article.html    # 首页（四视图）/ 文章详情页（含留言区）
├── feed.xml / CNAME / .nojekyll # RSS / 自定义域名 / Jekyll 关闭标记
├── .github/workflows/
│   └── update-news.yml          # 每日资讯自动更新（GitHub Actions）
├── css/
│   ├── style.css                # 主样式（主题、响应式）
│   └── highlight-github-dark.min.css  # 代码高亮
├── js/
│   ├── app.js                   # 首页逻辑（加载、筛选、搜索、四视图、资讯、留言）
│   ├── markdown.js              # Markdown 解析（frontmatter、渲染）
│   ├── theme.js                 # 主题管理（10 套主题、持久化）
│   ├── chat.js                  # AI 助手（流式、多会话、划词问答）
│   ├── reader.js                # 文章阅读（目录、工具栏、快捷键、进度）
│   ├── animations.js            # Anime.js 动画
│   └── vendor/                  # anime.umd.min.js / marked.min.js / highlight.min.js
├── scripts/
│   ├── build-gallery.js         # 图库索引生成脚本
│   ├── update-news.js           # 资讯自动更新（抓取 RSS 生成 recommendations.json）
│   └── check-recommendations.js # 资讯数据校验 / 链接体检
├── data/
│   └── recommendations.json     # 本地资讯数据（后端失败时回退）
├── images/
│   ├── BG/                      # 封面图
│   ├── R-N-picture/             # 图库图片（生成 manifest.json）
│   ├── TX/                      # 作者头像（01_TX 渡鸦NULL / 02_TX AI / 03_TX 其他）
│   └── assets/                  # 文章内嵌图片
├── posts/                       # 文章（*.md + manifest.json）
└── docs/                        # 文档
    ├── 项目文档.md / 操作文档.md / 更新日志.md / 文章模板.md / AI建议文档.md
```

## 🛠️ 自定义

- **主题**：在 `js/theme.js` 的 `themes` 对象中添加主题（`name` / `icon` / `colors` CSS 变量）
- **AI 助手**：在 `js/chat.js` 中修改系统提示词（人格）与 API Key（`config.apiKey`）
- **后端地址**：`js/app.js` 与 `article.html` 中的 `apiBase`（默认 `https://r-n-blog-server.netlify.app`）
- **新闻来源**：`scripts/update-news.js` 的 `SOURCES` 数组（名称 + RSS 地址 + 默认分类）

## 📖 文档

- [项目文档](docs/项目文档.md) - 项目架构说明
- [操作文档](docs/操作文档.md) - 使用指南与常见问题
- [更新日志](docs/更新日志.md) - 版本更新记录
- [文章模板](docs/文章模板.md) - 写文章参考模板
- [AI建议文档](docs/AI建议文档.md) - AI 相关使用建议

## 📄 许可证

MIT License

---

**最后更新：** 2026-08-07
**维护者：** 渡鸦NULL
