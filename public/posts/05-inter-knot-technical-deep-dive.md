---
title: 绳网论坛（InterKnot）全栈项目深度解析
date: 2026-08-10
tags:
  - 技术
  - 全栈
  - Vue
  - Nuxt
  - TypeScript
author: 渡鸦NULL
excerpt: 从零到一深度拆解一个复刻《绝区零》绳网风格的全栈论坛系统——Nuxt 4 + Netlify Functions + Netlify Blobs，涵盖前端架构、后端路由、存储层设计、AI 集成、私信系统等全部环节。
---

## 一、项目概览

**绳网论坛（InterKnot Forum）** 是一个复刻《绝区零》游戏绳网风格的全栈论坛系统，部署在 Netlify 平台上。整个项目从前端到后端全部使用 **TypeScript** 编写，没有传统的数据库和服务器，而是利用 Netlify 的 Serverless Functions + Blobs 存储实现了完整的论坛功能。

| 维度 | 技术选型 |
|------|----------|
| 前端框架 | Nuxt 4（基于 Vue 3） |
| 状态管理 | Pinia + TanStack Vue Query |
| UI 组件库 | 自研 zenless-ui（绝区零风格） |
| 后端运行时 | Netlify Functions v2（Serverless） |
| 数据存储 | Netlify Blobs（键值对 JSON 存储） |
| 图片处理 | sharp（服务端转 WebP、压缩、剥 EXIF） |
| 认证方案 | JWT（jose 库）+ bcrypt 密码哈希 |
| AI 对话 | 智谱 GLM-4-Flash API |
| 编程语言 | TypeScript（严格模式） |

源码仓库：`https://github.com/raven-null/inter-knot`

---

## 二、技术栈详解

### 2.1 前端：Nuxt 4 + Vue 3

Nuxt 4 是 Vue 生态中最成熟的全栈框架之一。本项目使用 Nuxt 4 的 **静态生成模式**（`ssr: false`，`nitro.preset: "static"`），所有页面在构建时生成为纯静态 HTML/JS/CSS，部署到 Netlify CDN 后实现毫秒级首屏加载。

**为什么选 Nuxt 而不是纯 Vite + Vue？**

- **文件路由**：`app/pages/` 目录下的 `.vue` 文件自动映射为 URL 路由，无需手动配置
- **自动导入**：`composables/`、`utils/` 中的函数自动注册，无需手动 import
- **模块生态**：`@pinia/nuxt`、`@tanstack/vue-query` 等模块开箱即用
- **Nitro 引擎**：统一的构建产物管理，支持多种部署目标

```typescript
// nuxt.config.ts 核心配置
export default defineNuxtConfig({
  srcDir: "app/",          // 前端源码目录
  ssr: false,              // 纯客户端 SPA
  nitro: { preset: "static" },
  modules: ["@pinia/nuxt"],
  compatibilityDate: "2025-07-01"
})
```

### 2.2 状态管理：Pinia + TanStack Vue Query

项目采用了**双层状态管理**架构：

**Pinia** 负责客户端全局状态（认证信息）：

```typescript
// stores/auth.ts
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: '' as string,
    user: null as Author | null,
  }),
  getters: {
    isLogin: (state) => !!state.token,
  },
  actions: {
    hydrateFromStorage() {
      // 从 localStorage 恢复 JWT
      const saved = localStorage.getItem('ik_token');
      if (saved) {
        this.token = saved;
        this.fetchSelfUser();
      }
    }
  }
})
```

**TanStack Vue Query** 负责服务端数据缓存。所有 GET 请求都通过 `cachedRead()` 封装，利用 `staleTime` 实现请求去重：

```typescript
// composables/useApi.ts
function cachedRead<T>(key: unknown[], fn: () => Promise<T>, staleTime = 60_000) {
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: fn,
    staleTime,  // 60秒内相同 key 不重复请求
  });
}
```

缓存键通过 `qk` 对象统一管理，确保 mutations 后能精确失效：

```typescript
const qk = {
  articles: (params?: unknown) => ['articles', params] as const,
  article: (id: string) => ['article', id] as const,
  comments: (postId: string) => ['comments', postId] as const,
  profile: (id: string) => ['profile', id] as const,
  me: () => ['me'] as const,
}
```

### 2.3 后端：Netlify Functions v2

后端是一个**单入口 Serverless 函数**，所有 `/api/*` 请求都通过一个 `api.ts` 文件路由：

```typescript
// netlify/functions/api.ts
export default async function handler(req: Request): Promise<Response> {
  await ensureSeed();      // 首次请求时初始化默认数据
  return await dispatch(req);  // URL 路由分发
}

export const config: Config = {
  path: "/api/*",          // 捕获所有 /api/ 请求
};
```

路由分发使用 `switch` 语句匹配 URL 路径段：

```typescript
async function dispatch(req: Request): Promise<Response> {
  const s = segments(req);
  const area = s[1] || "";

  switch (area) {
    case "auth":       return authRoutes.handle(req, s);
    case "articles":   return articleRoutes.handle(req, s);
    case "comments":   return commentRoutes.handle(req, s);
    case "dm":         return dmRoutes.handle(req, s);
    case "admin":      return adminRoutes.handle(req, s);
    // ... 共 15 个路由模块
    default:           return error(404, "接口不存在");
  }
}
```

**路由模块一览**（共 11 个）：

| 模块 | 职责 |
|------|------|
| `auth.ts` | 登录、续期、米哈游 QR 扫码绑定 |
| `articles.ts` | 帖子 CRUD、草稿、发布、搜索、浏览记录 |
| `comments.ts` | 评论 CRUD、置顶 |
| `interactions.ts` | 点赞/收藏/关注/拉黑/举报 |
| `dm.ts` | 私聊/群聊会话、消息发送/编辑/撤回 |
| `ai.ts` | AI 对话、角色卡、上下文管理 |
| `notifications.ts` | 通知列表、已读、免打扰设置 |
| `profiles.ts` | 用户资料、帖子/评论/收藏/历史列表 |
| `uploads.ts` | 文件签名上传、图片服务 |
| `admin.ts` | 后台管理全部 CRUD |
| `emotes.ts` | 表情包管理 |

### 2.4 存储层：Netlify Blobs

这是本项目最独特的设计决策——**没有使用任何传统数据库**（MySQL、PostgreSQL、MongoDB），而是将 Netlify Blobs 这个 Serverless 键值存储当作数据库使用。

**存储层核心 API**：

```typescript
// storage.ts
import { getStore } from "@netlify/blobs";

// 读取 JSON 文档
export async function getJson<T>(key: string): Promise<T | null> {
  const value = await data().get(key, { type: "json", consistency: "strong" });
  return (value ?? null) as T | null;
}

// 写入 JSON 文档
export async function setJson(key: string, value: unknown): Promise<void> {
  await data().setJSON(key, value);
}

// 仅当 key 不存在时写入（用于并发去重/锁）
export async function setJsonOnce(key: string, value: unknown): Promise<boolean> {
  const res = await data().setJSON(key, value, { onlyIfNew: true });
  return res.modified;
}

// 读取并返回 etag（用于 CAS 条件写）
export async function getJsonWithEtag<T>(key: string) {
  const res = await data().getWithMetadata(key, { type: "json" });
  return { data: res.data as T, etag: res.etag };
}

// 仅当 etag 匹配时写入（Compare-And-Swap）
export async function setJsonIfMatch(key: string, value: unknown, etag: string) {
  const res = await data().setJSON(key, value, { onlyIfMatch: etag });
  return res.modified;
}
```

**文档键命名规范**：

```
users/{id}.json                          # 用户文档
posts/{id}.json                          # 帖子文档
comments/{postId}/{commentId}.json       # 评论文档
likes/{viewer}/{targetType}/{targetId}.json  # 点赞记录
favorites/{viewer}/{postId}.json         # 收藏记录
follows/{viewer}/{target}.json           # 关注关系
_indexes/feed.json                       # 信息流索引（最新 1000 帖）
_indexes/drafts/{userId}.json            # 用户草稿索引
_indexes/deleted.json                    # 已删除帖子索引
```

**并发控制**：信息流索引的更新使用 CAS（Compare-And-Swap）+ 重试机制：

```typescript
// feed.ts
async function mutateFeed(fn: (feed: FeedIndex) => FeedIndex) {
  for (let i = 0; i < 8; i++) {
    const { data: feed, etag } = await getJsonWithEtag<FeedIndex>(KEYS.feed);
    const updated = fn(feed);
    const ok = await setJsonIfMatch(KEYS.feed, updated, etag);
    if (ok) return;  // 写入成功
    // etag 不匹配，说明有其他写入，重试
  }
  throw new Error("CAS 重试耗尽");
}
```

**ID 生成**：使用 12 字节随机数编码为 13 位 base62 字符串：

```typescript
export function genId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let out = "";
  while (value > 0n && out.length < 13) {
    out = ALPHABET[Number(value % 62n)] + out;
    value = value / 62n;
  }
  while (out.length < 13) out = "0" + out;
  return out;
}
```

---

## 三、前端架构详解

### 3.1 页面路由

项目共有 **16 个页面**，全部位于 `app/pages/` 目录：

| 路径 | 文件 | 功能 |
|------|------|------|
| `/` | `index.vue` | 首页信息流（推荐/关注/收藏） |
| `/create` | `create.vue` | 发帖编辑器 |
| `/post/:id` | `post/[id].vue` | 帖子详情页 |
| `/profile/:id` | `profile/[id].vue` | 个人主页 |
| `/level` | `level.vue` | 等级体系页 |
| `/account` | `account.vue` | 账号中心 |
| `/knock` | `knock.vue` | 私信入口页 |
| `/admin` | `admin/index.vue` | 后台数据概览 |
| `/admin/users` | `admin/users.vue` | 用户管理 |
| `/admin/posts` | `admin/posts.vue` | 帖子管理 |
| `/admin/comments` | `admin/comments.vue` | 评论管理 |
| `/admin/reports` | `admin/reports.vue` | 举报管理 |
| `/admin/categories` | `admin/categories.vue` | 版块管理 |
| `/admin/forum` | `admin/forum.vue` | 导航与功能开关 |
| `/admin/settings` | `admin/settings.vue` | 站点设置 |

### 3.2 首页信息流（index.vue）

首页是整个项目最复杂的页面（约 1587 行），实现了：

**虚拟瀑布流布局**：使用自研的 `VirtualMasonry` 组件，列宽根据视口动态计算（156-240px），只渲染可见区域的卡片，支持数千条帖子不卡顿。

**三种信息流模式**：推荐流（默认）、关注流、收藏流，通过顶部 Tab 切换。

**游标分页**：使用 IntersectionObserver 监听哨兵元素，360px 提前加载距离，1 秒冷却防抖：

```typescript
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && hasNext.value && !loading.value) {
    loading.value = true;
    setTimeout(() => { loading.value = false; }, 1000);  // 冷却
    loadMore();
  }
}, { rootMargin: '360px' });
```

**下拉刷新**：触摸手势 + 阻尼系数（0.4x），方向锁定避免与横向滚动冲突。

**后台轮询**：每 60 秒检查新帖子，每 8 秒检查已删除帖子，保持信息流实时性。

**状态缓存**：返回首页时恢复滚动位置、列表数据和已测量的卡片高度，实现"秒回"体验。

### 3.3 发帖编辑器（create.vue）

三栏布局：左侧草稿列表 | 中间 Markdown 编辑器 | 右侧设置面板

核心功能：

- **Markdown 编辑**：支持标题、粗体、斜体、链接、引用、代码、列表、分割线、图片插入
- **实时预览**：编辑/预览双模式切换
- **图片上传**：支持拖拽、文件选择，最多 9 张，自动压缩，进度追踪
- **B站视频嵌入**：解析 BV/AV 号和短链接（b23.tv），获取视频元数据
- **自动保存**：800ms 防抖，脏状态检测（JSON 快照对比）
- **草稿管理**：创建/打开/删除/切换草稿
- **匿名发布**：可选择匿名发帖

### 3.4 帖子详情页（post/[id].vue）

两栏布局：左侧封面轮播 + 正文 | 右侧评论区 + 操作栏

**Embla 轮播**：多图/视频轮播，懒加载窗口（±2 张），避免一次性加载所有图片。

**Markdown 渲染**：异步加载，使用 markdown-it + DOMPurify（XSS 防护）+ highlight.js（代码高亮）。

**评论系统**：
- 楼中楼嵌套回复
- @提及输入：`useMentionInput()` composable，textarea 中 `@Name` 显示为芯片，内部存储为 `@[Name](docId)` 格式
- 表情插入：`useEmoteInsert()` composable，基于占位符的原子插入/删除
- 图片附件：评论支持上传图片
- 评论置顶：管理员/帖子作者可置顶评论

**乐观更新**：点赞、收藏、回复等操作立即反映在 UI 上，后台异步同步。

### 3.5 个人主页（profile/[id].vue）

- **名片横幅**：背景图 + 头像 + 名字 + 等级徽章 + 绝区零角色徽章
- **统计行**：浏览量、评论数、获赞数、关注数、粉丝数（可点击弹出列表）
- **四个 Tab**：作品 / 收藏 / 历史 / 通知（后两者仅自己可见）
- **关注/拉黑**：一键切换，乐观更新计数
- **私信入口**：打开 KnockKnockModal 发起私聊
- **装备系统**：可装备自定义名片和头像

### 3.6 私信系统（KnockKnockModal.vue）

这是项目中最大的单个组件（约 4000+ 行），实现了完整的即时通讯功能：

**三种对话模式**：
- **私聊（Direct）**：一对一聊天
- **群聊（Group）**：多人聊天
- **AI 对话**：与 AI 角色"仙灵"对话

**消息类型**：文本、图片、系统通知、B站视频

**消息操作**：发送、编辑、撤回（删除）、回复

**搜索用户**：通过 UID 搜索用户发起私聊

**轮询机制**：由于 Netlify Functions 不支持 WebSocket，使用 REST + 轮询实现消息同步。

### 3.7 组合式函数（Composables）

项目共有 **33+ 个组合式函数**，以下是核心的几个：

#### useApi.ts — API 数据层（约 1800 行）

这是整个前端的数据访问中枢，封装了所有后端 API 调用：

```typescript
// 核心缓存读取
function cachedRead<T>(key: unknown[], fn: () => Promise<T>, staleTime = 60_000) {
  return queryClient.fetchQuery({ queryKey: key, queryFn: fn, staleTime });
}

// 帖子详情（2 分钟缓存）
async function getPost(id: string): Promise<Post> {
  return cachedRead(qk.article(id), async () => {
    const res = await $api.get(`/api/articles/detail`, { params: { id } });
    return res.data;
  }, 120_000);
}
```

**已读追踪**：`knownReadIds` Set 记录已读帖子 ID，跨页面持久化，避免重复请求。

#### useDmConversations.ts — 私信数据层（约 1187 行）

使用 `useState` 实现共享状态，多个组件访问同一份会话列表和消息缓存：

```typescript
const conversations = useState<DmConversationSummary[]>('dm-conversations', () => []);
const messageCache = useState<Record<string, DmMessage[]>>('dm-messages', () => ({}));
```

#### useMentionInput.ts — @提及系统（约 664 行）

这是项目中最精巧的 composable 之一，实现了 textarea 中的 @提及芯片：

- **显示字符串 vs 内部 Token**：textarea 显示 `@渡鸦NULL`，内部存储为 `@[渡鸦NULL](user_abc123)`
- **原子范围**：MentionRange 跟踪 `[start, end)` 位置，删除范围内任意字符即删除整个芯片
- **候选浮层定位**：根据 textarea 光标位置计算浮层坐标
- **键盘导航**：Enter/Tab/↑/↓/Esc 控制候选列表

#### usePresence.ts — 在线状态

```typescript
// 每 20 秒发送心跳
setInterval(() => {
  if (document.visibilityState === 'visible') {
    fetch('/api/presence/ping', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${auth.token}` },
      body: JSON.stringify({ presenceId })
    });
  }
}, 20_000);
```

标签页不可见时自动暂停，可见时立即恢复。

---

## 四、后端架构详解

### 4.1 认证系统

使用 **jose** 库实现 JWT（HS256 算法，7 天有效期）：

```typescript
// auth.ts
import { SignJWT, jwtVerify } from "jose";

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export async function resolveUser(req: Request): Promise<User | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET));
    return payload as unknown as User;
  } catch {
    return null;
  }
}
```

**米哈游 QR 扫码登录**：通过米哈游 API 生成 QR 码，轮询扫码状态，绑定游戏账号后自动生成登录密钥。

### 4.2 存储层设计

所有数据以 JSON 文档形式存储在 Netlify Blobs 中，键名遵循层级命名：

```
users/
  ├── {id}.json              # 用户基本信息
  └── by-uid/{uid}.json      # UID 到用户 ID 的映射

posts/
  └── {id}.json              # 帖子文档

comments/
  └── {postId}/
      └── {commentId}.json   # 评论文档

likes/
  └── {viewer}/
      └── {targetType}/
          └── {targetId}.json  # 点赞记录

_indexes/
  ├── feed.json              # 信息流索引（最新 1000 帖）
  ├── deleted.json           # 已删除帖子索引
  ├── drafts/{userId}.json   # 用户草稿索引
  └── emotes.json            # 表情包清单
```

### 4.3 信息流索引

信息流是论坛的核心功能。由于 Netlify Blobs 不支持复杂查询（如 SQL 的 ORDER BY + LIMIT），项目使用**索引文档**模式：

```typescript
// feed.ts
interface FeedIndex {
  ids: string[];       // 最新 1000 个帖子 ID
  updatedAt: string;   // 最后更新时间
}

// 发布帖子时更新索引
async function addToFeed(postId: string) {
  await mutateFeed((feed) => {
    const ids = [postId, ...feed.ids].slice(0, 1000);
    return { ids, updatedAt: new Date().toISOString() };
  });
}
```

**CAS 并发控制**：多个请求同时更新索引时，通过 etag 比对确保数据一致性，失败时自动重试（最多 8 次）。

### 4.4 互动系统

点赞/收藏/关注使用**存在性即状态**的设计——文档存在表示已点赞/收藏/关注，删除文档即取消：

```typescript
// interactions.ts
export async function toggleLike(req: Request) {
  const user = await requireAuth(req);
  const { targetType, targetId } = await readJson(req);
  const key = likeKey(user.id, targetType, targetId);

  const existing = await getJson(key);
  if (existing) {
    await del(key);           // 取消点赞
    await bumpLikeCount(targetType, targetId, -1);
  } else {
    await setJson(key, { at: new Date().toISOString() });  // 点赞
    await bumpLikeCount(targetType, targetId, +1);
    await pushNotification({ type: 'like', targetUserId, fromUser: user });
  }
  return json({ liked: !existing });
}
```

### 4.5 私信系统

由于 Netlify Functions 不支持 WebSocket，私信系统采用 **REST + 轮询** 方案：

**私聊会话创建**：通过两个用户的 UID 组合生成唯一会话 ID：

```typescript
// dm.ts
async function createDirectConversation(uidA: number, uidB: number) {
  const [min, max] = [Math.min(uidA, uidB), Math.max(uidA, uidB)];
  const convId = `dm-conv-${min}-${max}`;
  // 检查是否已存在
  const existing = await getJson(convIdKey(min, max));
  if (existing) return existing;
  // 创建新会话...
}
```

**消息存储**：每条消息作为独立文档存储在会话目录下，支持发送、编辑、撤回。

### 4.6 AI 对话集成

集成智谱 GLM-4-Flash 模型，实现了名为"仙灵"的 AI 角色：

```typescript
// glm.ts
const SYSTEM_PROMPT = `你是"仙灵"，绳网论坛的神秘 AI 助手。
你性格俏皮、话少、偶尔毒舌，但总能在关键时刻提供帮助。
回答要简短，1-3 句话，像朋友聊天一样自然。`;

export async function generateGlm(messages: ChatMessage[]): Promise<string> {
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GLM_KEY}` },
    body: JSON.stringify({
      model: "glm-4-flash",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}
```

**评论区 @仙灵**：在评论中 @仙灵 会触发 AI 自动回复，生成 1-3 句角色扮演风格的回复。

---

## 五、自研 UI 组件库（zenless-ui）

为了还原《绝区零》的游戏风格，项目从零构建了一套 UI 组件库，位于 `zzzui/` 目录，包含 **46 个组件**：

| 组件 | 用途 |
|------|------|
| `z-button` | 按钮（多种风格） |
| `z-input` / `z-textarea` | 输入框 |
| `z-switch` / `z-checkbox` / `z-radio` | 开关/复选/单选 |
| `z-select` / `z-option` | 下拉选择 |
| `z-modal` / `z-drawer` | 弹窗/抽屉 |
| `z-menu` / `z-dropdown` | 菜单/下拉 |
| `z-tag` / `z-badge` | 标签/徽标 |
| `z-table` / `z-pagination` | 表格/分页 |
| `z-tabs` / `z-collapse` | 标签页/折叠面板 |
| `z-slider` / `z-progress` | 滑块/进度条 |
| `z-message` | 消息提示 |
| `z-tooltip` | 工具提示 |
| `z-scrollbar` | 自定义滚动条 |
| `z-card` / `z-pattern` | 卡片/装饰图案 |

组件通过 Vite 配置全局注册：

```typescript
// nuxt.config.ts
vite: {
  resolve: {
    alias: {
      "zenless-ui": path.resolve(__dirname, "zzzui/packages"),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "${path.resolve(__dirname, "zzzui/theme/var.scss")}" as *;`,
      },
    },
  },
}
```

---

## 六、核心工具函数

### 6.1 图片处理

**客户端压缩**（`utils/upload.ts`）：上传前使用 Canvas API 压缩图片，限制 30MB。

**服务端处理**（sharp）：上传的图片在服务端转换为 WebP 格式、压缩质量、剥除 EXIF 元数据：

```typescript
// routes/uploads.ts
import sharp from "sharp";

const processed = await sharp(buffer)
  .resize({ width: 1920, height: 1080, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 80 })
  .toBuffer();
```

### 6.2 Markdown 渲染

使用 markdown-it 渲染 + isomorphic-dompurify 过滤 XSS + highlight.js 代码高亮：

```typescript
// utils/format-body.ts
import MarkdownIt from "markdown-it";
import DOMPurify from "isomorphic-dompurify";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: false,         // 禁用原始 HTML
  linkify: true,       // 自动识别链接
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(str, { language: lang }).value;
    }
    return "";
  },
});

export function renderBody(markdown: string): string {
  const raw = md.render(markdown);
  return DOMPurify.sanitize(raw);  // XSS 防护
}
```

### 6.3 等级系统

7 个等级，通过发帖、评论、获赞累积经验值升级：

```typescript
// utils/level.ts
const LEVELS = [
  { level: 1, title: "绳匠新手",    expRequired: 0 },
  { level: 2, title: "活跃绳匠",    expRequired: 30 },
  { level: 3, title: "资深绳匠",    expRequired: 100 },
  { level: 4, title: "绳网达人",    expRequired: 300 },
  { level: 5, title: "绳网精英",    expRequired: 800 },
  { level: 6, title: "绳网传奇",    expRequired: 2000 },
  { level: 7, title: "绳网传说",    expRequired: 5000 },
];

// 经验获取规则
// 每日首次发帖: +4
// 每日首次评论: +3
// 每收到一个点赞: +1
```

---

## 七、开发与部署

### 7.1 本地开发

```bash
# 安装依赖
npm install --legacy-peer-deps

# 启动完整开发环境（前端 + 后端 Functions）
netlify dev

# 仅启动前端（/api 请求无法响应）
npm run dev
```

> **重要**：本地联调必须使用 `netlify dev`，它会同时启动 Nuxt 开发服务器和 Netlify Functions 运行时。

### 7.2 环境变量

```env
JWT_SECRET=your-secret-key           # JWT 签名密钥
ADMIN_INITIAL_EMAIL=admin@example.com # 管理员邮箱
ADMIN_INITIAL_PASSWORD=admin123456    # 管理员密码
```

### 7.3 部署流程

1. 推送代码到 GitHub
2. Netlify → Import project → 选择仓库
3. 构建命令：`npm run generate`
4. 发布目录：`.output/public`
5. Functions 目录：`netlify/functions`
6. 配置环境变量
7. 首次部署自动创建管理员账号

### 7.4 测试

```bash
# 单元测试（Vitest）
npm run test:unit

# E2E 测试（Playwright）
npm run test:e2e
```

---

## 八、架构亮点总结

| 亮点 | 说明 |
|------|------|
| **零数据库** | 全部使用 Netlify Blobs 键值存储，CAS 保证并发安全 |
| **单函数入口** | 一个 Serverless 函数处理所有 API，通过 URL 路由分发 |
| **虚拟瀑布流** | 只渲染可见区域，支持数千条帖子不卡顿 |
| **乐观更新** | 点赞/收藏/关注立即反映 UI，后台异步同步 |
| **@提及芯片** | textarea 中的 @提及显示为芯片，原子范围管理 |
| **自研 UI 库** | 46 个组件还原绝区零游戏风格 |
| **AI 角色集成** | 评论区 @仙灵 触发 AI 自动回复 |
| **历史路由弹窗** | PostOverlay 和 KnockKnockModal 使用 pushState 管理弹窗历史 |
| **状态缓存** | 首页滚动位置、列表数据、卡片高度全部缓存，返回秒开 |
| **GPU 检测** | 自动检测软件渲染，禁用 CSS 动画保性能 |

---

## 九、结语

绳网论坛是一个功能完整的全栈社区系统，从前端的虚拟瀑布流、@提及输入、私信系统，到后端的 CAS 并发控制、索引文档模式、AI 集成，每个环节都有值得学习的设计。最重要的是，它证明了 **Netlify Blobs 完全可以作为小型论坛的数据库使用**，无需运维传统数据库，大幅降低了部署和维护成本。

项目使用 TypeScript 贯穿前后端，类型安全覆盖了从 API 请求到组件渲染的每一个环节，配合 TanStack Query 的缓存策略和 Pinia 的状态管理，构建了一个高效、可维护的全栈应用。
