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
| 加载更多 | "加载更多"按钮（加载完显示"已加载全部"） |
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

**状态：** AI 助手部分已实施（v2.2.0）；Anime.js 动画方案已实施（v2.4.0）；首页改造方案已实施（v2.4.2，P0/P1 项）；标签区改为导航栏"全部标签"面板（v2.4.5）；Hero 重设计已实施（v2.5.0，P0/P1 项）；animejs.com 动效借鉴已实施（v2.5.2，P0/P1 项）；Hero 区重新设计已实施（v2.6.0，方案 A）；Hero 与内容区左右切换方案待评审；省去 Hero 区方案已实施（v2.6.3，方案 A）；"我的"个人仪表盘已实施（v2.6.16）；文章页阅读体验已实施（v2.6.25）；"推荐"页面设计方案已改版并入「我的」仪表盘资讯推荐模块（v2.6.43，仅保留网站资讯，以新闻卡片呈现）；「资讯每日更新」自动化方案已写入本文档（待实施，含资讯站内阅读扩展 2.1 节）
**作者：** 渡鸦NULL
