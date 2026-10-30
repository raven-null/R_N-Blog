# 全站 UI 重写方案（v1.0）

> 目标：在不破坏现有功能的前提下，重建全站视觉与交互底座，并实现三项新能力——
> ① 背景随时间变化；② 主题色随背景派生；③ 鼠标闲置后背景推向面前（屏保）。
> 同时把图库换成 private-gallery 的成熟照片墙实现。
>
> **最高优先级约束：任何阶段都不允许出现 UI 错乱（错位 / 重叠 / 溢出 / 闪烁 / 层级颠倒）。**

---

## 0. 决策记录（2026-10-31 确认）

| 项 | 决定 |
|---|---|
| 视觉方向 | 延续现在的**日光纸白 + 插画 + 毛玻璃 + 暖金强调色** |
| 背景素材 | 采用 [KumengScreen](https://github.com/buger404/KumengScreen)（枯梦）的昼夜光照方案；**本地暂无源码，见 §8 待办** |
| 屏保表现 | 闲置后背景缓缓推近、内容虚化淡出（不改层级、不改布局） |
| 范围 | **全部页面**：index / article / admin / admin-edit / excalidraw / mindmap / graph / preview / styleguide |

---

## 1. 现状诊断（为什么现在容易错乱）

量化的病灶，都是实测值：

| 指标 | 现状 | 后果 |
|---|---|---|
| `!important` 总数 | ≈ **1245 处**（style 603 / renewal 242 / editor-write 166 / sky 86 / glass 67 / scrollbar 32 / admin-skin 16 / forms 13 / mobile 11 / tokens 9） | 样式先后顺序决定成败，新规则永远在赌"谁排在后面" |
| `@layer` | **0 处** | 没有层级契约 |
| `backdrop-filter` 规则 | ≈ **250 处** | 大面积重绘，动画时掉帧；模糊层叠加还会造成内容"糊成一片" |
| 样式入口 | **6 套**（index 用 bundle.css；article 用 style+glass+sky…；admin 不含 style.css，靠 renewal.css 兜底；工具页另一套） | 同一组件在不同页面长得不一样 |
| 颜色写入方 | **4 个**：`theme.js` 内联 `style.setProperty` / `tokens.css` 令牌 / `sky.css` 按时段 `!important` 覆盖 / `tone.js` 再覆盖文字色 | 改一处、崩一处 |

历史证据：更新日志里"重叠 / 溢出 / 挤压 / 遮挡 / 错位"类修复反复出现（如 v3.50.0 的目录重叠、瀑布流排列错乱回退等），本质都是上述冲突的症状。

---

## 2. 目标架构

### 2.1 颜色的唯一真相

**`js/atmosphere.js` 只允许写 5 个数值变量 + 3 个 data 属性**，其余颜色全部由 CSS 计算：

```css
:root {
  --sky-top: …; --sky-mid: …; --sky-bottom: …; --sky-glow: …;
  --sunlight: 0.62;          /* 0=夜 1=正午，光照强度 */
}
html[data-period="dusk"] { --_period-hue: 28deg; }   /* 时段只给"色相提示" */
```

派生关系（全部在 `tokens.css` 里，用 `color-mix()` / `oklch()` 完成）：

```css
--accent:          oklch(from var(--_period-hue) 0.72 0.16 h);   /* 时段同色相、提饱和 */
--surface:         color-mix(in srgb, var(--sky-bottom) 6%, #fffefb);
--bg:              color-mix(in srgb, var(--sky-bottom) 10%, #fbf8f1);
--text:            /* 由 data-tone 决定，light→#16130f / dark→#f7f3ea */
```

**删除**：`theme.js` 里的 `applyColors()` 内联写变量、`sky.css` 里按时段覆盖 `--accent` 的 86 个 `!important`。
**保留**：手动三档（跟随天色 / 固定浅 / 固定深），仍由 `experience.js` 的下拉控制，只写 `data-theme`。

### 2.2 CSS 分层（`@layer`）

```css
@layer reset, tokens, base, layout, components, pages, utilities;
```

- 每个文件首行声明自己属于哪一层；
- 层内选择器只作用于自己的范围：页面样式一律挂 `[data-page="article"]` 这样的前缀；
- **新代码 0 个 `!important`**；存量按页分批清理，清理即验收。

### 2.3 构建产物

`scripts/build-css.mjs` 升级为多产物：

| 产物 | 内容 | 引用页 |
|---|---|---|
| `home.css` | reset+tokens+base+layout+components+首页 | index |
| `article.css` | 同上 + 阅读器/目录/留言 | article |
| `admin.css` | 同上 + 后台壳/表单/登录 | admin、admin-edit |
| `tool.css` | 同上 + 画布外壳 | excalidraw / mindmap / graph / preview / styleguide |

每页只引一个文件，层顺序写在文件开头，杜绝"这套样式在哪页生效"的问题。文件名带内容哈希（现有机制保留）。

### 2.4 JS 边界

| 模块 | 允许做 | 禁止做 |
|---|---|---|
| `atmosphere.js`（新，合并 daylight+tone） | 写 5 个数值变量、`data-period/tone/idle` | 写任何颜色变量 |
| `theme.js` | 写 `data-theme / data-accent / data-density` | 内联写颜色 |
| `tone.js` | 删除（合并进 atmosphere） | —— |
| 页面脚本 | 操作自己的 DOM | 改 `documentElement.style` 的颜色 |

---

## 3. 三项核心功能

### 3.1 气氛引擎（背景随时间）

- 保留现有 24 小时关键帧表（`SKY`），扩展为 **三层渲染**：
  1. **底色层**：`--sky-top/mid/bottom` 三段渐变（现状升级）；
  2. **插画层**：KumengScreen 的图（或本项目 `images/sky/`），按 `--sunlight` 调亮暗/染色；
  3. **光照层**：日/月位置（现有 `--sun-x/--sun-y`）+ 斜射光晕 + 夜间星点（`--star-opacity`）。
- 刷新周期 30s（隐藏页面跳过）；**过渡时长 1.8s → 8s**，跨时段才不突兀。
- `?hour=18.5` 预览参数保留，方便验收任意时刻。

### 3.2 主题色随背景派生

```
背景 top/bottom → 平均色相 h、明度 L
  accent  = oklch(from h, 0.72 0.16)         # 同色相提饱和，永远"属于当前天空"
  surface = color-mix(背景, 纸白 6~10%)
  tone    = JS 算相对亮度 → data-tone=light|dark（阈值 0.42，带回滞防抖）
```

关键点：**同色相**而不是随便取色，背景变橙主题就橙、变蓝主题就蓝，但仍受明度/对比度约束，不会出现"灰底黄字"。

### 3.3 屏保（Idle Depth）

**原则：只动 transform / opacity / filter，不动 z-index、不动布局流、不改 DOM 结构。**

```css
html[data-idle] .sky { transform: scale(calc(1 + .18 * var(--idle))); }
html[data-idle] .content-wrapper {
  opacity: calc(1 - .8 * var(--idle));
  transform: scale(calc(1 - .04 * var(--idle)));
  filter: blur(calc(6px * var(--idle)));
  will-change: opacity, transform, filter;
}
```

- 闲置 **45s** 触发，`--idle` 用 rAF 在 **12s** 内 0→1（ease-in-out）；
- 唤醒事件：`pointermove / pointerdown / keydown / wheel / touchstart / scroll / visibilitychange`，**0.8s** 复原；
- 推进期间加 `html[data-idle]` → 卡片把 `backdrop-filter` 切为同色实底（**必须**，250 处模糊同时重算会卡）；
- `prefers-reduced-motion: reduce` → 不播放，仅静态背景；
- 用户可关闭（`localStorage["ui-idle-screen"] = "0"`），设置里给开关。

---

## 4. 图库照片墙换装

**结论：整体换装 private-gallery v1.11 版，不打补丁。**
（现 `gallery-wall.js` 611 行是同一思路的简版，缺稳定 key、放大记忆、块末齐平、比例回填防抖、块级平铺。）

从 `E:\01-private-gallery` 移植的要点：

| 项 | 做法 |
|---|---|
| DOM | `wallPage(fixed) > wallViewport(overflow:hidden) > wallPlane(transform)`，tile 用 `left/top/width/height` 定位（保留 CSS 过渡做"挤开"动画） |
| 方格 | `cols=clamp(round(sqrt(n*1.6)),4,20)`，`filled` 占用表防重叠，大图 = 每 8 张 1 个 + 随机起点（`wallGridSeed`） |
| 瀑布流 | 最短列算法；2 列大图"原地变大"；**块末必须齐平**（三阶段补位），否则块交界出现横贯全宽的缝 |
| 虚拟化 | 世界坐标 = 块坐标 × 块尺寸，双层剪枝，`wallTiles` Map 按 `块,块,稳定key` 增删 |
| 稳定 key | 用照片 `id` 而非下标，放大时同一 DOM 只挪位置不换图 |
| 交互 | 拖拽 + 惯性(0.94/帧) + 滚轮锚点缩放 `x' = px-(px-x)*k` + 捏合 + 单击放大(延迟 260ms 防与双击冲突) + 双击灯箱 |
| 图片 | 缩略图带 `?w=320/480`，`object-fit:cover` 永不拉伸；`naturalWidth/Height` 回填真实比例，220ms 防抖重排 |
| 调试钩子 | `__wallCoverage` / `__wallGridStats` / `__wallAspectInfo` 一并搬过来，验收靠它们 |

数据要求（每张照片）：`id / url / thumbUrl / width / height`。

---

## 5. 防错乱纪律（硬性）

1. **不许用 `!important` 解决问题** —— 宁可加层、加 `[data-page]` 前缀。存量 `!important` 只减不增。
2. **一个阶段一个 commit**，旧 CSS 文件在 P6 之前**不删**，随时可回滚。
3. **每阶段结束跑视觉回归**（`scripts/ui-baseline.mjs`）：
   - 页面 × 主题（浅/深）× 时段（8:00 / 18:00 / 23:00）× 宽度（1440 / 1024 / 390）
   - 约 126 张截图，与基线比对，差异超阈值即失败。
4. **布局自检断言**（脚本内）：无横向溢出、无元素重叠（关键区域抽样）、`scrollWidth <= clientWidth`、无 `NaNpx`。
5. 屏保/背景层改动后必须验证：滚轮、弹窗、下拉、灯箱、移动端抽屉全部正常。
6. 任何"临时覆盖"必须先写进本文档并标注到期版本，不许散落在 CSS 里。

---

## 6. 阶段计划

| 阶段 | 内容 | 估时 | 验收 |
|---|---|---|---|
| **P0** | 基座：`@layer` 契约、tokens 单一来源、多产物构建、视觉回归脚本 + 基线 | 0.5d | 全站视觉零变化，基线 126 张通过 |
| **P1** | 气氛引擎：`atmosphere.js`（时间背景 + 派生主题 + 屏保）+ 清理 theme/tone 的写色逻辑 | 1d | 三时段自动换色、屏保可开关、无掉帧 |
| **P2** | 首页重写（index.html + home.css） | 1.5d | 卡片流 / 轮播 / 日历 / 简报 / 桌宠 全部正常 |
| **P3** | 文章页（article.html + 阅读工具条 + 目录） | 1.5d | 分章加载、目录高亮、留言、灯箱正常 |
| **P4** | 图库照片墙换装 | 1d | 两排布切换、放大、灯箱、触摸全通 |
| **P5** | 后台与画布工具页（只换皮，不动业务逻辑） | 2d | 登录、写作、发布、三种画布嵌入正常 |
| **P6** | 清账：删旧 CSS、清 `!important`、更新 README/项目文档 | 0.5d | 无引用残留、构建通过、`pnpm typecheck` 绿 |

---

## 7. 风险与回滚

| 风险 | 影响 | 对策 |
|---|---|---|
| 清理 `!important` 暴露历史补丁 | 某页局部错位 | 按页清理，每页跑回归；P6 之前旧文件都在 |
| `backdrop-filter` + 屏保动画 | 掉帧、发烫 | idle 期间切实底；`will-change` 只给需要的层 |
| 主题派生导致对比度不足 | 字看不清 | 派生后强制做 WCAG 对比度校正，低于 4.5:1 自动提亮/压暗 |
| 后台 6000+ 行 JS 内联样式 | 改皮带动逻辑 | P5 只替换 CSS，不动 `admin-app.js` 结构 |
| KumengScreen 拿不到 | 背景素材缺失 | 先用现有 `kumeng-*.webp` + 自研光照，接口留好，素材到位直接换 |

回滚：`git revert <阶段 commit>`，或 `git checkout <阶段前 tag> -- public/css public/js`。

---

## 8. 待办 / 阻塞项

- [ ] **KumengScreen 源码**：当前环境无法访问 GitHub（TLS 握手失败），本地也没有该仓库。
      需要：clone 到 `E:\00-GitHub项目\KumengScreen`（或任意本地路径后告知），我读了它的光照/背景实现再接。
      在此之前 P1 用 `daylight.js` 现有算法演进（注释里说明本就移植自该项目思路）。
- [ ] 是否保留 `styleguide.html`（样式演示页，可用于 P0 验收）。
- [ ] 后台是否也要"随天色变"，还是固定浅色（编辑区常亮更稳）。

---

**维护者**：渡鸦NULL ｜ **状态**：方案已确认，P0 进行中
