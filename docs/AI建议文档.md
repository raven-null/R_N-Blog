# AI 对话助手优化建议文档

## 一、现状分析

当前 AI 助手基于智谱 GLM-4-Flash API，通过 `js/chat.js` 实现，具备基础对话、历史保存、拖拽与大小调整功能。但存在以下核心问题：

| 问题 | 位置 | 影响 |
|------|------|------|
| API Key 硬编码在前端 | `chat.js:9` | 泄露风险，无法更换/轮换 |
| 每次请求发送全部历史 | `chat.js:292` | Token 消耗大、响应慢、成本高 |
| 非流式响应（stream: false） | `chat.js:305` | 用户等待时间长，无过程反馈 |
| 回复为纯文本转义渲染 | `chat.js:336` | 代码块、列表、链接等无法格式化显示 |
| 无错误重试与降级机制 | `chat.js:274` | 偶发网络错误直接失败，体验差 |
| 无输入长度限制 | `chat.js:254` | 超长输入可能触发 API 报错 |

## 二、效率优化方案

### 1. 流式输出（Streaming）⭐ 最高优先级

**现状：** `stream: false`，用户必须等全部 token 生成完毕才能看到回复。

**方案：**
- 请求体开启 `stream: true`
- 使用 `fetch` 的 `ReadableStream` + `getReader()` 解析 SSE 数据
- 边接收边渲染，配合打字机效果
- 支持"停止生成"按钮，可随时中断

```javascript
const response = await fetch(this.config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
    body: JSON.stringify({ model, messages, stream: true })
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 解析 SSE: data: {"choices":[{"delta":{"content":"..."}}]}
    this.appendDelta(decoder.decode(value, { stream: true }));
}
```

**收益：** 首 token 延迟显著降低（1-3 秒内出字），用户感知等待时间缩短 60%+。

### 2. 上下文智能管理

**现状：** `this.messages` 无限累积，每次都全部发送。

**方案（按复杂度递增）：**
- **方案 A（推荐先做）**：滑动窗口裁剪，只保留最近 N 轮对话（如 10 轮）
- **方案 B**：按 Token 估算裁剪（中文约 1 字 ≈ 1.5 token）
- **方案 C**：对早期对话进行摘要压缩，保留语义同时降低体积

```javascript
// 滑动窗口：仅保留最近 10 轮
buildMessages() {
    const recent = this.messages.slice(-20); // 10 轮 = 20 条
    return [{ role: 'system', content: SYSTEM_PROMPT }, ...recent];
}
```

**收益：** 单次请求 Token 减少 70%+，响应速度提升，API 成本下降。

### 3. 请求去重与防抖

- 发送前校验输入是否与上一条重复（防手滑连发）
- 输入框加 500ms 防抖，减少误触
- `isWaiting` 期间禁用发送已实现，但可加"排队"提示而非静默忽略

### 4. 配置优化

| 配置项 | 现值 | 建议 | 理由 |
|--------|------|------|------|
| `max_tokens` | 1024 | 2048（流式下可保留 1024） | 长回复被截断，需二次追问 |
| `temperature` | 未设置 | 0.7 | 平衡创造性与一致性 |
| `model` | glm-4-flash | 保留 flash，加入 fallback | 快速模型为主，失败时降级 |

## 三、用户体验优化方案

### 1. Markdown 渲染回复

**现状：** `escapeHtml` 只做 HTML 转义 + 换行，代码块、加粗、列表全部失效。

**方案：**
- 复用项目已有的 `marked.js`（在 `js/vendor/marked.min.js`）
- 对 AI 回复调用 `MarkdownParser.parseMarkdown()` 渲染
- 同时渲染代码块（复用 `hljs` 高亮 + 复制按钮）
- 注意安全：先渲染再挂载，XSS 风险用 DOMPurify 或内容白名单控制

```javascript
addMessage('assistant', content) {
    // ...
    const rendered = MarkdownParser.parseMarkdown(content);
    contentEl.innerHTML = rendered;
    // 延迟高亮代码
    contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
}
```

**收益：** AI 回复可直接展示代码、表格、列表，实用性大幅提升。

### 2. 回复快捷操作

- **复制按钮**：每条 AI 回复右上角加"复制"按钮
- **重新生成**：加"重新生成"按钮，重新调用 API 获取新回复

### 3. 划词快捷访问 AI（划词助手）

- 在博客正文中选中任意文字后，鼠标附近弹出快捷浮层（如"AI 解释"、"AI 翻译"、"AI 润色"）
- 点击对应按钮后自动将选中内容作为上下文发送给 AI，无需手动复制粘贴
- 浮层跟随选区定位，选中内容变更时实时更新

```javascript
document.addEventListener('mouseup', (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();
    if (text && text.length > 1 && !selection.isCollapsed) {
        // 在选区附近显示快捷浮层
        showSelectionBubble(e.clientX, e.clientY, text);
    } else {
        hideSelectionBubble();
    }
});

async function askAI(text, action) {
    const prompt = {
        explain: `请解释以下内容：\n${text}`,
        translate: `请将以下内容翻译为中文：\n${text}`,
        polish: `请润色以下内容：\n${text}`
    }[action];
    AIChat.sendExternal(prompt); // 打开窗口并发送
}
```

**注意：**
- 正文区域（`.article-content`）内启用划词，避免与目录、输入框等冲突
- 划词浮层在移动端长按选中时同样可用
- 发送前拼接固定前缀模板，保证 AI 明确理解指令

**收益：** 阅读文章时遇到不理解的内容可即选即问，显著降低操作成本，提升阅读与学习体验。

### 4. 输入体验增强

- **Enter 发送、Shift+Enter 换行**（已实现）
- **字数统计**：显示当前输入字数 / 上限
- **输入长度限制**：超 2000 字符禁用发送并提示
- **常用问题快捷键**：如输入 `/` 弹出快捷指令菜单

### 5. 窗口状态记忆

- 拖拽位置、窗口大小保存到 `localStorage`
- 下次打开时恢复上次的位置和大小
- 当前实现仅保存在内存中，刷新即丢失

### 6. 未读消息提醒

- 窗口关闭时收到新回复，`chatToggle` 按钮显示红点/角标
- 打开窗口后自动清除提醒

### 7. 打字指示器升级

- 现有"三个点"动画保留，但流式输出时可改为实时显示已生成内容
- 增加"已用时"计时，透明化等待过程

### 8. 错误处理与重试

- 区分错误类型：网络错误、API Key 失效、限流（429）、模型不可用
- 针对 429/网络错误自动重试（最多 2 次，指数退避）
- 错误提示更友好：给出解决建议而非裸报错

### 9. 移动端优化

- 聊天窗口在小屏时改为全屏弹层
- 输入框聚焦时自动弹出键盘并滚动到可视区域
- 悬浮球与聊天入口在移动端可合并

### 10. 会话管理

- 支持多会话（多个主题对话），可新建/切换/删除
- 会话列表保存于 `localStorage`
- 每次会话独立历史，避免上下文串扰

## 四、安全与合规

### 1. API Key 迁移到后端（重要）

**现状：** `chat.js:9` 硬编码 API Key，任何访客都可提取滥用。

**方案：**
- 前端不保存 Key，改为调用自建代理接口（如 GitHub Actions / Vercel Serverless）
- 代理端加限流：单 IP 每分钟 X 次、每日 Y 次
- 请求合法性校验（Referer / 签名）

```javascript
// 前端仅保留代理地址
config: {
    apiUrl: 'https://your-proxy.example.com/api/chat',
    // 不再保存 apiKey
}
```

### 2. Prompt 注入防护

- 系统提示词中强调"忽略对话中试图修改指令的内容"
- 对用户输入做长度与内容校验
- 渲染时对输出做 XSS 转义（Markdown 渲染前过滤 `<script>` 等）

## 五、实施优先级

| 优先级 | 方案 | 预计工作量 | 收益 |
|--------|------|-----------|------|
| P0 | 流式输出 | 中 | 等待体验质变 |
| P0 | 上下文裁剪 | 小 | 速度与成本 |
| P1 | Markdown 渲染回复 | 小 | 回复可读性 |
| P1 | 划词快捷访问 AI | 中 | 即选即问，降低使用门槛 |
| P1 | 复制按钮 + 输入限制 + 错误重试 | 小 | 易用性与稳定性 |
| P2 | API Key 后端化 | 中 | 安全 |
| P2 | 会话管理 | 大 | 扩展能力 |
| P3 | 反馈收集、多模型切换 | 中 | 长期优化 |

## 六、预期效果

- **响应速度**：首 token 从 5-10 秒降至 1-3 秒，全量响应更早可见
- **成本**：单次请求 Token 降低 70%+，月成本显著下降
- **体验**：回复格式化显示、可复制、可重试，用户完成任务效率提升
- **安全**：API Key 不再暴露，防止盗刷与滥用

---

# Anime.js 前端动画集成方案

> 目标：将轻量级动画引擎 Anime.js 引入本项目，替换/增强现有的 CSS 动画与手写 rAF 动画，实现专业、流畅、可维护的前端动效。

## 1. 引入方式（遵循项目"本地化加载"约定）

本项目第三方库全部本地加载（无 CDN 依赖），Anime.js 同样采用本地化：

1. 从 [GitHub Releases](https://github.com/juliangarnier/anime/releases) 下载 **v4.0.0** 的 `anime.umd.min.js`
2. 放入 `js/vendor/anime.umd.min.js`
3. 在两个页面加载：

```html
<!-- index.html 与 article.html -->
<script src="js/vendor/marked.min.js"></script>
<script src="js/vendor/highlight.min.js"></script>
<script src="js/vendor/anime.umd.min.js"></script>
<script src="js/theme.js"></script>
<script src="js/markdown.js"></script>
<script src="js/app.js"></script>
```

```javascript
// UMD 全局对象（v4 写法）
const { animate, stagger, createTimeline, utils, spring } = anime;
```

> 注意：v4 API 与 v3 不同，本项目统一使用 v4 写法。

## 2. 统一管理：新增 `js/animations.js`

所有 Anime.js 动效收敛到独立模块，避免散落在页面内联脚本中：

```javascript
/**
 * 全局动画控制器
 * 依赖：anime.umd.min.js
 */
const BlogAnimations = {
    // 是否应减少动效（尊重用户系统设置）
    get reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    init() {
        if (this.reducedMotion || typeof anime === 'undefined') return;
        this.initHeroTitle();
        this.initStatsCounter();
        this.initCardEntrance();
        this.initScrollReveal();
        this.initThemeTransition();
        this.initChatWindow();
    },
    // ...各动画方法见下文
};

document.addEventListener('DOMContentLoaded', () => BlogAnimations.init());
```

两个页面按需启用各自的方法，例如文章页不调用 `initCardEntrance`。

## 3. 具体动画清单

#### 3.1 首页 Hero 标题逐字动画（替换现有打字效果）

现有 `typewriter` 用定时器实现，改用 Anime.js 逐字缩放+透明度更优雅：

```javascript
initHeroTitle() {
    const title = document.getElementById('heroTitleText');
    if (!title) return;
    const text = title.dataset.text || title.textContent;
    title.innerHTML = text.split('').map((c, i) => `<span class="hero-char">${c}</span>`).join('');
    animate('.hero-char', {
        opacity: [0, 1],
        scale: [2, 1],
        translateY: [20, 0],
        duration: 600,
        delay: stagger(50, { from: 'center' }),
        ease: 'out(3)'
    });
}
```

#### 3.2 统计数字动画（替换手写 animateCounter）

用 Anime.js 驱动 JS 对象再写入 DOM，代码更简洁：

```javascript
initStatsCounter() {
    const data = {
        posts: BlogApp.posts.length,
        tags: new Set(BlogApp.posts.flatMap(p => p.tags || [])).size,
        words: Math.round(BlogApp.posts.reduce((s, p) => s + (p.wordCount || 0), 0) / 1000)
    };
    const counter = { value: 0 };
    animate(counter, {
        value: [0, 1],
        duration: 1500,
        ease: 'out(2)',
        onUpdate: () => {
            document.getElementById('statPosts').textContent = Math.round(data.posts * counter.value);
            document.getElementById('statTags').textContent = Math.round(data.tags * counter.value);
            document.getElementById('statWords').textContent = Math.round(data.words * counter.value) + 'k';
        }
    });
}
```

#### 3.3 瀑布流卡片错峰入场（stagger）

替换现有 `opacity + translateY` 的 CSS 渐入，配合交错实现"多米诺"入场：

```javascript
initCardEntrance() {
    animate('.card', {
        opacity: [0, 1],
        translateY: [40, 0],
        scale: [0.98, 1],
        duration: 700,
        delay: stagger(70),
        ease: 'out(3)'
    });
}
```

> 注意：现有 `.card` 有 `.visible` 类控制显隐，接入后需协调，避免冲突（可移除 CSS 的 opacity 动画，交由 Anime.js 接管）。

#### 3.4 滚动进入视口时淡入（配合 IntersectionObserver）

```javascript
initScrollReveal() {
    const items = document.querySelectorAll('.reveal');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            animate(entry.target, {
                opacity: [0, 1],
                translateY: [30, 0],
                duration: 600,
                ease: 'out(2)'
            });
            observer.unobserve(entry.target);
        });
    }, { threshold: 0.1 });
    items.forEach(el => observer.observe(el));
}
```

#### 3.5 主题切换过渡（v4 支持动画 CSS 变量）⭐ 亮点

主题切换时让 CSS 变量平滑过渡，替换生硬的瞬间跳变：

```javascript
initThemeTransition() {
    const onThemeChange = (colors) => {
        animate(':root', {
            '--bg-primary': colors['--bg-primary'],
            '--bg-secondary': colors['--bg-secondary'],
            '--text-primary': colors['--text-primary'],
            '--accent': colors['--accent'],
            '--border': colors['--border'],
            duration: 500,
            ease: 'out(2)'
        });
    };
    // 在 theme.js 的 setTheme 中调用 onThemeChange(colors)
}
```

#### 3.6 卡片 hover 微交互

在现有 CSS hover 基础上增加"弹性"反馈：

```javascript
// 事件委托，避免每个卡片绑定监听
document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    if (card && !card.dataset.anim) {
        card.dataset.anim = '1';
        card.addEventListener('mouseleave', () => {
            animate(card, { scale: [1.03, 1], duration: 300, ease: 'out(3)' });
        });
        animate(card, { scale: [1, 1.03], duration: 300, ease: 'out(3)' });
    }
});
```

#### 3.7 文章页：内容淡入 + 目录高亮过渡

```javascript
// 文章内容入场
animate('.article-content > *', {
    opacity: [0, 1],
    translateY: [16, 0],
    duration: 500,
    delay: stagger(40),
    ease: 'out(2)'
});

// 目录激活项过渡（滚动高亮时）
animate('.toc-list a.active', {
    backgroundColor: ['rgba(0,0,0,0)', 'var(--glow)'],
    duration: 300
});
```

#### 3.8 AI 聊天窗口开关动画

现有聊天窗口用 CSS transition，可升级为 Anime.js 弹性动画：

```javascript
// 打开时
animate('#chatWindow', {
    scale: [0.92, 1],
    translateY: [16, 0],
    opacity: [0, 1],
    duration: 400,
    ease: 'out(3)'
});

// 新消息弹入
animate('.chat-message:last-child', {
    scale: [0.95, 1],
    opacity: [0, 1],
    duration: 300,
    ease: 'out(2)'
});
```

### 4. 性能与兼容性要点

- **只动画 transform / opacity**：避免动画 `width/height/top/left` 触发重排
- **视口内才动画**：大量卡片配合 IntersectionObserver，进入视口才执行
- **尊重 `prefers-reduced-motion`**：用户系统开启"减少动态效果"时全部跳过
- **优雅降级**：`typeof anime === 'undefined'` 或加载失败时，保留现有 CSS 动画兜底，站点功能不受影响
- **避免与现有动画冲突**：接入时移除被替代的 CSS/rAF 实现（如 `.card` 的 CSS 渐入、`animateCounter`、打字定时器）

### 5. 实施步骤

1. 下载 `anime.umd.min.js` 到 `js/vendor/`，两个页面引入
2. 新建 `js/animations.js` 骨架（含 reducedMotion 判断与降级）
3. 首页：Hero 标题 → 统计数字 → 卡片 stagger → 滚动淡入
4. 文章页：内容入场 → 目录高亮 → 聊天窗口开关
5. 全局：主题切换过渡、卡片 hover 微交互
6. 清理被替代的旧动画代码，回归测试两个页面
7. 更新项目文档与更新日志

### 6. 优先级建议

| 优先级 | 动画 | 收益 | 工作量 |
|--------|------|------|--------|
| P0 | 卡片 stagger 入场 | 首页第一印象 | 小 |
| P0 | 统计数字动画 | 直观 | 小 |
| P1 | 主题切换过渡 | 亮点功能 | 中 |
| P1 | 聊天窗口开关弹性动画 | 交互反馈 | 小 |
| P2 | Hero 标题逐字动画 | 视觉冲击 | 小 |
| P2 | 滚动淡入 + 卡片 hover | 细节打磨 | 中 |
| P3 | 文章内容/目录过渡 | 阅读体验 | 中 |

---

# 首页改造建议方案

> 目标：在保持现有暗黑科技风格的前提下，提升首页的信息密度、可读性与交互体验。

### 1. 现状分析（index.html）

首页当前结构：

| 区块 | 现状 |
|------|------|
| Hero 区 | 粒子 Canvas、光球、脉冲环、浮动线、逐字标题、统计数字、滚动指示 |
| 导航栏 | 品牌链接、动态标签链接（按文章数取前 4 个）、搜索 |
| 标签区 | 由 `renderTags` 动态生成（排除导航栏主标签，显示数量徽标） |
| 文章瀑布流 | 卡片含封面/渐变、头像+作者、标签、标题、摘要、日期、阅读时长 |
| 每日新闻视图 | 资讯列表（出品方徽标 + 标题 + 出品方 · 日期，出品方筛选，无卡片图片） |
| 加载更多 | 无分页，文章与资讯一次性全部加载 |
| 页脚 | 版权 + GitHub/RSS/About 链接 |

### 2. 建议清单

#### 2.1 导航与标签（信息架构）

1. **导航标签动态化**：`nav-links` 中的 全部/技术/生活/AI 为硬编码，建议改为由文章数据动态生成，与 `renderTags` 保持一致，避免"标签区与导航不一致"。
2. **标签数量徽标**：每个标签按钮旁显示文章数（如 `技术 3`），提升信息密度。
3. **多选组合筛选**：当前只能单选标签，可支持点击多个标签做 AND 组合筛选，并高亮已选状态。
4. **移动端菜单**：小屏隐藏导航链接后，目前无替代入口，建议增加汉堡菜单抽屉。

#### 2.2 Hero 区

5. **文案配置化**：标题（HELLO）、副标题、Blog 标识目前硬编码，建议统一放入一个 `config`（或 manifest），便于维护。
6. **滚动联动**：向下滚动时 Hero 标题缩小、渐变淡化（`transform + opacity`，配合现有 Anime.js 平滑过渡），增强滚动层次感。
7. **鼠标视差**：现有粒子跟随鼠标，可扩展为标题/光球轻微视差移动（纵深效果）。
8. **入口按钮**：Hero 底部增加"开始阅读/最新文章"按钮，配合现有 Scroll 指示，强化行动引导。

#### 2.3 文章瀑布流（核心）

9. **骨架屏占位**：加载文章时为卡片区域显示骨架屏（灰色 shimmer），替代现有转圈 Loading，减少首屏跳动。
10. **卡片信息增强**：
    - 增加"预计阅读时长"（按字数估算，如 `≈ 8 分钟`）
    - 增加"更新于"标记（已有 `update` 字段，可在卡片展示 🔄 更新时间）
    - 新文章（发布 3 天内）显示 `NEW` 徽标
11. **封面懒加载**：卡片 `<img>` 增加 `loading="lazy"`，与现有懒加载结合，提升首屏性能。
12. **瀑布流列数自适应**：当前按断点固定列数，建议用 CSS 容器查询让列数随卡片宽度自动排布。

#### 2.4 分页与阅读

13. **加载更多 / 无限滚动**：将页码翻页改为"加载更多"按钮或滚动加载（保留分页兜底），减少跳转割裂感。
14. **回到顶部**：滚动超过一定距离后显示"回到顶部"按钮（悬浮于右下角，与 AI/主题按钮同侧）。
15. **阅读进度条**：页面顶部细进度条，实时显示滚动阅读进度（文章页更实用，首页可选）。

#### 2.5 搜索升级

16. **全文搜索**：当前仅按标题/摘要/标签匹配，可预构建标题+摘要索引，或对已加载文章做简单全文检索，并高亮命中关键词。
17. **搜索建议**：输入时下拉建议前 5 条匹配文章（当前搜索为即时筛选，可补充建议面板）。

#### 2.6 页脚与细节

18. **补齐链接**：GitHub / RSS / About 为占位 `#`，建议补真实地址或生成 RSS 文件（`feed.xml`）。
19. **站点信息**：增加备案号/版权年份自动更新（当前 `© 渡鸦_NULL BLOG 1.3` 为静态）。
20. **空状态**：筛选无结果时已有提示，建议补充"清除筛选"按钮一键还原。

### 3. 实施优先级

| 优先级 | 建议 | 收益 | 工作量 |
|--------|------|------|--------|
| P0 | 封面懒加载 + 骨架屏 | 首屏体验 | 中 |
| P0 | 阅读时长 + NEW 徽标 | 卡片信息密度 | 小 |
| P1 | 导航标签动态化 + 数量徽标 | 一致性 | 小 |
| P1 | 回到顶部 / 阅读进度条 | 导航体验 | 小 |
| P1 | 加载更多 / 无限滚动 | 浏览连贯性 | 中 |
| P2 | Hero 滚动联动 + 视差 | 视觉层次 | 中 |
| P2 | 全文搜索 + 建议 | 检索效率 | 中 |
| P2 | 页脚链接 / RSS / 备案 | 完整性 | 小 |
| P3 | 多选组合筛选、移动端菜单 | 功能扩展 | 中 |

---

# 标签区扩展方案（解决标签增多放不下）

> 目标：标签数量增长后，标签区依然整洁、可检索、不撑爆布局。

### 1. 现状与问题

- 导航栏：动态展示前 4 个主标签（带计数）
- 标签区：`renderTags` 把其余标签全部渲染为胶囊按钮，`flex-wrap` 换行
- **问题**：标签越多，标签区越被撑高、换行混乱，挤压文章区；也缺少检索手段

### 2. 解决方案（分层实施）

#### 方案 A：折叠 + 展开（推荐，先做）

- 默认只显示前 N 个标签（如 12 个）
- 末尾显示"＋ 展开全部"按钮，点击展开所有标签并变为"收起"
- 记忆展开状态（sessionStorage）

```javascript
// renderTags 中控制显示数量
const MAX_VISIBLE = 12;
const all = [...];              // 全部标签按钮
const showMore = all.length > MAX_VISIBLE;
const visible = showMore ? all.slice(0, MAX_VISIBLE) : all;
// visible + (showMore ? '＋ 展开全部' : '')
```

#### 方案 B：标签搜索过滤

- 标签区顶部加一个迷你输入框，输入即时过滤匹配标签
- 与方案 A 结合：搜索时自动展开全部再过滤

#### 方案 C：按热度排序 + 权重大小

- 按文章数从多到少排序（当前无序），热门标签排前面
- 词云效果：文章数越多字号越大、颜色越亮（纯 CSS 类控制即可）
- 限制最大显示数（如 40 个），其余归入"更多"

#### 方案 D：独立标签页

- 导航新增"标签"入口，跳转到一个独立页面（或本页打开抽屉）
- 以网格/列表展示全部标签 + 文章数，点击筛选
- 主页标签区只保留热门 Top N，彻底解决空间问题

#### 方案 E：下拉选择器

- 把次要标签收敛到"全部标签 ▾"下拉菜单（类 select 面板）
- 主页只显示 Top N 胶囊，其余进下拉

### 3. 建议组合

| 方案 | 是否采用 | 理由 |
|------|---------|------|
| A 折叠展开 | ✅ 必做 | 立竿见影，成本低 |
| C 热度排序 + 词云 | ✅ 推荐 | 突出高频标签 |
| B 标签搜索 | ✅ 推荐 | 标签多时检索刚需 |
| D 独立标签页 | ⏳ 可选 | 标签极多时再上 |
| E 下拉收敛 | ❌ 暂缓 | 与 A 重复 |

### 4. 预计效果

- 标签再多，标签区始终紧凑（默认 12 个胶囊 + 展开按钮）
- 热门标签一眼可见，冷门标签可搜可展开
- 移动端同样适用（自动换行 + 折叠）

---

# Hero 区重新设计方案（解决首页视觉）

> 目标：让首屏更简洁、有设计感；删除中央大标题，统计信息拆分到其他位置，字数统计直接删除。

### 1. 现状问题

- 装饰元素过多：光球×3、脉冲环×3、浮动线×3、粒子爆发×6、角标×4、装饰线、网格闪光、粒子 Canvas 同时叠加
- 视觉重心被"中央大标题 + 三列统计（文章数/标签数/字数）"占据，内容拥挤、层次乱，观感"满而杂"
- 缺少行动引导（只有一个小 Scroll 指示）

### 2. 本次调整决策

- ✅ **删除中央大标题**（hero-title / HELLO 大字）
- ✅ **删除字数统计**（Words）
- ✅ **文章数、标签数移出 Hero**，拆分到其他位置
- 保留：品牌标签、副标题、CTA 按钮、滚动指示、背景动效

### 3. 设计方向（三选一）

| 方案 | 描述 | 适合 |
|------|------|------|
| A 极简留白 | 大面积渐变背景 + 细腻粒子 + 居中品牌与副标题，大量留白 | 品牌感、克制 |
| B 沉浸式背景 | 全屏动态渐变/大图，品牌信息浮于其上，毛玻璃文字 | 视觉冲击 |
| C 左文右图 | 左侧品牌信息 + CTA，右侧装饰视觉（光效/图形） | 信息型首页 |

**推荐组合：B/A 融合** —— 全屏柔和动态渐变 + 适度粒子，去掉大标题后内容只剩品牌与引导，更显干净。

### 4. 具体改造清单

#### 4.1 删减装饰（做减法）

- 保留：粒子 Canvas、背景渐变、1 个脉冲环（或删除）
- 删除或大幅弱化：光球×3、浮动线×3、粒子爆发×6、角标×4、装饰线、网格闪光
- 目标：首屏收敛到「背景动效 + 少量内容」两层

#### 4.2 背景升级

- 大面积径向渐变（主题色系），缓慢流动（Anime.js 驱动 CSS 变量）
- 可选叠加轻微网格/噪点（`opacity 0.02~0.05`），增加质感
- 移动端降级为静态渐变（省性能）

#### 4.3 内容层级（无大标题版）

- **最终采用**：删除 Hero 区全部内容（品牌标签、副标题、装饰线、CTA），Hero 仅保留背景渐变 + 粒子 + 滚动指示，作为干净的"开场画布"
- 品牌信息（渡鸦_NULL BLOG）展示于导航栏品牌处

#### 4.4 统计信息拆分（移出 Hero）

- **标签数**：放入导航栏"全部标签"面板（tags-dropdown），在面板标题旁显示，如 `全部标签（N 个）`
- **文章数**：放入页脚（Footer），如 `© 渡鸦_NULL BLOG · 文章 N 篇`
- **字数统计**：直接删除，不再展示
- 内容区顶部不再新增统计栏

#### 4.5 动效（Anime.js 已就绪）

- 背景渐变缓慢流动（`duration: 8000, loop: true`）
- 鼠标跟随视差：品牌标签/装饰层随鼠标微移（`translateX/Y` 基于鼠标位置）
- 滚动联动：Hero 内容随滚动淡出上移（`onScroll` 或 Anime.js 绑定 scrollY）
- 移除标题逐字与统计计数动画（大标题已删、统计已移）

#### 4.6 响应式

- 移动端：隐藏光球/脉冲环/浮动线/角标（`display:none`），仅留粒子 + 渐变
- 副标题 `clamp()` 自适应（已有），CTA 全宽更易点击

### 5. 建议实施步骤

1. 删除 Hero 大标题与统计区（HTML/CSS/JS）
2. 做"减法"：删减冗余装饰元素
3. 标签数显示到"全部标签"面板标题（`全部标签（N 个）`），文章数显示到页脚（`文章 N 篇`）
4. 升级背景为动态渐变 + 新增 CTA 主按钮
5. 加鼠标视差与滚动联动
6. 移动端降级适配，回归测试

### 6. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | 删除大标题与统计区（拆分/删除） | 首屏立即清爽 |
| P0 | 标签数入标签面板、文章数入页脚 | 信息不丢失 |
| P0 | 删除冗余装饰 | 观感提升 |
| P1 | 背景动态渐变 + CTA 按钮 | 质感与引导 |
| P1 | 鼠标视差 / 滚动联动 | 沉浸感 |
| P2 | 移动端降级适配 | 性能与观感 |

---

# 参考 animejs.com 的动效改造建议

> 参考 [animejs.com](https://animejs.com) 首页展示的动画手法，结合本站现状（Hero 已精简、卡片瀑布流、标签面板、AI 聊天、主题切换），提出可落地的动效改造。

### 1. 借鉴点与对应方案

| animejs.com 特性 | 本站现状 | 改造建议 |
|------------------|----------|----------|
| **Scroll Observer**（滚动同步触发） | 卡片入场用 IntersectionObserver | 升级为 Scroll Observer：文章区标题/加载更多按钮滚动进入时同步触发；阅读进度条改为滚动同步（`onScroll({ sync: true })`） |
| **时间轴 Timeline**（顺序编排） | Hero 入场用多个 CSS animation | 用 `createTimeline()` 编排 Hero 入场：品牌标签 → 副标题 → CTA → 背景渐变，统一节奏 |
| **关键帧 + 逐行文本揭示** | 已删除大标题 | 品牌标签做"描边绘制/滑动裁切"揭示（`clip-path` 关键帧），增强首屏仪式感 |
| **SVG 描边绘制（createDrawable）** | 无 SVG 装饰 | Hero 副标题下方加一条 SVG 装饰线，加载时自动"画出来"；或品牌标签下沿加渐变描边 |
| **运动路径（createMotionPath）** | 粒子 Canvas | 加 1-2 个光点沿隐藏 SVG 路径缓慢运动，作为 Hero 背景点缀（替代被删除的光球） |
| **网格错峰（stagger grid from:center）** | 瀑布流线性入场 | 标签面板打开时，标签胶囊从中心向两侧错峰弹出；卡片可尝试 `grid` 错峰（瀑布流受限则保留线性） |
| **弹簧物理（spring）** | CTA/主题按钮 hover 用 CSS | CTA、主题切换按钮 hover 改用弹簧弹性（`spring({ bounce: .6 })`），手感更"弹" |
| **Draggable API（释放回弹）** | AI 聊天窗口为手写拖拽 | 用 `createDraggable` 实现聊天窗口拖拽 + 释放回弹（`releaseEase: spring`），并保留大小调整逻辑 |
| **随机/函数值（random）** | 粒子固定参数 | 卡片封面渐变色、装饰元素位置可用 `random()` 生成，每次刷新略有差异 |
| **媒体查询（Scope）** | 响应式靠 CSS | 用 `createScope({ mediaQueries })` 控制移动端动画开关（如移动端跳过背景光点） |

### 2. 重点方案详情

#### 2.1 Hero 入场时间轴（替换 CSS 动画）

```javascript
import { createTimeline, spring } from 'animejs';

createTimeline({ defaults: { ease: 'out(3)' } })
    .add('.hero-tag', { opacity: [0, 1], translateY: [14, 0], duration: 500 })
    .add('.hero-subtitle', { opacity: [0, 1], translateY: [10, 0], duration: 500 }, '-=300')
    .add('.hero-cta', { opacity: [0, 1], scale: [0.9, 1], duration: 400 }, '-=250')
    .add('.scroll-indicator', { opacity: [0, 1], duration: 600 }, '-=150');
```

#### 2.2 Hero 装饰光点沿路径运动

```javascript
import { createMotionPath } from 'animejs';

const path = createMotionPath('#heroPath');
animate('.hero-dot', {
    x: path.x, y: path.y,
    duration: 12000,
    loop: true,
    ease: 'linear'
});
```

#### 2.3 标签面板打开时错峰弹出

```javascript
import { stagger } from 'animejs';

// tagsDropdown 显示后执行
animate('.tags-dropdown-list .tag-btn', {
    opacity: [0, 1],
    scale: [0.8, 1],
    delay: stagger(25, { from: 'center' }),
    duration: 250
});
```

#### 2.4 CTA / 主题按钮弹簧 hover

```javascript
import { spring } from 'animejs';

cta.addEventListener('mouseenter', () => {
    animate(cta, { scale: [1, 1.05], duration: 400, ease: spring({ bounce: .6 }) });
});
cta.addEventListener('mouseleave', () => {
    animate(cta, { scale: [1.05, 1], duration: 400, ease: spring({ bounce: .6 }) });
});
```

### 3. 注意事项

- 本站已加载完整 UMD（含 Scroll/Draggable/SVG 模块），无额外包体积
- 已实施的内容不重复叠加：卡片入场、主题切换过渡保留现状，避免动画过多造成"满而杂"
- 全部动画尊重 `prefers-reduced-motion`（沿用 `BlogAnimations.ready` 判断）
- 移动端：关闭背景光点/装饰线，仅保留时间轴入场与滚动同步

### 4. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | Hero 入场时间轴（统一节奏） | 首屏质感 |
| P0 | 标签面板错峰弹出 | 交互反馈 |
| P1 | 滚动同步（Scroll Observer） | 滚动叙事感 |
| P1 | CTA/主题按钮弹簧 hover | 手感提升 |
| P2 | SVG 装饰线绘制 / 光点路径 | Hero 氛围 |
| P2 | 聊天窗口 Draggable 回弹 | 交互细节 |
| P3 | 随机函数值 / 媒体查询分支 | 打磨 |

---

# Hero 区设计方案（重新设计）

> 目标：在"极简空白画布"基础上，为 Hero 注入品牌感、信息与行动引导，同时保持克制与科技氛围。

### 1. 现状

Hero 目前只剩：背景渐变 + 粒子 Canvas + 强调线 + 滚动指示，内容区为空（此前删除了品牌标签/副标题/CTA）。

### 2. 设计目标

- 一眼看懂"这是谁的博客 / 写什么"
- 有清晰的行动引导（进入文章区）
- 动效克制、不"满而杂"
- 契合"渡鸦_NULL / 暗黑科技"品牌调性

### 3. 候选方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A 极简居中 | 小品牌胶囊 + 一句 Slogan + 副标题 + CTA | 高级、克制、通用 | 信息较少 |
| B 居中大标题 | Slogan 大字（渐变+逐字）+ 副标题 + CTA | 冲击力强 | 曾因"大字"被删，需换文案/呈现 |
| C 左文右图 | 左侧品牌+文案+CTA，右侧装饰（伪终端窗/代码块/封面卡） | 信息型、有内容 | 实现量较大 |
| D 终端风 | 伪终端窗口播放"启动日志"，光标闪烁 | 契合极客品牌、有辨识度 | 风格局限、复用度低 |
| E 滚动叙事 | 首屏大字，滚动时缩放/拆分进入内容区 | 沉浸、新颖 | 实现复杂、移动端需降级 |

### 4. 推荐方案：A 极简居中 + 微动效（或 C 左文右图）

**首选 A（推荐）**：信息少而精，最稳妥，动效集中在入场。

具体元素（自上而下）：
1. **品牌胶囊**：`渡鸦_NULL BLOG`（小圆角胶囊，描边）
2. **Slogan 主标题**：如 `HELLO, WORLD.` 或 `渡鸦_NULL`，渐变文字 + 逐字错峰入场（非打字机闪烁，改用 Anime.js stagger）
3. **副标题**：保留原句 `只要你不失去你的崇高，整个世界都将向你敞开`（可换/精简）
4. **CTA 主按钮**："开始阅读"（平滑滚动到文章区）
5. **滚动指示**：保留现有 Scroll

**备选 C**：若希望 Hero 更有"内容"，采用左文右图——左侧品牌+文案+CTA，右侧放一个轻量"文章卡片预览"或"伪终端"装饰（纯 CSS/SVG，无真实逻辑）。

### 5. 动效细节（Anime.js 已就绪）

- **入场时间轴**（createTimeline）：品牌胶囊 → 主标题逐字 stagger → 副标题 → CTA → 滚动指示，统一节奏
- **背景**：径向渐变缓慢流动（`duration: 8000, loop: true`）+ 现有粒子
- **CTA hover**：弹簧弹性（`spring`）
- **鼠标视差（可选）**：主标题/装饰层随鼠标微移
- **滚动联动（可选）**：Hero 内容随滚动淡出上移
- 全部尊重 `prefers-reduced-motion`，移动端跳过装饰

### 6. 文案建议（可讨论）

| 位置 | 建议文案 |
|------|----------|
| 品牌胶囊 | `渡鸦_NULL BLOG` |
| Slogan | `HELLO, WORLD.` / `在代码与文字之间` / `渡鸦的低语` |
| 副标题 | 现有：`只要你不失去你的崇高，整个世界都将向你敞开` |
| CTA | `开始阅读` / `查看文章` |

### 7. 响应式与可访问性

- 移动端：主标题 `clamp()` 自适应，CTA 全宽更易点击
- 尊重系统"减少动效"
- 文案使用语义化标签（h1/p/button），利于 SEO 与读屏

### 8. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | 品牌胶囊 + Slogan + 副标题 + CTA（方案 A 内容层） | 首屏立即有信息 |
| P0 | 入场时间轴（Anime.js） | 质感 |
| P1 | 背景渐变流动 + CTA 弹簧 hover | 氛围 |
| P1 | 移动端适配 | 可用性 |
| P2 | 鼠标视差 / 滚动联动 | 沉浸感 |
| P2 | 左文右图装饰（备选 C） | 内容感 |

---

# Hero 与内容区"左右切换"方案

> 目标：将"滚动进入内容"改为 Hero 与内容区之间**左右滑动切换**，切换带流畅动画，形成"两页全屏"的沉浸体验。

### 1. 交互概念

把首页做成**横向两页 Pager**：

- **页 1（左）**：Hero（首屏品牌区）
- **页 2（右）**：内容区（文章瀑布流，内部纵向滚动）

通过左右滑动在两页间切换，而非垂直滚动。

### 2. 页面结构调整

```html
<div class="pages" id="pages">                    <!-- 横向容器，Anime.js 驱动 translateX -->
    <section class="page page-hero" id="hero">      <!-- 页 1：现 Hero -->
        ...
    </section>
    <div class="page page-content" id="contentPage"> <!-- 页 2：现 contentWrapper -->
        <nav class="nav-bar">...</nav>
        <main class="main-content">...</main>
        <footer class="footer">...</footer>
    </div>
</div>
```

- `.pages`：`width: 200vw; display: flex;`，两页各 `width: 100vw; height: 100vh`
- `body { overflow: hidden; }`，内容页内部 `overflow-y: auto`
- 现有 `#contentWrapper` 改为内容页内部容器

### 3. 切换交互（四选多）

| 触发 | 说明 |
|------|------|
| **左右箭头按钮** | 页面两侧悬浮箭头（如 Hero 右侧 `→` 进入内容；内容左侧 `←` 返回） |
| **键盘 ← →** | 方向键左右切换（可复用现有 WASD 逻辑，新增 `←/→`） |
| **触屏滑动** | `touchstart/touchmove/touchend` 或 Pointer Events 监听横向滑动阈值 |
| **CTA / 返回** | Hero 的"开始阅读"→ 切到内容；内容顶部"返回首页"→ 切回 Hero |

### 4. 切换动画（Anime.js）

```javascript
import { animate } from 'animejs';

function goTo(pageIndex) {                       // 0 = Hero, 1 = 内容
    animate('#pages', {
        translateX: [currentX, -pageIndex * window.innerWidth],
        duration: 550,
        ease: 'out(3)'                            // 或 spring({ bounce: .35 }) 轻微回弹
    });
    currentX = -pageIndex * window.innerWidth;
}
```

**动效细节：**
- 主动画：容器 `translateX` 平滑滑动
- 辅助动效：进入的面板 `opacity [0→1]` + 轻微 `scale [0.98→1]`，离场面板反向淡出
- 切换时内容页内的卡片**不重播**入场（沿用 `data-anime-entered` 机制）
- 尊重 `prefers-reduced-motion`（直接瞬间切换）

### 5. 既有功能适配（关键）

改为分页后，以下依赖"页面滚动"的逻辑需要适配：

| 功能 | 适配方式 |
|------|----------|
| 阅读进度条 | 改为监听内容页内部 `scrollTop` |
| 回到顶部按钮 | 在内容页内滚动生效；回到 Hero 页时隐藏 |
| 卡片入场 IntersectionObserver | 以内容页为滚动容器（`root` 设为内容页） |
| 页脚遮挡（footer-visible） | 基于内容页内部滚动位置计算 |
| 导航栏吸顶 | 在内容页内 `position: sticky` |
| URL / 锚点 | 页面切换可用 hash 或 history 记录当前页（`#content`） |

### 6. 响应式与移动端

- 移动端隐藏箭头按钮，依赖触屏左右滑动
- 两页均为 `100vh`（移动端注意地址栏高度，可用 `100dvh`）
- 内容页内部正常纵向滚动

### 7. 风险与替代方案

- **优点**：沉浸感强、交互新颖、动效展示充分
- **风险**：与"传统博客纵向滚动"习惯不同；对既有滚动逻辑改动面大，需回归测试
- **替代**：
  - 方案 B（保守）：保留纵向滚动，仅在滚动到内容区时叠加一个"滑动进入"过渡动画（容器 translateY 动画）
  - 方案 C：仅将 Hero 内的 CTA 点击改为"整页左右滑入内容"，其余保持滚动

### 8. 实施步骤

1. 重构 HTML：`.pages` + 两页结构
2. `body` 禁止滚动，内容页内部滚动，适配 4 类既有功能
3. 实现 `goTo(index)` 与切换触发（箭头/键盘/触摸/CTA）
4. Anime.js 切换动画 + 辅助过渡
5. 移动端滑动 + `100dvh` 适配
6. 回归测试（卡片入场、搜索/标签、回到顶部、进度条、页脚遮挡）

### 9. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | `.pages` 两页结构与基础切换 | 核心功能 |
| P0 | Anime.js 切换动画 | 视觉 |
| P1 | 箭头/键盘/CTA 触发 | 易用性 |
| P1 | 既有功能适配（进度条/回顶/卡片/页脚） | 不破坏现状 |
| P2 | 触屏滑动 + 100dvh | 移动端 |
| P2 | URL 状态记录 | 可分享 |

---

# 省去 Hero 区方案（内容直达型）

> 目标：直接移除全屏 Hero，首页打开即是导航 + 内容，走"内容优先、极简直达"路线。

### 1. 方案概述

不再有全屏首屏，页面打开即从**顶部导航栏 + 文章内容**开始，首屏直接可见文章卡片。

```html
<body>
  <nav class="nav-bar">...</nav>        <!-- 吸顶导航 -->
  <main class="main-content">            <!-- 顶部就是内容 -->
    <div id="posts">...</div>
    <div id="pagination">...</div>
  </main>
  <footer class="footer">...</footer>
</body>
```

### 2. 需要移除的内容

- HTML：`<section class="hero">` 整块（背景渐变、粒子 Canvas、内容、强调线、滚动指示）
- JS：`HeroParticles`、Hero 入场时间轴、CTA 交互
- CSS：hero 相关全部样式与动画
- 阅读进度条/回到顶部/主题切换等保留（它们与 Hero 无关）

### 3. 替代"首屏品牌信息"的几种方式

| 方式 | 说明 | 适合 |
|------|------|------|
| A 仅导航品牌 | 品牌"渡鸦_NULL"已在导航栏，无额外展示 | 最极简 |
| B 紧凑横幅 | 顶部保留一个 **非全屏横幅**（约 200-300px）：品牌 + 一句 Slogan + 可选 CTA，下接内容 | 兼顾品牌与效率 |
| C 内容区标题 | 文章区上方加一个居中标题区（"最新文章"/"渡鸦_NULL BLOG"），配合横幅/纯文字 | 有仪式感 |

**推荐 B（紧凑横幅）**：保留品牌感但不再占用整屏，用户立刻能看到文章。

### 4. 推荐布局（B 方案示意）

```
┌─────────────────────────────┐
│  导航栏（吸顶）                 │
├─────────────────────────────┤
│  顶部横幅（约 240px，非全屏）    │
│    渡鸦_NULL BLOG             │
│    只要你不失去你的崇高...      │
│    [开始阅读 ↓]              │
├─────────────────────────────┤
│  文章瀑布流（首屏即见卡片）      │
│  ...                        │
├─────────────────────────────┤
│  页脚                         │
└─────────────────────────────┘
```

- 横幅背景可复用现有渐变 + 粒子（缩小高度）
- 首屏即展示 1-2 行卡片，信息直达

### 5. 优点

- **内容优先**：打开即看文章，减少"跳过首屏"的额外操作
- **加载更快**：无全屏 canvas 粒子，性能更好
- **移动端友好**：不浪费小屏空间
- **结构简单**：移除 Hero 后逻辑更少、维护更易
- 不再需要纠结 Hero 与内容的"左右切换"，天然融合

### 6. 注意事项

- 品牌辨识度依赖导航栏/横幅，若选 A（仅导航）需确保品牌足够醒目
- 粒子动效若保留在横幅，需控制性能（缩小画布/降级）
- 移除 Hero 后，卡片入场、回到顶部、进度条等逻辑不受影响（它们基于内容滚动）
- `prefers-reduced-motion` 仍应尊重

### 7. 与"左右切换方案"对比

| 维度 | 省去 Hero（本方案） | 左右切换（方案十三） |
|------|---------------------|----------------------|
| 首屏 | 直接内容 | Hero 全屏 |
| 体验 | 效率、直达 | 沉浸、仪式感 |
| 复杂度 | 低（删除即可） | 高（结构重构 + 适配） |
| 风险 | 低 | 中高 |

### 8. 实施步骤

1. 移除 `hero` 区块（HTML/CSS/JS）
2. 新增顶部紧凑横幅（B 方案）或直接进入内容（A 方案）
3. 横幅动效（渐变流动 + 品牌淡入，Anime.js）
4. 回归测试（卡片、搜索、回到顶部、进度条、页脚遮挡）

### 9. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | 移除 Hero 区块 | 简化 |
| P0 | 紧凑横幅（B）或纯内容（A） | 首屏直达 |
| P1 | 横幅品牌淡入 / 渐变流动 | 品牌感 |
| P1 | 回归测试既有功能 | 稳定 |

---

# "我的"个人仪表盘设计方案

> 目标：将当前 4 张统计卡片升级为"博主专属"的个人仪表盘，一屏展示身份、数据与动态，契合暗黑科技风格。

### 1. 现状

- 仪表盘仅 4 张统计卡片：文章 / 标签 / 预计阅读分钟 / 图库图片

### 2. 设计目标

- **个性化**：一眼看到"这是渡鸦NULL 的主页"（头像、签名、关于）
- **信息即达**：统计 + 最近文章 + 热门标签 + 快捷入口，一屏内完成
- **动效克制**：沿用 Anime.js，不喧宾夺主

### 3. 模块规划

| 模块 | 内容 | 数据来源 |
|------|------|----------|
| A 欢迎区 | 头像（01_TX）、名字"渡鸦NULL"、签名一句 | 静态 |
| B 统计概览 | 文章数、标签数、预计阅读时长、图库图片数 | BlogApp.posts / manifest |
| C 最近文章 | 最新 5 篇：标题 + 日期 + 标签（点击进文章） | BlogApp.posts |
| D 热门标签 | Top 8 标签，权重大小展示 | BlogApp.posts |
| E 快捷入口 | GitHub / RSS / 写文章（操作文档） | 静态链接 |
| F 关于 | 站点版本、技术栈、最后更新 | 静态 |

### 4. 布局示意

```
┌──────────────────────────────────────┐
│ 欢迎区：头像 | 渡鸦NULL | 签名       │
├──────────┬──────────┬───────────────┤
│ 文章数    │ 标签数   │ 预计阅读时长   │
├──────────┴──────────┴───────────────┤
│ 图库图片  │ 快捷入口（GitHub/RSS/写）│
├───────────────────┬─────────────────┤
│ 最近文章（标题+日期）│ 热门标签（云）  │
├───────────────────┴─────────────────┤
│ 关于：版本 · 技术栈 · 最后更新        │
└──────────────────────────────────────┘
```

### 5. 视觉与动效（Anime.js）

- **欢迎区**：头像渐变边框呼吸、名字逐字或淡入、签名打字
- **统计数字**：Anime.js counter 滚动递增（复用 animateStats 思路）
- **卡片 stagger**：各模块入场错峰
- **热门标签**：hover 放大、点击可跳转到博客视图并按该标签筛选
- 尊重 `prefers-reduced-motion`

### 6. 交互

- 最近文章点击 → 打开对应文章页
- 热门标签点击 → 切回"博客"视图并筛选该标签（联动 `switchView('blog')` + `filterByTag`）
- 快捷入口：GitHub / RSS / 写文章（指向操作文档）

### 7. 实施步骤

1. HTML：重构 `#view-dashboard` 为多模块结构（欢迎区/统计/最近/标签/快捷/关于）
2. CSS：新增仪表盘整体布局与模块样式
3. JS：`renderDashboard` 渲染统计、最近文章、热门标签；标签点击联动筛选
4. 动效：欢迎区 + 数字滚动 + 卡片 stagger
5. 回归测试（视图切换、标签联动、灯箱不受影响）

### 8. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | 欢迎区 + 统计概览 | 个性化第一印象 |
| P0 | 最近文章 + 热门标签 | 内容与导航价值 |
| P1 | 快捷入口 + 关于 | 完整性 |
| P1 | 数字滚动 + stagger 动效 | 质感 |
| P2 | 标签联动筛选 | 效率 |

---

# 文章页阅读体验改善方案

> 目标：让文章页更像一个"舒适的阅读器"，而非普通网页——从排版、导航、专注、移动端四方面提升。

### 1. 现状

文章页已有：左侧目录（搜索/折叠/高亮）、返回按钮、代码高亮与复制、图片灯箱、上一篇/下一篇、移动端悬浮球、AI 划词问答。缺少阅读进度、字号调节、专注模式等"阅读器"级能力。

### 2. 排版与测量（阅读舒适度基础）

| 事项 | 建议 |
|------|------|
| 阅读宽度 | 正文限制约 720-760px（`measure` 优化，避免超长行） |
| 字号 | 正文 16-17px，行高 1.8-2.0 |
| 段落间距 | `p` 间距 1em，首行缩进可选 |
| 标题层级 | h1 大、h2/h3 层次清晰，标题留白 |
| 长文 | 正文可加"阅读进度百分比"提示 |

### 3. 阅读辅助工具（工具栏）

在正文顶部加一条**阅读工具栏**（不干扰内容）：

- **字号调节**：A− / A+（保存到 localStorage）
- **行距调节**：紧凑 / 舒适 / 宽松
- **阅读模式**：护眼（sepia 暖色调）/ 专注（隐藏侧栏放大排版）/ 夜间
- **阅读进度条**：顶部细进度条（复用首页实现，监听正文滚动）
- **字体**：可选衬线/无衬线切换（中文阅读衬线更舒适）

### 4. 目录与导航增强

- 目录项折叠状态**记忆**（localStorage），下次打开保持
- 目录"当前章节"高亮更醒目（加左侧强调条）
- 移动端目录抽屉：背景遮罩 + 平滑滑入
- 上一篇/下一篇：改为**底部卡片式**（标题预览），或页面底部"返回文章列表"
- 悬浮球增加：回到顶部、滚动到底部

### 5. 专注阅读模式（沉浸）

- 点击正文或工具栏"专注"按钮 → 隐藏目录/悬浮球/装饰，正文居中放大
- 再次点击或 ESC 退出
- 配合 `body.reading-mode` 类切换样式，Anime.js 平滑过渡

### 6. 键盘快捷键

| 按键 | 功能 |
|------|------|
| `J` / `K` | 上一篇 / 下一篇 |
| `T` / `B` | 回到顶部 / 底部 |
| `A` / `S` | 字号增大 / 减小 |
| `/` | 聚焦目录搜索 |

### 7. 内容体验细节

- 代码块：hover 显示语言与复制（已有），可加"行号"开关
- 引用块：左侧强调色块（已有），可加折叠
- 图片：灯箱（已有），可加**图集左右切换**（复用首页灯箱）
- 表格：小屏横向滚动（已有），可加"展开表格"
- 长文自动生成"章节进度"（当前目录已支持）

### 8. 移动端优化

- 正文 padding 加大，字号 16px 以上（防止 iOS 缩放）
- 触控目标 ≥ 40px（目录项、悬浮球按钮）
- 顶部返回/标题条固定，滚动时正文不被遮挡

### 9. 实施步骤

1. 排版：正文测量宽度、字号/行高/间距调整
2. 顶部阅读进度条
3. 阅读工具栏（字号/行距/模式）与 localStorage 持久化
4. 专注阅读模式
5. 目录记忆 + 底部上一篇/下一篇卡片
6. 键盘快捷键
7. 移动端适配与回归测试

### 10. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | 正文排版优化（宽度/字号/行高） | 阅读舒适度基础 |
| P0 | 阅读进度条 | 长文定位 |
| P1 | 字号调节 + 阅读模式（护眼/夜间） | 个性化 |
| P1 | 专注阅读模式 | 沉浸 |
| P2 | 目录记忆 + 底部上一篇/下一篇 | 导航 |
| P2 | 键盘快捷键 | 效率 |
| P3 | 图集切换、代码行号、移动端细节 | 打磨 |

---

# "推荐"页面设计方案

> 目标：在顶部视图栏"图库"与"我的"之间新增一个「推荐」视图，集中展示博主从**其他网页**收集推荐的文章、视频、网页与应用；视频卡点击后**在页面内直接播放**（用视频链接的 embed 形式实现）。形成"看文章 → 看图库 → 看推荐 → 看我的"的完整内容闭环。

### 1. 现状

- 顶部视图栏现有三个视图：文章 / 图库 / 我的（`index.html:35-37`）
- 视图切换由 `BlogApp.switchView(view)` 统一管理（`js/app.js:385`），标签导航仅文章视图显示
- 图库采用"JSON manifest + 静态扫描"模式：图片放文件夹、脚本生成 `manifest.json`、页面据此渲染，推荐页可复用这套模式

### 2. 设计目标

- **内容集中**：把散落在各处的"好东西"汇总成一屏，方便访客与作者快速取用
- **类型分明**：文章 / 视频 / 网页 / 应用 四大类，一眼可辨
- **外部聚合**：四类推荐全部来自**外部网页链接**，不依赖站内文章
- **视频可播**：视频卡点击后在**页面内播放**，用视频链接的 embed 形式实现，不跳走
- **零后端**：沿用纯前端方案，用 JSON 数据文件驱动，改动数据即可更新页面
- **风格统一**：卡片语言与瀑布流、图库一致，动效复用 Anime.js

### 3. 内容分类与字段设计

四类推荐均来自**外部网页**，统一存于 `data/recommendations.json`（示例）：

```json
[
  {
    "id": "r01",
    "type": "article",
    "title": "A Complete Guide to CSS Grid",
    "desc": "讲得最清楚的 CSS Grid 教程，图解详细",
    "url": "https://css-tricks.com/snippets/css/complete-guide-grid/",
    "image": "images/recommend/article-01.webp",
    "tags": ["前端"],
    "rating": 5
  },
  {
    "id": "v01",
    "type": "video",
    "title": "GitHub Actions 入门到实战",
    "desc": "保姆级 CI/CD 教程，适合第一次接触自动化部署",
    "url": "https://www.bilibili.com/video/BVxxxx",
    "embed": "//player.bilibili.com/player.html?bvid=BVxxxx&autoplay=1&danmaku=0",
    "image": "images/recommend/video-01.webp",
    "source": "bilibili",
    "tags": ["开发"],
    "rating": 5
  }
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | ✅ | `article` / `video` / `web` / `app` 四选一 |
| `title` | ✅ | 推荐项标题 |
| `desc` | 推荐 | 一句话推荐理由 / 简介 |
| `url` | ✅ | 点击跳转的外部链接（http/https） |
| `embed` | 视频必填 | 视频**嵌入播放链接**，点击卡片时在页面内 iframe 播放 |
| `image` | 可选 | 封面/图标，无图时用类型默认图标兜底 |
| `source` | 可选 | 视频平台标识（bilibili / youtube 等），用于显示角标 |
| `tags` | 可选 | 标签，用于筛选 |
| `rating` | 可选 | 推荐指数 1-5，用于排序与展示 |

**视频"用链接实现播放"的 embed 获取方式：**

| 平台 | 页面链接（`url`） | embed 嵌入链接（`embed`） |
|------|----------|---------------------------|
| Bilibili | `https://www.bilibili.com/video/BVxxxx` | `//player.bilibili.com/player.html?bvid=BVxxxx&autoplay=1&danmaku=0` |
| YouTube | `https://www.youtube.com/watch?v=ID` | `//www.youtube.com/embed/ID?autoplay=1` |
| 支持 iframe 的其它平台 | 原页面链接 | 该平台官方 embed 链接 |

> 原则：**一切靠链接实现**——每条视频存两个链接：`url`（原页面，供跳转）与 `embed`（可播放的嵌入链接，供页面内播放）。

### 4. 视图结构（HTML 示意）

```html
<!-- 视图按钮：文章 / 图库 / 推荐 / 我的 -->
<button class="view-btn" data-view="recommend" onclick="BlogApp.switchView('recommend')">推荐</button>

<!-- 推荐视图 -->
<section class="view view-recommend" id="view-recommend" style="display:none;">
  <div class="recommend-filter" id="recommendFilter">
    <button class="rec-filter-btn active" data-type="all">全部</button>
    <button class="rec-filter-btn" data-type="article">文章</button>
    <button class="rec-filter-btn" data-type="video">视频</button>
    <button class="rec-filter-btn" data-type="web">网页</button>
    <button class="rec-filter-btn" data-type="app">应用</button>
  </div>
  <div class="recommend-grid" id="recommendGrid"></div>
</section>
```

- `switchView` 的 `valid` 数组增加 `'recommend'`，首次进入调用 `renderRecommend()`
- 切换视图时沿用现有：按钮激活态、滑块指示器、内容淡入动画
- 推荐视图与图库一致**隐藏标签导航栏**

### 5. 布局与卡片设计

**筛选栏**：视图顶部一排类型胶囊（全部/文章/视频/网页/应用），点击筛选，当前项高亮；与标签面板视觉语言一致。

**卡片网格**（CSS Grid，自适应列数，与图库瀑布流呼应）：

```
┌─────────────────────────────┐
│ [图标/封面]        [类型角标] │   ← 类型角标颜色区分
│ 标题                         │
│ 一句话推荐理由（最多 2 行省略） │
│ ★★★★☆   [标签]  [来源图标]  │   ← rating / tags / source
│        [打开 ↗]             │
└─────────────────────────────┘
```

| 类型 | 角标颜色 | 卡片补充 |
|------|----------|----------------|
| 文章 article | 主题强调色 | 外链 ↗（打开原网页文章） |
| 视频 video | 红/蓝（平台色） | 播放 ▶（页面内播放）+ 平台来源图标 |
| 网页 web | 青绿 | 外链 ↗ |
| 应用 app | 紫色 | 外链 ↗ / 平台徽标 |

- 无封面图时按类型显示默认 SVG 图标（`images/recommend/icon-{type}.svg`）
- **视频卡是"播放卡"**：封面叠加播放按钮 ▶ 与平台角标；点击卡片 → 页面内灯箱用 `embed` 链接播放（不跳转）；卡片角部另有"在新窗口打开原链接"小按钮。移动端小屏可直接跳转原页面

### 6. 视觉与动效（Anime.js）

- **卡片入场**：`opacity [0,1] + translateY [24,0] + scale [0.98,1]`，`stagger(50)` 错峰，与瀑布流入场一致
- **筛选切换**：重渲染时卡片快速淡入（沿用 `data-anime-entered` 机制，避免重复"刷新"动画）
- **rating 星标**：hover 微放大；类型角标 hover 轻微上浮
- 全部尊重 `prefers-reduced-motion`；移动端网格自动降为 1-2 列

### 7. 交互设计

- **筛选**：点击类型胶囊即时过滤（本地数据，无需重新 fetch）
- **打开**：文章 / 网页 / 应用卡 `target=_blank + rel="noopener"` 新窗口打开外部链接
- **视频播放（核心）**：点击视频卡 → 打开页面内播放灯箱，把 `embed` 链接注入 iframe 播放（`autoplay=1`）；ESC / 关闭按钮退出并清空 iframe `src` 停止播放；灯箱底部放"去原页面看"链接
- **排序**：默认按 `rating` 降序 → 同分按录入顺序；后续可加"按时间/评分"切换

### 8. 推荐内容的更新维护方案（核心）

> 推荐全部来自外部网页、属人工收集内容，更新关键是：**单文件维护、改动即生效、失效链接可检、缓存自动失效。**

#### 8.1 单来源数据模型（推荐采用）

不需要"源文件 + 构建"两层，直接维护最终文件 `data/recommendations.json`：

```
data/recommendations.json  ← 唯一的维护入口（手动编辑）
        │  页面 fetch（缓存 key 取内容哈希）
        ▼
    #view-recommend 渲染
```

- 新增 / 修改 / 下架都在这一个文件里完成，改完推送即可，**无需构建脚本**
- 需要播放的视频，在对应条目补 `embed` 链接（获取方式见第 3 节）

#### 8.2 校验与健康检查脚本（可选，`scripts/check-recommendations.js`）

```bash
node scripts/check-recommendations.js            # 字段合法性校验
node scripts/check-recommendations.js --check    # 校验 + 外链/embed 健康检查
```

职责：
1. **字段校验**：`type`/`url` 必填；`type` 必须是四类之一；视频必须有 `embed`；`url`/`embed` 必须是 http(s) 或 `//` 开头；非法条目打印警告
2. **去重校验**：`id`/`url` 重复时告警
3. **健康检查**（`--check`）：对 `url` 与 `embed` 发 HEAD 请求，报告 4xx/5xx/超时，便于清理失效推荐

> 脚本只做质量把关、不生成内容，仅在需要时运行。

#### 8.3 日常更新流程（工作流）

**场景一：新增一条外部推荐**
```bash
# 编辑 data/recommendations.json 追加条目（视频记得补 embed）
node scripts/check-recommendations.js      # 可选，先本地校验
git add . && git commit -m "新增推荐" && git push origin main
```

**场景二：修改推荐语 / 星级 / 封面 / embed**
```bash
# 直接改 data/recommendations.json 对应条目
git add . && git commit -m "更新推荐" && git push origin main
```

**场景三：下架（链接失效或不再推荐）**
```bash
# 删除 data/recommendations.json 中对应条目
git add . && git commit -m "下架推荐" && git push origin main
```

**场景四：定期体检失效链接**（建议每月）
```bash
node scripts/check-recommendations.js --check
```

#### 8.4 缓存与版本控制

- 不使用手写版本号：页面把 JSON 内容做哈希作为 sessionStorage 缓存 key（如 `recommend-data-{hash}`），**内容一变哈希即变，缓存自动失效**，天然免维护
- 视频封面若引用外站图片，配合 `loading="lazy"`，加载失败时回退为类型图标
- 兜底：发布后强制刷新（Ctrl+F5）仍可强制更新

#### 8.5 排序策略（供后续优化）

| 策略 | 说明 |
|------|------|
| 评分优先（默认） | 按 `rating` 降序，人工可控 |
| 最新优先 | 条目加 `date` 后按时间倒序 |
| 自动「每周精选」（可选） | 脚本每周随机置顶 1-3 条，仅重排，不改数据 |

> 推荐先落地 8.1/8.3（单文件直接维护 + 推送即生效），`check` 脚本与周精选作为 P2 增强。

### 9. 实施步骤

1. 新建 `data/recommendations.json`，录入首批外部推荐（article/video/web/app 各若干，视频条目补 `embed`）
2. `index.html`：视图按钮加「推荐」、新增 `#view-recommend` 结构、预留筛选栏与网格容器
3. `js/app.js`：`switchView` 的 `valid` 数组加 `recommend`；新增 `loadRecommend`（fetch JSON，内容哈希做缓存 key）与 `renderRecommend(filter)`；筛选按钮事件委托
4. `css/style.css`：推荐页筛选栏、卡片网格、类型角标、rating 星标、视频播放按钮样式（跟随主题变量）
5. `js/app.js`：视频播放灯箱（复用 `galleryLightbox` 结构，注入 `embed` iframe；ESC/关闭时清空 src 停止播放）
6. `js/animations.js`：推荐卡片 stagger 入场 + 筛选重渲染淡入
7. 新建 `scripts/check-recommendations.js`（字段校验 + `--check` 健康检查）
8. 更新《博客完整使用手册》（含推荐页维护流程）、项目文档与更新日志，推送上线

### 10. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | `data/recommendations.json` + 视图按钮 + `#view-recommend` 渲染 | 核心功能 |
| P0 | 视频卡片页面内播放（embed iframe 灯箱） | 核心需求 |
| P0 | 类型筛选 + 外链新窗口打开 | 可用性 |
| P1 | 类型角标 / rating / 无图兜底图标 / 播放按钮 | 信息密度与观感 |
| P1 | 卡片 stagger 入场动效 | 质感 |
| P1 | 内容哈希缓存失效机制 | 更新即时生效 |
| P2 | `check` 脚本（字段校验 + 链接体检） | 维护质量 |
| P2 | 每周精选排序 | 新鲜感 |

---

# 资讯推荐「每日更新」自动化方案

> 结论先行：**能做到每日更新**，但靠人工每天手动编辑 `data/recommendations.json` 不现实（每天要挑选、写摘要、改 JSON、推送）。真正可行的路线是**用 GitHub Actions 定时抓取 RSS 自动生成资讯**，人工只做质量把关。本文给出三个梯度的方案，推荐方案一。
>
> 扩展需求：**资讯点击后进入文章页站内阅读**（类似阅读文章体验，而非跳外链）。该需求可以并进本方案实现——给每条资讯补充 `content` 正文，文章页复用现有阅读渲染能力即可。

### 1. 现状与可行性分析

- 当前资讯由 `data/recommendations.json` 单一文件手动维护，字段为 `id/title/url/source/category/date/summary`（v2.6.43 改版后字段），页面直接 fetch 渲染，无后端；点击资讯卡当前为**外链跳转**（`target="_blank"`），无站内阅读
- **纯人工做不到每日更新**：平均每条资讯要经历「找新闻 → 写标题/摘要 → 编辑 JSON → 校验 → 推送」约 5~10 分钟，每日 8~10 条 ≈ 1 小时起步，且难以坚持
- **每日更新具备自动化基础**：① 站点是 GitHub Pages 静态站，天然适合"定时脚本提交 → Pages 自动部署"；② 主要来源（36氪/量子位/少数派/虎嗅/阮一峰/MDN/GitHub Blog）都有公开 RSS/Atom 源；③ 数据格式简单，脚本生成即可
- **站内阅读同样可行**：① 文章页 `article.html` 已有完整 Markdown 渲染（marked + 目录/进度条/字号等阅读体验），只需支持"从 `recommendations.json` 按 id 加载正文"；② RSS 的 `description` 通常包含正文（部分站点为摘要），抓取时转成 Markdown 存为 `content` 即可，无需访问外站页面；③ 摘要型来源（如 36氪）正文不完整，可降级为「仅摘要 + 原文外链」
- 因此结论：**可行方案 = GitHub Actions 定时抓取 + 脚本生成（含正文）+ 自动提交**，实现"每天早晨自动更新当日资讯"，且资讯可站内阅读

### 2. 方案一（推荐）：GitHub Actions 每日定时自动更新

**整体流程：**

```
GitHub Actions 定时任务（每日 08:00）
        │  1. 检出仓库
        ▼
scripts/update-news.js 运行
        │  2. 并发抓取各来源 RSS
        │  3. 解析 → 映射分类/来源 → 去重
        │  4. description 去 HTML → 转 Markdown 存 content（站内阅读正文）
        │  5. 摘要截断；与已有数据合并、按 date 降序、裁剪到上限（如 12 条）
        ▼
   data/recommendations.json 重写
        │  6. 调用 check-recommendations.js 校验
        ▼
   校验通过 → git commit + push → GitHub Pages 自动部署
```

**资讯数据模型（新增 `content` 字段支持站内阅读）：**

```json
{
  "id": "n01",
  "title": "字节跳动发布新一代视频生成模型",
  "url": "https://www.36kr.com/",
  "source": "36氪",
  "category": "科技",
  "date": "2026-08-05",
  "summary": "新模型在生成时长与镜头一致性上取得突破。",
  "content": "（Markdown 正文，供文章页站内阅读；摘要型来源可省略，点击则跳原文外链）"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一标识，文章页用 `?post=n01&type=news` 定位 |
| `title` / `url` / `source` / `category` / `date` | ✅ | 与现状一致 |
| `summary` | 推荐 | 卡片摘要（已有） |
| `content` | 可选 | **Markdown 正文**。有此字段 → 点击进入文章页站内阅读；无此字段 → 点击跳 `url` 外链 |

**自动化脚本 `scripts/update-news.js` 职责：**

1. **抓取**：并发请求各来源 RSS（Node 内置 `https`，无需额外依赖），超时与失败降级（单个来源失败不影响整体）
2. **解析**：用正则/简易 XML 解析提取 `title / link / pubDate / description`（项目无后端、保持零依赖，手写轻量解析即可）
3. **映射**：每个来源配置一张表，输出 `source`（来源名）与 `category`（科技/开发/前端/AI/产品/互联网…），无匹配时归入「资讯」
4. **正文提取**：`description` 去 HTML 标签（保留段落/列表/链接），转成 Markdown 写入 `content`；正文过短（如纯摘要 < 200 字）时判定为摘要型来源，省略 `content`
5. **摘要**：从 `description` 去除 HTML 标签、截断到 ~60 字，不足则省略 `summary`
6. **去重合并**：按 `url` 去重；把新抓取条目与 `data/recommendations.json` 已有条目合并，按 `date` 降序，裁剪到上限（默认 12 条）
7. **落盘与自检**：重写 JSON（保持字段合法），随后执行 `node scripts/check-recommendations.js` 校验，失败则中止不提交

**来源配置示例（写入脚本常量或独立配置）：**

| source | RSS 地址（示例） | 默认分类 |
|--------|----------------|---------|
| 36氪 | `https://36kr.com/feed` | 科技 |
| 量子位 | `https://www.qbitai.com/feed` | AI |
| 少数派 | `https://sspai.com/feed` | 产品 |
| 虎嗅 | `https://www.huxiu.com/rss/0.xml` | 科技 |
| 阮一峰的网络日志 | `https://www.ruanyifeng.com/blog/atom.xml` | 互联网 |
| MDN | `https://developer.mozilla.org/zh-CN/feed/` | 前端 |
| GitHub Blog | `https://github.blog/feed/` | 开发 |

> RSS 地址可能变化，上线前需逐个确认可用；个别站点无 RSS 或无正确分类时，可将该来源标记为「需要人工补充」并在工作流中剔除。

### 2.1 资讯站内阅读（文章页复用，随本方案一并实施）

> 目标：点击资讯卡后在 `article.html` 内以文章阅读体验展示资讯正文（目录 / 进度条 / 字号调节 / 阅读模式全部复用），而不是跳外链；无正文的资讯仍跳外链。

**文章页支持资讯正文：**

1. `article.html` 的 `loadArticle` 增加分支：URL 参数带 `type=news`（如 `article.html?post=n01&type=news`）时，改为 fetch `data/recommendations.json` 并按 `id` 匹配
2. 找到后构造与普通文章一致的对象：`title=资讯title`、`date=资讯date`、`tags=[category]`、`author=source`、`content=资讯content`，走现有 `renderArticle()` 渲染，阅读体验零改动复用
3. 无 `content` 或未找到条目时：提示"原文无正文"，并提供「前往原文」按钮跳 `url`
4. 目录、进度条、字号、阅读模式等全部自动生效（复用同一套渲染管线）；「上一篇/下一篇」导航在资讯模式下隐藏（资讯不进入 `allPosts`）

**资讯卡点击行为（仪表盘）：**

- 有 `content` → `location.href = 'article.html?post=<id>&type=news'`（站内阅读）
- 无 `content` → 维持外链 `target="_blank"`（原文跳转）
- 卡片可增加「站内阅读」/「原文」双入口图标，供用户选择

**缓存与校验配套：**

- 文章页的 `blog-posts-cache-v2` 不含资讯，不受影响；资讯正文随 `recommendations.json` 内容哈希自动失效（与 8.4 一致）
- `scripts/check-recommendations.js` 校验同步更新：`content` 存在时必须是字符串；`id` 必须唯一（作为站内路由键）

**工作流文件 `.github/workflows/update-news.yml`：**

```yaml
name: Update News Daily
on:
  schedule:
    - cron: "0 0 * * *"     # 每天 08:00（UTC+8），UTC 为 00:00
  workflow_dispatch:       # 支持手动触发
jobs:
  update:
    runs-on: ubuntu-latest
    permissions:
      contents: write      # 允许脚本自动提交
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: node scripts/update-news.js
      - name: Commit & push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/recommendations.json
          git diff --cached --quiet || git commit -m "每日资讯自动更新 $(date +%F)"
          git push
```

**本方案的优点：**

- **零人工**：每日定时生成、自动提交、自动部署，无需手动操作
- **改动即生效**：页面缓存 key 为内容哈希（见 8.4），JSON 一变哈希即变，读者刷新即见新资讯
- **失败不破坏**：抓取失败/校验不过都不会覆盖现有数据（脚本只在成功时落盘）
- **可随时干预**：`workflow_dispatch` 手动触发，或直接手动编辑 JSON 推送覆盖

**本方案的局限与对策：**

| 局限 | 对策 |
|------|------|
| 依赖各站点 RSS 稳定可用 | 来源独立降级；定期 `node scripts/check-recommendations.js --check` 体检 |
| 自动摘要为截断，可能不达人工水准 | 保留人工润色入口：可随时手动改 JSON 推送覆盖 |
| 分类映射可能不准确 | 映射表内维护，个别条目可在 JSON 中手动修正 `category` |
| 每日抓取可能取到重复/低质内容 | 去重 + 保留上限 12 条；结合白名单过滤关键词 |

### 3. 方案二：半自动「一条命令更新」（本地运行）

不引入 GitHub Actions，改为本地脚本一键拉取生成（含正文 `content`），人工审核后推送：

```bash
node scripts/update-news.js      # 抓取 RSS 生成 recommendations.json（含站内阅读正文）
node scripts/check-recommendations.js --check
git add . && git commit -m "更新每日资讯" && git push origin main
```

- 适合不想开自动化、但想省掉"手写 JSON"的工作量；每天花 2~3 分钟跑一遍 + 人工抽几条润色即可
- 实现成本与方案一相同（同一个 `update-news.js`），只是触发方式从"定时"变"手动"
- 站内阅读功能（2.1 节）为前端一次性改造，与更新方式无关，两种方案均可使用

### 4. 方案三：维持人工，但优化手工流程

- 优点：质量完全可控、零脚本维护
- 改善手段：固定来源清单（如上面 7 个站点）每天浏览 → 复制标题链接 → 用模板补全字段 → `check` 脚本兜底
- 适合资讯量少（每周几条）或对自动化持保守态度的场景

### 5. 实施步骤（方案一为例）

1. 新建 `scripts/update-news.js`：来源映射表 + RSS 抓取/解析 + 正文转 Markdown + 合并去重 + 落盘自检
2. 确认各来源 RSS 可用性（逐个 curl 验证），剔除无效来源
3. `article.html` 站内阅读改造（2.1 节）：`loadArticle` 支持 `type=news` 按 id 从 `recommendations.json` 加载，资讯模式下隐藏上下篇导航
4. `js/app.js` 资讯卡点击逻辑：有 `content` 进文章页、无 `content` 跳外链；`scripts/check-recommendations.js` 同步校验 `content`/`id` 唯一
5. 新增 `.github/workflows/update-news.yml` 定时工作流
6. 本地先跑一次脚本验证生成结果（含 `content`）与 `check-recommendations.js` 兼容
7. 推送后触发一次 `workflow_dispatch` 验证流水线；观察次日定时是否自动提交部署
8. 同步更新《博客完整使用手册》/操作文档维护流程、项目文档与更新日志

### 6. 优先级

| 优先级 | 事项 | 收益 |
|--------|------|------|
| P0 | `update-news.js` 抓取/解析/正文提取/去重/落盘 | 核心能力 |
| P0 | `.github/workflows/update-news.yml` 定时任务 | 每日自动更新 |
| P0 | `article.html` 站内阅读（`type=news` 加载资讯正文） | 阅读体验升级 |
| P0 | 资讯卡点击分流（有正文站内读 / 无正文跳外链） | 功能闭环 |
| P1 | 来源映射表 + 分类规则维护 | 内容质量 |
| P1 | 手动触发 + 人工润色覆盖入口 | 兜底可控 |
| P2 | 自动摘要去 HTML / 关键词白名单过滤 | 打磨 |
| P2 | 更新日报（如更新后发 Issue 摘要） | 可追踪 |

---

**状态：** AI 助手部分已实施（v2.2.0）；Anime.js 动画方案已实施（v2.4.0）；首页改造方案已实施（v2.4.2，P0/P1 项）；标签区改为导航栏"全部标签"面板（v2.4.5）；Hero 重设计已实施（v2.5.0，P0/P1 项）；animejs.com 动效借鉴已实施（v2.5.2，P0/P1 项）；Hero 区重新设计已实施（v2.6.0，方案 A）；Hero 与内容区左右切换方案待评审；省去 Hero 区方案已实施（v2.6.3，方案 A）；"我的"个人仪表盘已实施（v2.6.16）；文章页阅读体验已实施（v2.6.25）；"推荐"页面设计方案已改版为「每日新闻」视图（v2.6.58，位于图库与我的之间，列表式展示资讯，无卡片图片）；「资讯每日更新」自动化方案已实施（v2.6.51，含资讯站内阅读 2.1 节）
**作者：** 渡鸦NULL

---

# 长文本加载性能优化方案

> 目标：解决加载长篇文章时的卡顿与等待问题，从**网络请求、解析渲染、缓存策略**三个维度系统性提速。

### 1. 现状与瓶颈分析

当前长文本加载链路：

```
fetch(.md) → response.text() → parseFrontmatter() → marked.parse() [同步] → innerHTML → hljs.highlightElement() [同步]
```

| 瓶颈 | 位置 | 影响 |
|------|------|------|
| 首页加载全部文章正文 | `app.js:49-51` | 每篇文章的**完整 Markdown** 都被 fetch 到内存，但首页仅需摘要（150 字） |
| 文章页重新加载全部文章列表 | `article.html:1786-1833` | 为生成上/下一篇导航，再次 fetch 所有 .md 文件提取 frontmatter |
| Markdown 同步解析阻塞主线程 | `markdown.js:137` | `marked.parse()` 在主线程执行，长文（如 488 行使用手册）会导致可感知卡顿 |
| 单次 innerHTML 大量 DOM 更新 | `article.html:1890-1891` | 整篇 HTML 字符串一次性注入，触发大规模 DOM 树重建 |
| 代码高亮仍在主线程 | `article.html:1899-1911` | 虽已分批（10 个/批），但 hljs 本身在主线程执行 |
| 资讯含全文时 JSON 过大 | `data/recommendations.json` | 部分资讯条目含完整 `content`，JSON 体积膨胀，全量解析只为取一条 |

### 2. 优化方案

#### 2.1 首页：仅加载 frontmatter + 摘要（不加载正文）⭐ 最高优先级

**现状：** `loadPost()` 调用 `MarkdownParser.loadFromFile()` 获取完整 .md 文件，将整个正文存入 `content` 字段。首页渲染卡片只用 `excerpt`（150 字），`content` 完全浪费。

**方案：** 新增 `loadPostMeta()` 方法，fetch 后只解析 frontmatter + 截取摘要，不保留正文：

```javascript
async loadPostMeta(filename) {
    const filePath = `${this.config.postsDirectory}/${filename}`;
    const response = await fetch(filePath);
    const raw = await response.text();
    const { frontmatter, content } = MarkdownParser.parseFrontmatter(raw);
    // 只取摘要，丢弃正文
    const excerpt = frontmatter.excerpt || MarkdownParser.extractExcerpt(content);
    const image = frontmatter.image || MarkdownParser.extractFirstImage(content) || this.getRandomBgImage(filename);
    return {
        filename,
        title: frontmatter.title || filename.replace('.md', ''),
        date: frontmatter.date,
        tags: frontmatter.tags || [],
        author: frontmatter.author || 'Anonymous',
        excerpt,
        image,
        wordCount: content.length
        // 不存储 content
    };
}
```

**收益：** 内存占用降低 80%+（正文不再驻留），首页加载提速 30-50%（不存储大字符串）。

#### 2.2 首页：分块加载 / 渐进渲染

**现状：** `Promise.all(postFiles.map(...))` 等待全部文章加载完毕后才渲染。

**方案：** 改为 `Promise.allSettled()` + 渐进渲染——每篇文章加载完成即刻渲染其卡片，无需等待全部：

```javascript
async loadPosts() {
    // ...缓存逻辑不变...
    const postFiles = await this.getPostFiles();
    this.posts = [];

    // 先渲染空壳骨架屏
    this.renderSkeletons(postFiles.length);

    // 逐个加载，完成即渲染
    for (const file of postFiles) {
        const post = await this.loadPostMeta(file);
        if (post) {
            this.posts.push(post);
            this.appendPostCard(post); // 追加到 DOM
        }
    }

    // 全部完成后排序 + 入场动画
    this.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    this.filteredPosts = [...this.posts];
    this.renderPosts(); // 重排 DOM 顺序
}
```

**收益：** 首张卡片出现时间从"全部加载完"变为"第一篇加载完"，感知速度提升 60%+。

#### 2.3 文章页：Markdown 解析移至 Web Worker

**现状：** `marked.parse()` 在主线程执行，长文解析期间页面无响应。

**方案：** 将 Markdown 解析放入 Web Worker，主线程保持流畅：

```javascript
// js/markdown-worker.js
self.onmessage = function(e) {
    importScripts('vendor/marked.min.js');
    const { content, id } = e.data;
    const html = marked.parse(content, { breaks: true, gfm: true });
    self.postMessage({ html, id });
};

// js/markdown.js 中新增
parseMarkdownAsync(content) {
    return new Promise((resolve) => {
        // 短文本直接主线程解析（避免 Worker 开销）
        if (content.length < 5000) {
            return resolve(this.parseMarkdown(content));
        }
        const worker = new Worker('js/markdown-worker.js');
        const id = Date.now();
        worker.onmessage = (e) => {
            resolve(e.data.html);
            worker.terminate();
        };
        worker.postMessage({ content, id });
    });
}
```

**收益：** 长文解析不再阻塞主线程，页面滚动、点击等交互保持流畅。解析期间可显示 loading 动画。

#### 2.4 文章页：增量 DOM 渲染

**现状：** `content.innerHTML = html` 一次性注入大量 HTML。

**方案：** 对超长文章（>10000 字）采用分段注入：

```javascript
async renderArticle() {
    const html = await MarkdownParser.parseMarkdownAsync(this.currentPost.content);

    // 按 h2/h3 分割为段落块
    const sections = html.split(/(?=<h[23])/);
    content.innerHTML = '';

    // 首屏立即渲染前 3 块
    const firstBatch = sections.splice(0, 3);
    content.innerHTML = firstBatch.join('');

    // 剩余块用 requestIdleCallback 空闲时追加
    const appendNext = () => {
        if (sections.length === 0) return;
        const chunk = sections.splice(0, 2).join('');
        content.insertAdjacentHTML('beforeend', chunk);
        if (sections.length > 0) requestIdleCallback(appendNext);
    };
    requestIdleCallback(appendNext);
}
```

**收益：** 首屏渲染时间缩短（只处理前几个段落），剩余内容在浏览器空闲时渐进填充，不阻塞交互。

#### 2.5 文章页导航：复用首页缓存 / 独立轻量接口

**现状：** `loadAllPosts()` 重新 fetch 所有 .md 文件提取 frontmatter，与首页重复劳动。

**方案（三选一）：**

| 方案 | 说明 | 改动量 |
|------|------|--------|
| **A（推荐）**：复用 sessionStorage 缓存 | 首页已缓存 `blog-posts-data-v8`（含 filename/title/date/tags），文章页直接读取 | 极小 |
| **B**：manifest.json 扩展字段 | 在 manifest.json 中直接存 frontmatter 元数据，一次 fetch 搞定 | 小 |
| **C**：单独的 index.json | 新建 `posts/index.json` 存所有文章元数据，文章页只需 fetch 这一个文件 | 中 |

**方案 A 实现（推荐）：**

```javascript
async loadAllPosts() {
    // 直接复用首页缓存
    const cached = sessionStorage.getItem('blog-posts-data-v8');
    if (cached) {
        this.allPosts = JSON.parse(cached).map(p => ({
            filename: p.filename,
            title: p.title,
            date: p.date,
            tags: p.tags
        }));
        return;
    }
    // 缓存未命中时的降级逻辑（原有逻辑）
    // ...
}
```

**收益：** 文章页省去 N 次网络请求（N = 文章数），上/下一篇导航瞬时出现。

#### 2.6 代码高亮：移至 Worker 或懒执行

**现状：** `hljs.highlightElement()` 在主线程分批执行。

**方案：**
- **短文（<5000 字）**：保持现有分批策略
- **长文（≥5000 字）**：仅对视口内可见的代码块立即高亮，其余用 IntersectionObserver 懒高亮：

```javascript
function highlightVisibleCodeBlocks(container) {
    const blocks = container.querySelectorAll('pre code:not(.hljs)');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                hljs.highlightElement(entry.target);
                observer.unobserve(entry.target);
            }
        });
    }, { rootMargin: '200px' }); // 提前 200px 开始高亮
    blocks.forEach(block => observer.observe(block));
}
```

**收益：** 长文首屏代码高亮延迟从"全部代码块"降为"首屏可见代码块"，其余滚动到时再高亮。

#### 2.7 资讯正文按需加载

**现状：** `loadNewsArticle()` fetch 整个 `recommendations.json`（含所有资讯的 `content`），只为取一条。

**方案：** 
- **方案 A**：资讯正文拆分为独立文件（如 `data/news/n01.json`），按需 fetch 单条
- **方案 B（推荐）**：保持单文件，但 `loadNews()` 只返回不含 `content` 的摘要列表；需要正文时单独 fetch + 解析 + 按 id 过滤

```javascript
async loadNewsArticle(id) {
    const res = await fetch('data/recommendations.json');
    const text = await res.text();
    // 流式解析：只找目标 id，不解析全部
    const regex = new RegExp(`"id"\\s*:\\s*"${id}"[\\s\\S]*?"content"\\s*:\\s*"([\\s\\S]*?)"`);
    const match = text.match(regex);
    // ...
}
```

**收益：** 资讯文章页加载提速（尤其当 recommendations.json 含大量正文时）。

### 3. 缓存策略增强

| 优化项 | 现状 | 建议 |
|--------|------|------|
| sessionStorage 缓存 key | 固定版本号 `v8` | 改为内容哈希，内容变化自动失效 |
| 文章页导航缓存 | 独立 key `blog-posts-cache-v2` | 复用首页缓存（方案 2.5A） |
| HTTP 缓存 | 无 Service Worker | 添加 SW 缓存静态资源 + 文章文件，离线可用 |
| 资讯缓存 | 无 | 与文章一致，用内容哈希做 key |

### 4. 实施优先级

| 优先级 | 方案 | 预计工作量 | 收益 |
|--------|------|-----------|------|
| P0 | 2.1 首页不加载正文 | 小 | 内存↓80%，加载提速 30-50% |
| P0 | 2.5A 文章页导航复用缓存 | 极小 | 省去 N 次网络请求 |
| P1 | 2.2 首页渐进渲染 + 骨架屏 | 中 | 首卡出现提速 60%+ |
| P1 | 2.3 Markdown 解析 Worker 化 | 中 | 长文解析不阻塞主线程 |
| P1 | 2.6 代码高亮懒加载 | 小 | 长文首屏高亮提速 |
| P2 | 2.4 增量 DOM 渲染 | 中 | 超长文首屏渲染提速 |
| P2 | 2.7 资讯正文按需加载 | 小 | 资讯页加载提速 |
| P2 | Service Worker 离线缓存 | 大 | 二次访问秒开 + 离线可用 |

### 5. 预期效果

- **首页加载**：文章数增长后依然流畅（不加载正文，渐进渲染首卡）
- **文章页打开**：长文（如 488 行使用手册）解析不卡顿，首屏秒出
- **导航**：上/下一篇瞬时可用（复用缓存，无额外请求）
- **代码高亮**：首屏可见代码即时高亮，其余按需
- **内存**：首页不再驻留所有文章正文，标签页长时间打开不卡

---

# 前后端合并部署至 Netlify 方案

> 目标：将博客前端（`02-personal-blog`，GitHub Pages）与后端（`02-blog-server`，Netlify Functions）合并为一个 Netlify 站点，消除跨域、简化部署、统一域名。

### 1. 现状

| 项目 | 部署位置 | 域名 | 技术 |
|------|----------|------|------|
| 前端 `02-personal-blog` | GitHub Pages | `ravennull.work` | 纯静态 HTML/CSS/JS |
| 后端 `02-blog-server` | Netlify | `r-n-blog-server.netlify.app` | Netlify Functions + Blobs |

**问题**：前端通过 `fetch('https://r-n-blog-server.netlify.app/api/...')` 跨域调用后端，需要 CORS 配置，且依赖两个平台的可用性。

### 2. 合并后目录结构

```
blog-unified/                        # 合并后的项目根目录
├── netlify.toml                     # 合并后的部署配置
├── package.json                     # 后端依赖（netlify/functions 需要）
├── tsconfig.json                    # 后端 TypeScript 配置
├── pnpm-lock.yaml
│
├── netlify/                         # 后端 Netlify Functions
│   └── functions/
│       ├── news.ts                  # 资讯聚合 API
│       ├── comments.ts              # 评论 CRUD
│       ├── upload.ts                # 图片上传
│       ├── image.ts                 # 图片服务
│       ├── refresh.ts               # 定时刷新资讯缓存
│       └── _shared/                 # 共享库（blob、cors、news sources 等）
│
├── index.html                       # 前端首页
├── article.html                     # 前端文章页
├── css/                             # 前端样式
├── js/                              # 前端脚本
├── images/                          # 前端图片
├── posts/                           # Markdown 文章
├── data/                            # 资讯 fallback 数据
├── favicon.ico
├── feed.xml
├── CNAME                            # 域名配置（可保留或删除）
└── .nojekyll
```

### 3. 合并步骤

#### 第一步：创建统一项目

```bash
# 新建合并目录
mkdir blog-unified && cd blog-unified

# 初始化 git
git init

# 复制前端所有文件（保留目录结构）
# 将 02-personal-blog 下的 index.html、article.html、css/、js/、
# images/、posts/、data/、favicon.ico、feed.xml、.nojekyll 等全部复制过来

# 复制后端核心文件
# 将 02-blog-server 下的 netlify/、package.json、tsconfig.json、
# pnpm-lock.yaml、pnpm-workspace.yaml 复制过来
```

#### 第二步：合并 netlify.toml

```toml
[build]
  # 无构建步骤，纯静态 + Functions
  command = "echo 'Static site with Functions'"
  publish = "."                        # 发布根目录（前端静态文件所在）
  functions = "netlify/functions"

[functions]
  # 使用 esbuild 或 tsc 编译 Functions
  node_bundler = "esbuild"

# API 路由 → Functions（必须在 SPA catch-all 之前）
[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

# 前端多页应用：不需要 catch-all（index.html 和 article.html 各自独立）
# 如需 SPA 路由可按需添加：
# [[redirects]]
#   from = "/*"
#   to = "/index.html"
#   status = 200
```

#### 第三步：修改前端 apiBase 为同源

`js/app.js` 第 10 行：

```javascript
// 修改前（跨域）
apiBase: 'https://r-n-blog-server.netlify.app'

// 修改后（同源，留空即可）
apiBase: ''
```

所有 `fetch(this.config.apiBase + '/api/...')` 会自动请求同源 `/api/...`，无需 CORS。

#### 第四步：处理 commentImageSrc

`js/app.js` 中 `commentImageSrc()` 方法：

```javascript
// 修改前：相对路径补全为后端绝对地址
commentImageSrc(url) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    if (url.startsWith('/api/')) return this.config.apiBase + url;
    return url;
}

// 修改后：同源直接返回
commentImageSrc(url) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    return url;  // /api/image?key=xx 直接同源请求
}
```

#### 第五步：删除后端 status 页面

删除 `02-blog-server/public/index.html`（后端的占位状态页），前端的 `index.html` 成为站点首页。

#### 第六步：清理 CORS 配置

后端 `_shared/cors.ts` 中的 CORS 头可保留（方便外部 API 消费者），但 `ALLOWED_ORIGIN` 环境变量不再必需，可设置为 `*` 或直接删除。

#### 第七步：合并 package.json

```json
{
  "name": "raven-blog",
  "private": true,
  "scripts": {
    "dev": "netlify dev",
    "build": "echo 'Static site'"
  },
  "dependencies": {
    "@netlify/blobs": "^10.7.12",
    "@netlify/functions": "^5.3.0"
    // ... 后端其他依赖
  }
}
```

> 前端无需 npm 依赖（纯静态），只需保留后端的 `package.json`。

### 4. 部署流程

```bash
# 1. 推送到 GitHub
git remote add origin https://github.com/raven-null/blog-unified.git
git add -A && git commit -m "合并前后端"
git push -u origin main

# 2. Netlify → Add new site → Import from GitHub
# 3. 构建配置自动读取 netlify.toml：
#    - Build command: echo 'Static site'
#    - Publish dir: .
#    - Functions dir: netlify/functions
# 4. 配置环境变量：
#    - ADMIN_KEY（评论管理密钥）
#    - MIHOYO_*（如需米哈游登录，本项目不需要）
# 5. 绑定自定义域名：ravennull.work
# 6. DNS 指向 Netlify（CNAME → xxx.netlify.app）
```

### 5. 关键注意事项

| 事项 | 说明 |
|------|------|
| **redirect 顺序** | `/api/*` 必须在 `/*` catch-all 之前，否则 API 请求会被拦截为 HTML |
| **publish 目录** | 必须为 `.`（根目录），否则 `index.html`、`article.html` 等无法被访问 |
| **Functions 运行时** | Netlify Functions 使用 Node.js，需确保 `tsconfig.json` 兼容 |
| **Blobs 存储** | 合并后 Blobs store 名称不变（`newsnow-comments`、`comment-images`），数据无需迁移 |
| **GitHub Pages** | 合并后可删除 `.github/workflows/` 中的部署配置和 `CNAME` 文件 |
| **定时任务** | 后端 `refresh.ts` 的 `@hourly` cron 需在 Netlify Scheduled Functions 中配置 |
| **域名切换** | DNS 从 GitHub Pages 切换到 Netlify 时会有短暂不可用（TTL 相关） |

### 6. 合并收益

- **消除跨域**：同源请求，无需 CORS，调试更简单
- **统一部署**：一次推送，前端 + 后端同时更新
- **统一域名**：`ravennull.work` 同时承载页面和 API
- **降低成本**：只需维护一个 Netlify 站点
- **简化开发**：`netlify dev` 一个命令启动前端 + Functions 联调

### 7. 优先级

| 优先级 | 事项 | 工作量 |
|--------|------|--------|
| P0 | 创建统一项目 + 合并文件 | 小 |
| P0 | 合并 netlify.toml | 极小 |
| P0 | 修改 apiBase 为同源 | 极小 |
| P0 | Netlify 部署 + 域名切换 | 小 |
| P1 | 删除后端 status 页面 + 清理 CORS | 极小 |
| P1 | 验证评论/资讯/图片上传全部正常 | 小 |
| P2 | 清理旧仓库（GitHub Pages 配置） | 极小 |

---

# 博客写作 AI 助手方案（后台写文章时嵌入 AI 辅助创作）

> 目标：在管理后台的「写文章」编辑器中嵌入一个 AI 写作助手，帮助生成标题、大纲、草稿、续写、润色、摘要与标签，把 AI 能力从"前台聊天"延伸到"内容创作"。
>
> 建议做法：**在后台写文章页新增一个 AI 助手侧栏**，通过一个**后端代理接口**（`/api/ai`）调用大模型，密钥留在服务端、支持流式输出、仅管理员可用。

## 1. 方案定位

| 维度 | 前台聊天助手（已有） | 后台写作助手（本方案） |
|------|---------------------|------------------------|
| 位置 | 文章页右下角聊天窗口 | 管理后台「写文章」编辑器侧栏 |
| 使用者 | 所有访客 | 仅站长（需登录后台） |
| 目标 | 答疑、陪聊、划词解释 | 辅助写文章：选题→大纲→草稿→润色 |
| 输出 | 聊天气泡 | 直接插入 / 追加到正文编辑器 |
| 上下文 | 对话历史 | 当前标题、正文、已有文章与标签 |

**为什么放后台编辑器：** 写文章是管理员的私有行为，接入点最贴近正文，AI 生成结果可"一键插入"，比复制粘贴到前台聊天更顺畅。

## 2. 配置分离设计（写作 AI 与聊天 AI 各自独立）

**写博客用的 AI 与前台聊天助手分开配置。** 两者很可能使用不同的大模型厂商 / 模型规格，且系统提示词与关键词风格完全不同（聊天面向访客答疑，写作面向内容创作），混用一套配置会互相掣肘。

### 2.1 为什么必须分开

| 维度 | 前台 AI 助手（聊天） | 后台写作 AI |
|------|---------------------|-------------|
| 使用者 | 访客 | 站长 |
| 模型选择 | 便宜、快速即可（如 `glm-4-flash`） | 可换更强模型（如 GLM-4 / DeepSeek / Claude） |
| 系统提示词 | 管理员接待人设 | 写作助手人设 + 关键词约束 |
| 关键词 | 无（自由问答） | 有：要求文中使用指定关键词、贴合站点选题 |
| 温度 | 0.7 左右，灵活 | 建议更低（0.5-0.7），保证文风稳定 |
| 最大输出 | 2048 | 更大（4096-8192，用于生成全文） |
| 密钥 | 聊天服务商的 Key | 可完全不同的服务商 / 账号 |

### 2.2 「博客设置」中的分组（推荐）

在「博客设置」分两个**独立分组**，字段完全分开、各自保存：

- **AI 助手**（现有）：`ai` → `enabled / apiUrl / apiKey / model / systemPrompt / maxTokens / temperature`
- **写作 AI**（新增）：`writingAi` → `enabled / apiUrl / apiKey / model / systemPrompt / keywords / maxTokens / temperature`

### 2.3 写作 AI 字段设计（建议）

| 字段 | 说明 | 默认 |
|------|------|------|
| `enabled` | 是否在写文章页启用写作助手 | `true` |
| `apiUrl / apiKey / model` | 写作用大模型（可与聊天不同） | 空 → 回退「AI 助手」配置 |
| `systemPrompt` | 写作助手人设 | 内置「写作助手」人设（见 §6） |
| `keywords` | 写作关键词约束（逗号分隔）：要求 AI 在成稿中使用这些关键词、贴合站点选题方向 | 空 |
| `maxTokens` | 单次生成长度上限 | `4096` |
| `temperature` | 温度 | `0.7` |

**回退策略：** `writingAi` 的 `apiUrl / apiKey / model` 未填写时，自动复用「AI 助手」的配置，保证开箱即用；但 `systemPrompt / keywords / maxTokens / temperature` 一律使用写作 AI 自己的值，不与聊天混用。

### 2.4 后端与存储实现

- `blog-settings` 存储新增 `writingAi` 对象，GET 合并默认值（与现有 `ai` 完全同理，见 `admin.ts` 的 settings 处理）
- `/api/ai` 读取配置时：**`writingAi` 优先，缺失字段回退 `ai`**；`systemPrompt` 使用写作人设，并把 `keywords` 追加进系统提示词（见 §6）
- 前端侧栏展示当前生效的写作 AI 来源（"写作 AI（独立配置）"或"写作 AI（回退聊天配置）"），便于站长感知

## 3. 功能清单（分层实施）

### 3.1 基础：编辑器内 AI 侧栏（推荐先做）

在「写文章」编辑区右侧（或底部）加一个可折叠的 **AI 助手面板**，提供六个动作按钮：

| 动作 | 说明 | 输出位置 |
|------|------|----------|
| 🪄 生成标题 | 输入主题/关键词 → 生成 5-10 个备选标题 | 以列表形式展示，点击填入标题框 |
| 📋 生成大纲 | 根据标题/主题生成 Markdown 大纲 | 一键追加到正文 |
| ✍️ 生成全文 | 根据标题+大纲生成完整初稿 | 一键追加到正文（可设字数） |
| ➕ 续写 | 基于正文末尾内容继续往下写 | 追加到正文末尾 |
| 🖌 润色 | 对选中的文字或全文润色、改写、扩写 | 替换选中文字 / 追加 |
| 🏷 摘要与标签 | 自动生成摘要、推荐标签 | 填入摘要框与标签选择器 |

### 3.2 进阶：上下文感知（提升成稿质量）

- 调用时自动携带**当前标题、已写正文、编辑器选中的文字**作为上下文
- 注入**已有文章的标题与标签**，让 AI 规避重复选题、保持风格一致
- 支持"以某标签/风格写一篇"（如"技术"风格、口语化 / 正式）

### 3.3 扩展（后续）

- **封面建议**：根据文章主题推荐图库中已有的图片（返回图片链接列表）
- **全文改写/扩写**：一键扩到指定字数
- **批量选题**：输入 N 个主题，批量生成标题与大纲，供挑选
- **错别字/病句检查**：对已写正文做校对并输出修改建议

## 4. 技术方案（推荐做法）

### 4.1 整体架构

```
admin.html 写文章页
   └── AI 助手侧栏（前端）
         │  ① 携带: action + 上下文(标题/正文/选中文字) + X-Admin-Key
         ▼
      /api/ai  (Netlify Function)
         │  ② 校验管理员 → 从 blog-settings 读 writingAi 配置（缺失字段回退 ai）
         │  ③ 组装 Prompt（写作人设 + keywords）→ 转发到上游大模型（stream: true）
         ▼
      大模型流式返回
         │  ④ SSE 增量
         ▼
   AI 侧栏实时渲染 → 用户点击"插入/替换/填入"
```

**要点：**
- 新增独立后端函数 `/api/ai`，**不要**让浏览器直连大模型（避免 CORS 与密钥暴露）
- 密钥只存于 `blog-settings` Blobs，后端读取，前端永不接触
- 请求体带 `X-Admin-Key` 鉴权，**仅登录后台的站长可用**，防他人盗刷
- 配置读取**写作 AI（`writingAi`）优先，未填写时回退「AI 助手（`ai`）」**；`systemPrompt` 用写作人设，`keywords` 额外拼接

### 4.2 后端 `/api/ai` 函数（示意）

```ts
// netlify/functions/ai.ts  —— 新增
import { getBlobStore } from "./_shared/blob"

export default async (req: Request) => {
  // OPTIONS / CORS 处理（复用 cors.ts 的 noContent/json）

  // 1. 鉴权：读取后台密码校验 X-Admin-Key（复用 admin.ts 的 getAdminPassword）
  // 2. 读取写作 AI 配置（从 blog-settings 读取字段 writingAi.*，缺失回退 ai.*）
  //    注意：settings GET 是公开的，但此处应直接从 Blob 读，服务端侧不依赖公开接口
  // 3. 从请求体取 { action, title, content, selection, topic, keywords, maxTokens }
  // 4. 组装 messages：system = 写作人设 + keywords；user = 对应动作模板（见 §5）
  // 5. fetch 上游 { model, messages, stream: true, maxTokens: writingAi.maxTokens, temperature }
  // 6. 逐段转发上游 SSE：把 response.body 透传给前端
  return new Response(upstream.body, { headers: { "Content-Type": "text/event-stream" } })
}
```

> 流式转发写法：`fetch` 得到 `upstream.body`（ReadableStream）后直接 `return new Response(upstream.body, ...)` 即可实现 SSE 透传，无需逐行解析。

### 4.3 前端 AI 侧栏（示意）

- 放在 `admin.html` 的 `#tab-write` 编辑区，右侧固定宽约 300px，可折叠
- 顶部：动作按钮行（标题/大纲/全文/续写/润色/摘要标签）
- 中部：可选参数（字数、风格/标签下拉）
- 正文区：流式渲染结果（复用 `MarkdownParser`，代码无需高亮）
- 底部：**「插入正文」「替换选中」「填入标题」「填入摘要」「填入标签」**按钮，按动作类型出现
- 流式中可「停止生成」；结果可在编辑器内二次编辑后再插入

```javascript
// 前端核心调用（流式）
const res = await fetch('/api/ai', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
  body: JSON.stringify({
    action: 'draft',                 // title/outline/draft/continue/polish/summarize
    title: edTitle.value,
    content: edContent.value,
    selection: getSelectedText(),    // 润色时必填
    topic: topicInput.value,         // 生成标题/大纲时的主题
    keywords: keywordsInput.value,   // 写作关键词（可选，追加到系统提示词）
    maxTokens: 4096                  // 以写作 AI 配置的上限为准
  })
});
// 解析 SSE data: 行，逐段追加到侧栏
```

### 4.4 编辑器接线

| 动作 | 插入方式 |
|------|----------|
| 生成标题 | 点击候选标题 → 填入 `#edTitle` |
| 生成大纲/全文/续写 | 「插入正文」→ 追加到 `#edContent` 末尾（大纲可先插入再手动改） |
| 润色 | 「替换选中」→ 用结果替换 `#edContent` 中选中的文字 |
| 生成摘要 | 「填入摘要」→ 写入 `#edExcerpt` |
| 推荐标签 | 「填入标签」→ 加入当前标签选择器（`addTag`） |

## 5. Prompt 模板（写作提示词库）

所有动作走同一套 `messages`：`system`（写作助手人设 + 关键词约束，见 §6）+ `user`（模板拼接）。模板建议：

| 动作 | user 消息模板 |
|------|---------------|
| title | `请为以下主题生成 5-10 个吸引人的中文博客标题（每行一个）：\n主题：{topic}\n已有文章：{existingTitles}` |
| outline | `请为《{title}》生成 Markdown 大纲（二级/三级标题，加粗要点）：\n{content}` |
| draft | `请根据以下标题和大纲，写一篇约 {words} 字的中文博客初稿（Markdown，含代码块可留占位）：\n标题：{title}\n大纲：{outline}\n` |
| continue | `请接着下面的正文继续写，保持语气与结构一致：\n{content}` |
| polish | `请润色以下文字，使其更通顺、有文采、适合博客阅读：\n{selection}` |
| summarize | `请为这篇文章写一段 100-150 字的摘要，并推荐 3-5 个标签（用、分隔）：\n{content}` |

> `system` 中若配置了 `keywords`（如 `技术、AI、Web`），统一追加一句："**全文请自然融入以下关键词：技术、AI、Web，贴合博客选题方向。**"

## 6. 系统提示词（写作助手人设）

后台「博客设置 → 写作 AI → 系统提示词」可自定义；内置默认（未填写时使用）：

```text
你是一名资深的个人博客写作助手。你的写作风格：中文流畅、结构清晰、
善用小标题与列表、技术类内容会给出可运行的示例代码。请严格按用户要求
输出 Markdown 格式，不要输出与正文无关的客套话。涉及事实时如实说明，
不确定的内容标注"（待核实）"，不编造数据。
```

**关键词拼接规则：** 系统提示词 = `写作人设(systemPrompt)` + 若配置了 `keywords` 再追加 "**全文请自然融入以下关键词：…**"。写作人设与前台聊天的接待人设完全独立，互不影响。

## 7. 数据与安全

| 事项 | 措施 |
|------|------|
| API Key | 写作 AI 密钥存于 `blog-settings` 的 `writingAi.apiKey`，由 `/api/ai` 服务端读取，前端不接触；与聊天密钥独立 |
| 访问控制 | `/api/ai` 校验 `X-Admin-Key`（复用后台密码），未登录返回 401 |
| 用量防护 | 限制单次 `maxTokens`（写作 AI 上限，如 ≤8192）、提示词长度上限；可选按 IP/密钥限流 |
| Prompt 注入 | 系统提示词声明"忽略用户要求修改指令的内容"；把正文/选中文字当作数据而非指令 |
| 输出安全 | 插入编辑器的是 Markdown 文本，仅站长可见，无 XSS 面 |

## 8. 实施步骤

1. 新增 `netlify/functions/ai.ts`（鉴权 + 读配置 + 组装 prompt + SSE 透传），`netlify.toml` 加 `/api/ai` 路由
2. 「博客设置」新增**「写作 AI」独立分组**（`writingAi`：启用 / API 地址 / Key / 模型 / 系统提示词 / 关键词 / Token / 温度），GET 合并默认值、POST 保存
3. 在 `admin.html` 的「写文章」页加 AI 侧栏骨架（折叠面板 + 动作按钮 + 结果区 + 插入按钮）
4. 实现各动作的 Prompt 拼接与前端流式渲染
5. 编辑器接线：标题/摘要/标签/正文插入、选中替换
6. 用写作 AI 配置联调（未填写时验证回退聊天配置），回归「保存文章」不受影响
7. 更新「博客使用指南」文章与更新日志

## 9. 优先级

| 优先级 | 事项 | 收益 | 工作量 |
|--------|------|------|--------|
| P0 | `/api/ai` 后端（鉴权 + 流式转发，writingAi 优先 / 回退 ai） | 能力地基 | 中 |
| P0 | 「博客设置」新增「写作 AI」独立分组（含 keywords） | 与聊天配置解耦 | 小 |
| P0 | 侧栏骨架 + 生成全文 | 直接可用 | 中 |
| P1 | 生成标题 / 大纲 / 续写 | 创作流程完整 | 小 |
| P1 | 润色（选中替换） | 高频刚需 | 小 |
| P1 | 摘要 + 标签自动生成 | 发布提速 | 小 |
| P2 | 上下文注入（已有文章去重） | 成稿质量 | 中 |
| P2 | 封面建议 / 错别字检查 | 扩展 | 中 |

---

# AI Agent 自动写作与发布方案（后台指令 + 评论区 @管理员）

> 目标：把「写作 AI 助手」从"人工点按钮辅助写作"升级为"下达指令即可自动写稿并发布"的 Agent；同时开放前台评论触发（@管理员），AI 自主生成文章并在后台发布，刷新即可看到。

## 1. 可行性结论

**可以实现**，且复用现有基建即可，无需引入新的存储 / 消息队列：

| 依赖能力 | 现状 | 可复用 |
|----------|------|--------|
| 大模型调用（流式 / 续写） | `netlify/functions/ai.ts` 已实现鉴权 + 组装 Prompt + SSE 透传 | ✅ 抽取公共模块复用 |
| 文章创建 / 发布 | `netlify/functions/admin.ts` `action=articles` POST（标题/标签/摘要/正文/状态） | ✅ 抽取 `_shared/articles.ts` 复用 |
| 评论存储 | `comments.ts` + `_shared/blob.ts`（按 postId 存 Blobs） | ✅ 用 `@管理员` 触发词识别 + 后端直写受理/完成评论 |
| 配置 | 博客设置已有 `writingAi` / `ai` 分组 | ✅ 新增 `agent` 分组 |
| 异步任务 | Netlify Blobs + Functions | ✅ 任务队列存 Blobs，后台函数消费 |

> 唯一需要重点设计的是「长文自动生成」与「异步执行」（Netlify 同步函数超时约 10s，长文必须异步），见第 3、4 节。

## 2. 目标场景

### 场景 A：后台 Agent（管理员指令）
后台「写文章」新增「🤖 AI Agent」命令面板：
- 输入：`写一篇 3000 字、面向新手的 Python 教程并发布`、`把《xxx》翻译成英文并发布`、`生成本周技术周报草稿`
- Agent 自主完成：规划大纲 → 生成正文（超长自动续写）→ 提取标题 / 标签 / 摘要 → 存为草稿或直接发布
- 面板实时显示进度（正在生成 / 已发布），完成后给出文章链接

### 场景 B：前台评论触发（@管理员）
- 访客在任意文章评论区写：`@管理员 写一篇关于 Python 的文章并发布`
- 系统自动受理：先回一条 `🤖 收到任务，正在生成…` 的评论
- Agent 在后台生成 → 发布文章 → 自动回评：`✅ 已发布《从零开始学 Python》：链接`
- 访客刷新页面即可看到新文章与完成评论

## 3. 架构设计

### 3.1 新增 `/api/agent` 函数

```
POST /api/agent
  { source: "admin" | "comment", adminKey?, postId?, commentId?, instruction }
```

- `source=admin`：校验 `X-Admin-Key`
- `source=comment`：公共入口，须满足：Agent 开关开启、IP 限流、字数 / 配额校验

### 3.2 任务模型（Blobs `blog-agent-tasks`）

```json
{
  "id": "a1b2c3d4",
  "source": "comment",
  "instruction": "写一篇关于 Python 的文章并发布",
  "postId": "xxx", "commentId": "yyy",
  "status": "pending | running | done | failed",
  "progress": "正在生成大纲…",
  "result": { "articleId": "xxx", "title": "...", "url": "/article.html?id=xxx" },
  "error": "",
  "createdAt": 1730000000000,
  "startedAt": 0, "finishedAt": 0,
  "ip": "1.2.3.4"
}
```

### 3.3 异步执行（关键）

Netlify 同步函数约 10s 超时，3000 字生成远超此限，需异步执行：

| 方案 | 说明 | 推荐 |
|------|------|------|
| A 后台函数（Background Function） | 收到请求后 `return Response(202)`，函数继续在后台执行（上限约 15 分钟），长文用「继续写」分片续写 | ⭐ 首选，改动最小 |
| B 定时 Worker | 任务写入队列 Blobs，Scheduled Function（cron）每隔 1-2 分钟轮询消费；注意定时函数部分套餐受限 | 备选 / 兜底 |
| C 前端长连接 + 多次续写 | 后台 Agent 面板保持 SSE 连接逐段续写（与现有 AI 写作助手一致）；评论触发无法用此方案（无交互会话） | 仅适合场景 A |

> 建议：场景 A 用 C（面板流式展示，体验最好）；场景 B 的评论触发用 A 或 B 异步完成。为统一，优先全部走「后台函数 + 队列」，面板通过轮询任务状态渲染进度。

### 3.4 LLM 产出方式（二选一，先 A 后 B）

- **方案 A（先做）：结构化 JSON 输出**。系统提示词要求模型仅输出：

  ```json
  { "title": "...", "tags": ["Python"], "excerpt": "...", "status": "published|draft", "content": "# ...Markdown..." }
  ```

  后端解析 → 校验（标题非空、字数达标、内容为合法 Markdown）→ 落库。简单可靠，glm-4-flash 即可稳定输出。

- **方案 B（增强）：Function Calling 工具调用**。定义工具 `create_article` / `search_articles` / `list_tags` / `list_images`，让模型自主多步决策（查已有文章避免重复、选封面图、决定是否发布），更接近"真 Agent"，工作量更大。

### 3.5 发布落地

- 抽取 `netlify/functions/_shared/articles.ts`：`createArticle({ title, tags, excerpt, image, content, status })`，复用 `admin.ts` 的写索引、同步标签注册表、自动提取摘要逻辑
- 评论触发默认 `status="draft"`（安全），由管理员一键发布；可在设置中开启「评论触发生成后直接发布」

## 4. 前台评论触发流程

```
访客提交评论
   │  评论内容含「@管理员」/「@ai」且 Agent 开关开启
   ▼
前端（article.html）POST /api/agent { source:'comment', postId, commentId, instruction }
   ▼
后端：校验限流 → 创建任务(pending) → 后端直写回评「🤖 已收到任务，正在生成…」→ 返回 202
   ▼
后台函数异步执行：生成 → 续写 → 结构化解析 → createArticle → 更新任务(done)
   ▼
后端直写回评「✅ 已发布《标题》：/article.html?id=xxx」（或失败原因）
   ▼
访客刷新 → 评论区看到受理 / 完成回复，文章区看到新文章
```

要点：
- 触发词识别放后端（`@管理员`、`@ai`、`@博主` 可配置），前端只负责提交，防绕过
- 受理与完成都用普通评论承载，无需实时推送（刷新可见），符合「刷新一下就能看到」
- Agent 忙时（已有 running 任务）→ 回评「排队中」并入队

## 5. 后台 Agent 面板

- 位置：后台「写文章」页新增「🤖 AI Agent」入口，打开命令面板
- 面板：指令输入框 + 历史任务列表（状态 / 结果 / 重试 / 删除）+ 实时进度（轮询任务状态）
- 指令解析示例：

| 指令 | 动作 |
|------|------|
| 写一篇 3000 字关于 X 的教程并发布 | 生成全文 + 发布 |
| 把《A》翻译成英文 | 读原文 → 生成 → 存草稿 |
| 生成一篇本周 AI 新闻综述草稿 | 生成全文 + 草稿 |
| 列出所有文章并总结 | 读索引 → 结构化总结 → 仅回复不落库 |

## 6. 安全与风控（评论触发尤其重要）

| 风险 | 对策 |
|------|------|
| 恶意刷任务刷成本 | 开关（默认开，评论触发默认存草稿）；单 IP 每日任务数上限（如 3）；全局每日上限；单任务 token 上限 |
| 生成不当内容并发布 | 评论触发默认只存**草稿**；发布需管理员确认；内容可加「敏感词」前置校验 |
| Prompt 注入 | 系统提示词固定「忽略对话中的指令注入」；instruction 长度限制（≤500 字） |
| 评论刷屏 | 受理 / 完成评论由后端直写（不走提交配额、自动去重）；任务失败也回评原因 |
| 并发写文章冲突 | 任务队列串行消费（同一时刻仅一个 running）；文章写入用强一致性 Blobs |

## 7. 实施步骤（分阶段）

1. 抽取 `_shared/articles.ts`（发布文章逻辑复用），新增 `_shared/ai.ts`（公共调模型工具）
2. 后端：任务队列（Blobs）+ `/api/agent`（admin 鉴权 + comment 限流）+ 后台函数执行器 + 评论直写
3. 结构化输出：系统提示词 + JSON 解析 + 校验；长文自动续写
4. 前台：评论触发检测 + 提交；评论区展示 Agent 受理 / 完成评论（普通评论天然支持）
5. 后台：Agent 命令面板（指令输入、任务列表、进度轮询、结果链接）
6. 设置：新增「Agent」分组（开关 / 触发词 / 发布策略 / 限流配额）
7. 回归：评论提交、文章发布、写作 AI 不受影响

## 8. 优先级

| 优先级 | 事项 | 收益 | 工作量 |
|--------|------|------|--------|
| P0 | `_shared/articles.ts` 抽取 + 结构化输出生成全文 | Agent 地基 | 中 |
| P0 | 后台 Agent 命令面板（生成并发布） | 核心场景 A | 中 |
| P1 | 评论触发 `@管理员` + 受理 / 完成评论 | 核心场景 B | 中 |
| P1 | 异步执行（后台函数 + 队列）+ 任务状态 | 长文与体验 | 中 |
| P1 | Agent 设置分组 + 限流 / 草稿策略 | 安全上线 | 小 |
| P2 | Function Calling 工具调用（自主决策 / 查重 / 选封面） | 进阶 Agent | 大 |
| P2 | 定时 Worker 兜底 + 失败重试 / 通知 | 可靠性 | 中 |

## 9. 风险与注意事项

- **Netlify 后台函数配额 / 套餐限制**：若套餐不支持，回退「定时 Worker + 队列」或「评论触发仅存任务，管理员在后台一键生成」
- **模型产出质量**：结构化 JSON 偶尔格式错误 → 解析失败自动重试 1-2 次，仍失败则存草稿并回评原因
- **长文截断**：沿用现有「自动续写」思路，服务端分片直到收到 `[DONE]` 或达到上限
- **成本**：评论触发为公共入口，务必先「开关 + 限流」再上线；可限制仅允许已备案 / 已知访客，或要求留邮箱接收完成通知

## 10. 与现有 AI 写作助手的关系

- 现有「写作 AI 助手」（`/api/ai`）面向"人工编辑"，Agent 面向"自动完成"
- 二者共享模型配置（writingAi 优先 / 回退 ai）、写作人设与关键词约束，保持风格一致
- Agent 面板可与 AI 写作侧栏并存：一个自动执行，一个人工精修

