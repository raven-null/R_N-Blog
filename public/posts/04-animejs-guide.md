---
title: Anime.js 动画库入门与使用指南
date: 2026-08-05
update: 2026-08-05
tags:
  - 技术
  - JavaScript
  - 动画
author: AI
excerpt: 认识轻量级 JavaScript 动画引擎 Anime.js，掌握 v4 版本的安装、核心 API、时间轴、交错动画、SVG 与文本动画等使用方法
image:
---

# Anime.js 动画库入门与使用指南

## 一、什么是 Anime.js

Anime.js 是一个轻量级的 JavaScript 动画引擎，由 [Julian Garnier](https://juliangarnier.com) 开发并开源。它不依赖任何第三方库（无需 jQuery），体积小巧（压缩后约 20KB 左右），却能轻松实现 CSS 属性、变换、SVG、JS 对象属性的高性能动画。

它被广泛用于产品官网、个人主页、数据可视化等场景，是 Web 动画领域的明星库之一。截至本文写作时，Anime.js 最新稳定版本为 **v4.0.0**，同时 v3.2.2 也仍是许多项目的常用版本。

## 二、核心特性

- ✅ **轻量无依赖** - 原生 JavaScript 编写，不依赖 jQuery 等库
- ✅ **高性能** - 基于 requestAnimationFrame 驱动，动画流畅
- ✅ **简单易学** - 声明式 API，几行代码即可创建动画
- ✅ **功能强大** - 支持关键帧、时间轴、交错（stagger）、SVG 路径动画
- ✅ **控制灵活** - 可播放、暂停、反向、跳转、循环任意动画
- ✅ **TypeScript 支持** - v4 原生提供类型定义

## 三、版本说明（v4 vs v3）

Anime.js v4 对 API 进行了较大重构，两者写法不同：

| 版本 | 引入方式 | 创建动画 |
|------|----------|----------|
| **v4（推荐）** | `import { animate } from 'animejs'` | `animate(target, { x: 200 })` |
| **v3（旧）** | 全局 `anime` 对象 | `anime({ targets: '.box', translateX: 200 })` |

本文主要介绍 **v4** 的用法，v3 的代码大量出现在旧教程中，阅读时注意区分。若你使用 CDN 引入，v4 也需要通过 `anime.animate` 的方式调用。

## 四、安装方式

### 1. 通过 npm 安装（推荐）

```bash
npm install animejs
```

然后在项目中引入：

```javascript
// ES Modules
import { animate, createTimeline, stagger, utils } from 'animejs';

// CommonJS
const { animate, createTimeline, stagger } = require('animejs');
```

### 2. 通过 CDN 引入（无需构建工具）

```html
<!-- UMD 方式，浏览器全局变量 -->
<script src="https://cdn.jsdelivr.net/npm/animejs/dist/bundles/anime.umd.min.js"></script>
<script>
    const { animate, createTimeline, stagger } = anime;
</script>
```

也可以使用 ES Module 方式：

```javascript
import { animate } from 'https://esm.sh/animejs';
```

### 3. 直接下载

从 [GitHub Releases](https://github.com/juliangarnier/anime/releases) 下载压缩文件后，将 `dist/bundles/anime.umd.min.js` 放入项目并正常 `<script>` 引入即可。

## 五、快速开始

假设页面中有一个 `.box` 元素，下面是最简单的动画：

```html
<style>
    .box {
        width: 80px;
        height: 80px;
        background: #7c5cff;
        border-radius: 8px;
    }
</style>
<div class="box"></div>

<script src="https://cdn.jsdelivr.net/npm/animejs/dist/bundles/anime.umd.min.js"></script>
<script>
    const { animate } = anime;

    animate('.box', {
        x: [0, 300],          // 从 0 移动到 300（px）
        rotate: 360,          // 旋转 360 度
        scale: 1.2,           // 放大到 1.2 倍
        duration: 1000,       // 时长 1000ms
        ease: 'out(3)'        // 缓动函数
    });
</script>
```

`animate()` 接受两个参数：**目标（targets）** 和 **参数对象（parameters）**。

## 六、动画目标（Targets）

动画目标决定了"谁"被动画，支持多种写法：

```javascript
// 1. CSS 选择器（字符串）
animate('.box', { x: 100 });

// 2. DOM 元素
const el = document.querySelector('.box');
animate(el, { x: 100 });

// 3. 元素数组
animate([el1, el2, el3], { x: 100 });

// 4. 普通 JS 对象（用于驱动非 DOM 数据）
const obj = { value: 0 };
animate(obj, { value: 100, onUpdate: () => {
    console.log(obj.value);
} });
```

## 七、可动画的属性

Anime.js 可以动画几乎所有 CSS 属性和数值属性：

```javascript
animate('.box', {
    // CSS 属性（单位自动处理）
    opacity: [0, 1],
    backgroundColor: '#7c5cff',
    width: '200px',

    // CSS 变换（transform）
    translateX: 200,
    translateY: 50,
    rotate: 45,
    scale: 1.5,
    skewX: 20,

    // SVG / HTML 属性
    // 例如圆的 r、路径的 d 等
});
```

> 属性值支持数组 `[from, to]` 形式指定起止，也可直接写目标值（此时从当前值开始）。

## 八、常用参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `duration` | 动画时长（毫秒） | `duration: 1000` |
| `delay` | 动画开始前的延迟 | `delay: 300` |
| `ease` | 缓动函数 | `ease: 'out(3)'` |
| `loop` | 循环次数（`true` 为无限） | `loop: 3` |
| `alternate` | 往返播放（与 loop 配合） | `alternate: true` |
| `reversed` | 反向播放 | `reversed: true` |
| `autoplay` | 是否自动播放 | `autoplay: false` |

```javascript
animate('.box', {
    x: 200,
    duration: 800,
    delay: 200,
    ease: 'out(4)',
    loop: 3,
    alternate: true,   // 来回往返，像弹簧一样
    autoplay: false    // 手动调用 play() 启动
});
```

**缓动函数**（ease）是动画的灵魂，v4 中可以直接写：

- 内置字符串：`'linear'`、`'in(2)'`、`'out(2)'`、`'inOut(2)'` 等（括号内的数字控制力度）
- 弹簧物理：`spring({ stiffness: 200, damping: 15 })` 或 `spring({ bounce: .7 })`
- 贝塞尔曲线：`'cubicBezier(.5, .05, 1, .5)'`

## 九、关键帧动画（Keyframes）

通过给属性传**对象数组**，可以实现多阶段的关键帧动画：

```javascript
animate('.box', {
    translateX: [
        { to: 200, duration: 400, ease: 'inOut(2)' },
        { to: 400, duration: 400, ease: 'out(3)' },
        { to: 0,   duration: 400, ease: 'inOut(3)' }
    ],
    rotate: [0, 360],
    loop: true
});
```

## 十、时间轴（Timeline）

当需要**顺序执行**多个动画时，使用时间轴比回调嵌套更优雅：

```javascript
const { animate, createTimeline } = anime;

const timeline = createTimeline({ loop: true, alternate: true });

timeline
    .add('.box-1', { x: 200, duration: 600, ease: 'out(3)' })
    .add('.box-2', { x: 200, duration: 600, ease: 'out(3)' })
    .add('.box-3', { x: 200, duration: 600, ease: 'out(3)' });
```

`add()` 默认把动画追加在时间轴末尾，也可以指定偏移量控制重叠：

```javascript
timeline.add('.box-2', { x: 200 }, 100);   // 与上一个动画重叠 100ms
timeline.add('.box-3', { x: 200 }, '-=200'); // 提前 200ms
```

## 十一、交错动画（Stagger）

交错动画是"一列元素依次错开播放"的经典效果，常用于列表进入动画：

```javascript
const { animate, stagger } = anime;

animate('.item', {
    opacity: [0, 1],
    translateY: [30, 0],
    duration: 500,
    delay: stagger(80)      // 每个元素依次延迟 80ms
});
```

`stagger()` 也支持起始延迟、反向、网格布局等高级用法：

```javascript
delay: stagger(50, { from: 'center' })   // 从中间向两侧扩散
delay: stagger(50, { grid: [5, 5], axis: 'x' })  // 网格错开
```

## 十二、动画控制与回调

### 控制方法

```javascript
const animation = animate('.box', {
    x: 300,
    duration: 1000,
    autoplay: false
});

animation.play();      // 播放
animation.pause();     // 暂停
animation.reverse();   // 反向
animation.restart();   // 重头开始
animation.seek(500);   // 跳到 500ms 位置
animation.complete();  // 直接完成
animation.cancel();    // 取消并移除内联样式
```

### 回调函数

```javascript
animate('.box', {
    x: 300,
    duration: 1000,
    onBegin: (anim) => console.log('动画开始'),
    onUpdate: (anim) => console.log('进度:', anim.progress),
    onComplete: (anim) => console.log('动画完成'),
    onLoop: (anim) => console.log('完成一次循环')
});
```

## 十三、SVG 动画

Anime.js 对 SVG 支持非常出色，是它的一大亮点。

### 1. 形状变形（morphTo）

```javascript
const { animate, morphTo } = anime;

animate('.shape', {
    d: morphTo('#target-path'),   // 变形为目标路径
    duration: 1000,
    ease: 'out(3)'
});
```

### 2. 描边绘制（drawable）

```javascript
const { animate, createDrawable } = anime;

const drawable = createDrawable('.line');
animate(drawable, { draw: [0, 1], duration: 2000 });
```

### 3. 沿路径运动（motionPath）

```javascript
const { animate, createMotionPath } = anime;

const motionPath = createMotionPath('.path');
animate('.dot', {
    x: motionPath.x,
    y: motionPath.y,
    duration: 3000,
    loop: true
});
```

## 十四、文本动画（v4 新增）

v4 新增了文本分割与乱码闪烁效果，非常适合标题动效。

### 1. 文字分割（splitText）

```javascript
const { splitText, animate, stagger } = anime;

// 将标题拆分为单个字符
const split = splitText('.title', { chars: true });

animate(split.chars, {
    opacity: [0, 1],
    translateY: [40, 0],
    scale: [0.8, 1],
    duration: 600,
    delay: stagger(40)    // 逐字错开
});
```

### 2. 乱码闪烁（scrambleText）

```javascript
const { scrambleText } = anime;

scrambleText('.text', {
    text: '新的内容在这里',
    duration: 2000
});
```

## 十五、实战：在博客或页面中落地

下面是一个"页面加载时文章卡片依次入场"的完整示例，结合了 stagger 与 CSS 变量：

```html
<script src="https://cdn.jsdelivr.net/npm/animejs/dist/bundles/anime.umd.min.js"></script>
<script>
    const { animate, stagger } = anime;

    // 等 DOM 就绪后执行
    document.addEventListener('DOMContentLoaded', () => {
        animate('.card', {
            opacity: [0, 1],
            translateY: [40, 0],
            duration: 600,
            delay: stagger(60),
            ease: 'out(3)'
        });
    });
</script>
```

搭配主题切换时，还可以用它驱动 CSS 变量，让换肤也带有过渡动画：

```javascript
// 示例：让 CSS 变量在 0.8s 内过渡到新主题色
animate(':root', {
    '--bg-primary': '#1a1a2e',
    duration: 800,
    ease: 'out(2)'
});
```

## 十六、常见问题与技巧

### 1. 动画被 CSS transition 干扰？

如果元素同时有 `transition` 样式，建议在动画目标上显式去除，或使用 `animation.cancel()` 清理内联样式。

### 2. 性能优化建议

- 优先动画 `transform` 与 `opacity`（GPU 加速）
- 避免同时动画过多元素的 `width/height/top/left`（会触发重排）
- 对于大量元素，配合 `stagger` 分批错开，而非一次性动画

### 3. 页面离开时暂停动画

```javascript
animate('.box', { x: 200, loop: true });

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        animation.pause();
    } else {
        animation.play();
    }
});
```

## 十七、资源链接

- 官网：[animejs.com](https://animejs.com)
- 官方文档：[animejs.com/documentation](https://animejs.com/documentation)
- 缓动函数编辑器：[animejs.com/easing-editor](https://animejs.com/easing-editor)
- GitHub 仓库：[github.com/juliangarnier/anime](https://github.com/juliangarnier/anime)
- 官方示例（CodePen）：[codepen.io/collection/Poerqa](https://codepen.io/collection/Poerqa)

## 总结

Anime.js 以极低的入门门槛和强大的功能，成为纯前端动画的首选库之一。掌握本文的 `animate`、`stagger`、`createTimeline`、`spring` 等核心 API，配合官方文档与缓动编辑器，你就可以为你的网站打造出专业、流畅的动效。快去试试吧！
