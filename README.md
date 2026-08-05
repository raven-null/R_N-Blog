# 个人博客系统

一个基于纯前端技术的个人博客系统，专为GitHub Pages设计。

## ✨ 特性

- 🚀 **纯前端** - 无需后端，直接部署到GitHub Pages
- 📝 **Markdown支持** - 丢入.md文件即可显示
- 🏷️ **标签分类** - 自动提取标签，支持分类筛选
- 🎨 **十套主题** - 暗黑、白色、赛博朋克、复古纸张、霓虹等十种风格
- 🌟 **科技感UI** - 全屏Hero区、CSS动画、滚动渐入效果
- 📱 **响应式** - 适配各种屏幕尺寸，移动端专属悬浮球菜单
- 💻 **代码高亮** - 支持多种编程语言，一键复制代码
- 🔍 **下拉搜索** - 从导航栏搜索图标下拉打开，快速筛选文章
- 🖼️ **图片灯箱** - 点击图片放大查看，支持缩放和拖拽
- 📑 **固定目录** - 文章页左侧目录栏固定，支持搜索和自动高亮
- 🤖 **AI 助手** - 内置智能对话助手，支持拖拽和调整大小
- 📋 **一键复制** - 代码块和引用块支持一键复制功能

## 🚀 快速开始

### 本地运行

```bash
# 使用Node.js
npm install -g http-server
http-server -p 8080

# 或使用Python
python -m http.server 8080

# 或使用VS Code的Live Server插件
# 右键点击index.html -> Open with Live Server
```

### 部署到GitHub Pages

1. Fork或克隆本仓库
2. 上传你的Markdown文件到 `posts` 文件夹
3. 更新 `posts/manifest.json`
4. 在仓库Settings中启用GitHub Pages（Source选择`main`分支，目录选择`/ (root)`）
5. 添加`.nojekyll`文件到项目根目录（确保GitHub Pages正确处理所有文件）
6. 等待5-10分钟即可访问

**详细部署指南：** [GitHub Pages部署指南](posts/github-project-modification.md)

## 📝 添加文章

### 步骤一：创建Markdown文件

在 `posts` 文件夹创建 `.md` 文件，例如：`my-new-article.md`

### 步骤二：添加Frontmatter

文件开头必须包含Frontmatter信息：

```yaml
---
title: 文章标题
date: 2026-07-21
tags: [标签1, 标签2]
author: 作者名
excerpt: 文章摘要，会显示在首页卡片上
image: images/cover.jpg  # 可选，封面图片路径
---

正文内容...
```

**Frontmatter字段说明：**

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| title | 是 | 文章标题 | `我的第一篇文章` |
| date | 是 | 发布日期 | `2026-07-21` |
| tags | 是 | 标签数组 | `[技术, JavaScript]` |
| author | 否 | 作者名 | `渡鸦NULL` |
| excerpt | 否 | 文章摘要 | `这是摘要...` |
| image | 否 | 封面图片URL | `images/cover.jpg` |

### 步骤三：更新manifest.json

打开 `posts/manifest.json` 文件，添加新文章的文件名：

```json
[
    "blog-usage-guide.md",
    "github-guide.md",
    "javascript-async.md",
    "my-new-article.md"
]
```

### 步骤四：刷新页面

刷新博客页面，新文章将自动显示。

### 使用图片

将图片放入 `images/` 文件夹，在Markdown中引用：

```markdown
![图片说明文字](images/assets/01-blog-usage-guide/1.jpg)
```

- 图片说明文字（alt文本）会自动显示在图片下方作为说明
- 支持相对路径和绝对URL
- 点击图片可打开灯箱放大查看，支持缩放和拖拽

## 🎨 主题切换

点击主题按钮循环切换，共十套风格：

| 主题 | 图标 | 说明 |
|------|------|------|
| Dark | ◐ | 暗黑模式（默认） |
| Light | ○ | 白色模式 |
| Cyberpunk | ◈ | 赛博朋克（紫色霓虹风格） |
| Sepia | ◎ | 复古纸张（暖色调，适合阅读） |
| Neon | ◆ | 霓虹风格（深紫底色 + 粉青点缀） |
| Nord | ❖ | Nord 配色（冷色调灰蓝，护眼舒适） |
| Dracula | ❂ | 吸血鬼主题（深紫灰 + 紫色强调） |
| Ocean | ≋ | 深海风格（深蓝底色 + 青绿强调） |
| Forest | ♧ | 森林风格（深绿底色 + 绿色强调） |
| Sunset | ☀ | 日落风格（深红底色 + 粉橙强调） |

所有 UI 元素（粒子、滚动条、导航栏、卡片等）均跟随主题变化，主题选择会自动保存到本地存储。

## 🔍 搜索功能

点击导航栏右侧的搜索图标，会从图标下方弹出搜索框：

- 输入关键词即时筛选文章
- 按 `ESC` 或点击外部区域关闭
- 支持按标题、摘要、标签搜索

## 📑 文章目录

文章详情页左侧显示固定目录栏：

- 目录栏固定在屏幕左侧，不随文章滚动
- 返回首页按钮与目录之间有明确间隔
- 目录列表独立滚动，阅读文章时自动高亮当前章节
- 点击目录项平滑滚动到对应位置
- 支持目录搜索功能，快速定位标题
- 屏幕宽度 ≤ 768px 时目录自动隐藏，通过悬浮球菜单访问

## 🖼️ 图片灯箱

文章中的图片支持灯箱功能：

- 点击图片打开灯箱放大查看
- 支持鼠标滚轮缩放（0.5x - 5x）
- 支持拖拽已缩放的图片
- 按 `ESC` 或点击外部区域关闭
- 移动端支持触摸缩放

## 📋 代码复制

文章中的代码块和引用块支持一键复制：

- 代码块右上角显示复制按钮
- 引用块右上角显示复制按钮
- 点击后显示"已复制"提示
- 2秒后自动恢复原始状态

## 🤖 AI 智能助手

内置 AI 对话助手，支持大语言模型问答。

### 配置

打开 `js/chat.js`，替换 API Key：

```javascript
config: {
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: 'YOUR_API_KEY_HERE',  // 替换为你的智谱 API Key
    model: 'glm-4-flash',
    maxTokens: 1024
}
```

API Key 获取地址：https://open.bigmodel.cn/

### 使用

- 点击右下角聊天图标打开对话窗口
- 在底部输入框输入问题，回车或点击发送
- 对话历史自动保存，刷新页面不丢失
- 支持清空对话、关闭窗口
- 支持拖拽移动窗口位置
- 支持拖拽左上角调整窗口大小

### 切换 AI 模型

在 `js/chat.js` 中修改 `model` 字段：

```javascript
config: {
    model: 'glm-4-flash',   // 快速模型
    // model: 'glm-4',      // 标准模型
    // model: 'glm-4v',     // 多模态模型（支持图片）
}
```

## 📱 移动端适配

博客针对移动端进行了专门优化：

- **悬浮球菜单**：屏幕宽度 < 773px 时显示右下角悬浮球
- **弹出菜单**：点击悬浮球显示目录、返回、首页、主题、AI助手等快捷操作
- **侧边栏**：移动端目录栏通过悬浮球菜单打开，覆盖全屏
- **响应式布局**：文章卡片自动适配不同屏幕尺寸

## 📁 项目结构

```
├── index.html              # 首页
├── article.html            # 文章详情页
├── .nojekyll               # 告诉GitHub Pages不使用Jekyll处理
├── css/
│   ├── style.css           # 主样式（包含所有主题和响应式样式）
│   └── highlight-github-dark.min.css  # 代码高亮样式
├── js/
│   ├── app.js              # 首页核心逻辑（文章加载、筛选、搜索、分页）
│   ├── markdown.js         # Markdown解析（frontmatter提取、Markdown渲染）
│   ├── theme.js            # 主题管理（10套主题、CSS变量更新、持久化）
│   ├── chat.js             # AI 对话助手（API调用、拖拽、调整大小、历史保存）
│   └── vendor/
│       ├── marked.min.js   # Markdown解析库
│       └── highlight.min.js # 代码高亮库
├── images/                 # 图片资源目录
│   ├── BG/                 # 默认封面图片目录
│   └── system1.jpg         # 系统图标
├── posts/                  # Markdown文章
│   ├── manifest.json       # 文章列表（JSON数组格式）
│   ├── blog-usage-guide.md # 博客使用手册
│   ├── github-guide.md     # GitHub指南
│   ├── javascript-async.md # JavaScript异步教程
│   └── *.md                # 其他文章文件
└── docs/                   # 文档
    ├── 项目文档.md          # 项目架构文档
    └── 操作文档.md          # 使用指南和常见问题
```

## 🛠️ 自定义

### 修改配置

编辑 `js/app.js` 中的配置：

```javascript
config: {
    postsDirectory: 'posts',    // 文章目录
    postsPerPage: 10            // 每页显示文章数量
}
```

### 添加主题

在 `js/theme.js` 的 `themes` 对象中添加新主题，需包含以下 CSS 变量：

```javascript
新主题: {
    name: '主题名',
    icon: '图标',  // 单字符图标
    colors: {
        '--bg-primary': '#背景色',
        '--bg-secondary': '#次要背景',
        '--bg-tertiary': '#三级背景',
        '--bg-card': '#卡片背景',
        '--text-primary': '#主文字',
        '--text-secondary': '#次要文字',
        '--text-muted': '#弱化文字',
        '--accent': '#强调色',
        '--accent-dim': '#次要强调色',
        '--border': '#边框色',
        '--border-light': '#浅边框色',
        '--shadow': 'rgba(r, g, b, alpha)',  // 阴影色
        '--glow': 'rgba(r, g, b, alpha)'     // 发光色
    }
}
```

### 修改AI助手人格

在 `js/chat.js` 中修改系统提示词：

```javascript
{
    role: 'system',
    content: '你是一名博客管理员，名叫渡鸦_001。你的职责是：1. 热情友好地接待每一位访客；2. 回答关于博客内容、技术文章的问题；3. 你的所有回复都要体现你作为管理员的身份。'
}
```

## 📖 文档

- [项目文档](docs/项目文档.md) - 详细了解项目架构
- [操作文档](docs/操作文档.md) - 使用指南和常见问题
- [GitHub项目修改指南](posts/github-project-modification.md) - 如何修改和部署项目

## 🌐 浏览器支持

- Chrome 60+
- Firefox 60+
- Safari 12+
- Edge 79+

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📧 联系

如有问题，请提交Issue。

---

**最后更新：** 2026-07-21
**维护者：** 渡鸦NULL
