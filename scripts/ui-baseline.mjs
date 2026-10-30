#!/usr/bin/env node
/**
 * 全站视觉回归基线（防 UI 错乱的守门员）
 * ------------------------------------------------------------
 * 为什么需要：这套站有 1000+ 处 !important、6 套样式入口、4 个写颜色的模块，
 * 任何一次改样式都可能让别的页面错位/重叠/溢出。这个脚本把「改之前长什么样」
 * 固化成 PNG，改完一跑就知道哪里动了。
 *
 * 用法：
 *   node scripts/ui-baseline.mjs --update          # 生成/更新基线
 *   node scripts/ui-baseline.mjs                   # 与基线对比，有超阈值差异则退出码 1
 *   node scripts/ui-baseline.mjs --only=index      # 只跑某几个页面（逗号分隔）
 *   node scripts/ui-baseline.mjs --quick           # 只跑 1440 宽 + 浅色 + 一个时段
 *   UI_DIFF_THRESHOLD=0.002 node scripts/ui-baseline.mjs   # 自定义差异阈值（默认 0.5%）
 *
 * 组成：
 *   1. 内置静态服务器（public/ → 127.0.0.1:8788，/api/* 返回 501，让页面走失败态而不是卡死）
 *   2. 无头 Chrome + CDP（复用 scripts/build-project-covers.mjs 的做法）
 *   3. 组合 = 页面 × 主题（浅/深）× 时段（8/18/23）× 宽度（1440/390）
 *   4. 布局自检：横向溢出、NaN 尺寸、元素越界
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve('public')
const SHOT_DIR = path.resolve('.local-data/ui-shots')
const BASE_DIR = path.join(SHOT_DIR, 'baseline')
const CUR_DIR = path.join(SHOT_DIR, 'current')
const DIFF_DIR = path.join(SHOT_DIR, 'diff')
const PROFILE_DIR = path.resolve('.local-data/ui-shots/chrome-profile')

const PORT = Number(process.env.UI_HTTP_PORT || 8788)
const CDP_PORT = Number(process.env.UI_CDP_PORT || 9444)
const WAIT_MS = Number(process.env.UI_WAIT_MS || 1200)
const THRESHOLD = Number(process.env.UI_DIFF_THRESHOLD || 0.005) // 0.5% 像素差

/**
 * 页面清单。
 * times：该页支持 ?hour= 预览的时段（带 daylight.js 的页面才有意义）
 * 后台/工具页没有天色概念，只跑两种主题。
 */
const PAGES = [
  { name: 'index', file: 'index.html', times: [8, 18, 23] },
  { name: 'admin', file: 'admin.html', times: [null] },
  { name: 'admin-edit', file: 'admin-edit.html', times: [null] },
  { name: 'mindmap', file: 'mindmap.html', times: [null] },
  { name: 'graph', file: 'graph.html', times: [null] },
  { name: 'excalidraw', file: 'excalidraw.html', times: [null] },
]

const THEMES = ['light', 'dark']
const WIDTHS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const args = new Set(process.argv.slice(2))
const UPDATE = args.has('--update')
const QUICK = args.has('--quick')
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice('--only='.length)
  .split(',').map(s => s.trim()).filter(Boolean)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- 静态服务器
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
}

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    let pathname = decodeURIComponent(url.pathname)

    // 后端接口一律 501，页面走「功能暂不可用」分支，保证截图稳定
    if (pathname.startsWith('/api/')) {
      res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'ui-baseline: api disabled' }))
      return
    }

    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = path.join(ROOT, pathname.replace(/^\/+/, ''))
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return }

    try {
      const buf = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      res.end(buf)
    } catch {
      // 无扩展名路由（/excalidraw）退回同名 html
      try {
        const buf = await readFile(`${file}.html`)
        res.writeHead(200, { 'content-type': MIME['.html'] })
        res.end(buf)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

// ---------------------------------------------------------------- Chrome + CDP
const chrome = CHROME_CANDIDATES.find(p => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome/Edge，请用 CHROME_PATH 指定可执行文件')
  process.exit(1)
}

async function startChrome(width, height) {
  await mkdir(PROFILE_DIR, { recursive: true })
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-lcd-text',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    'about:blank',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return { proc, wsUrl: page.webSocketDebuggerUrl }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  proc.kill()
  throw new Error('Chrome 调试端口未就绪')
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method) {
      events.push(msg.method)
    }
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    const timer = setTimeout(() => { pending.delete(msgId); reject(new Error(`${method} 超时`)) }, 60000)
    pending.set(msgId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

  return { send, events, close: () => ws.close() }
}

// ---------------------------------------------------------------- 布局自检
/** 在页面里跑：横向溢出 / NaN 尺寸 / 关键元素越界 */
const AUDIT_JS = `(() => {
  const issues = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) {
    issues.push('横向溢出 ' + (de.scrollWidth - de.clientWidth) + 'px');
  }
  const bad = [];
  document.querySelectorAll('[style]').forEach(el => {
    if (/NaN|undefinedpx/.test(el.getAttribute('style') || '')) bad.push(el.tagName.toLowerCase());
  });
  if (bad.length) issues.push('非法尺寸: ' + [...new Set(bad)].slice(0, 5).join(','));
  // 关键容器不能是 0 高度（说明没渲染出来）
  ['.top-bar', '.content-wrapper', '.scroll-area', 'main'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().height < 4) issues.push(sel + ' 高度为 0');
  });
  return issues;
})()`

// ---------------------------------------------------------------- 主流程
const pages = PAGES.filter(p => !only.length || only.includes(p.name))
if (!pages.length) {
  console.error(`没有匹配的页面：${only.join(',')}`)
  process.exit(1)
}

await mkdir(SHOT_DIR, { recursive: true })
await mkdir(UPDATE ? BASE_DIR : CUR_DIR, { recursive: true })
if (!UPDATE) await mkdir(DIFF_DIR, { recursive: true })

const server = await startServer()
const { proc, wsUrl } = await startChrome(1440, 900)
const cdp = await connect(wsUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

const themeList = QUICK ? ['light'] : THEMES
const widthList = QUICK ? WIDTHS.filter(w => w.label === 'desktop') : WIDTHS

const results = []
let shotCount = 0

for (const page of pages) {
  const times = QUICK && page.times.length > 1 ? [page.times[1]] : page.times
  for (const theme of themeList) {
    for (const hour of times) {
      for (const vp of widthList) {
        const variant = [page.name, theme, hour === null ? 'now' : `h${hour}`, vp.label].join('-')
        const file = path.join(UPDATE ? BASE_DIR : CUR_DIR, `${variant}.png`)

        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.label === 'mobile',
        })

        // 主题与屏保都从 localStorage 预置，必须在页面脚本执行前注入
        const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `try{
            localStorage.setItem('blog-theme-mode','${theme}');
            localStorage.setItem('blog-theme','${theme === 'dark' ? 'night' : 'paper'}');
            localStorage.setItem('ui-idle-screen','0');
            sessionStorage.clear();
          }catch(e){}`,
        })

        const query = hour === null ? '' : `?hour=${hour}`
        const url = `http://127.0.0.1:${PORT}/${page.file}${query}`
        cdp.events.length = 0
        await cdp.send('Page.navigate', { url })
        for (let i = 0; i < 60; i++) {
          if (cdp.events.includes('Page.loadEventFired')) break
          await sleep(200)
        }
        await sleep(WAIT_MS)

        let issues = []
        try {
          const audit = await cdp.send('Runtime.evaluate', { expression: AUDIT_JS, returnByValue: true })
          issues = audit?.result?.value || []
        } catch { /* 忽略 */ }

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const buf = Buffer.from(shot.data, 'base64')
        await writeFile(file, buf)
        shotCount++

        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier }).catch(() => {})
        results.push({ variant, file, issues })
        const flag = issues.length ? `  ⚠ ${issues.join(' / ')}` : ''
        console.log(`${UPDATE ? '📷' : '🔍'} ${variant}${flag}`)
      }
    }
  }
}

cdp.close()
proc.kill()
server.close()

// ---------------------------------------------------------------- 对比
if (UPDATE) {
  console.log(`\n基线已生成：${shotCount} 张 → ${path.relative(process.cwd(), BASE_DIR)}`)
} else {
  const failures = []
  for (const r of results) {
    const basePath = path.join(BASE_DIR, `${r.variant}.png`)
    if (!existsSync(basePath)) {
      failures.push({ variant: r.variant, reason: '基线缺失（先跑 --update）' })
      continue
    }
    const [a, b] = await Promise.all([readFile(basePath), readFile(r.file)])
    const [ia, ib] = await Promise.all([
      sharp(a).raw().toBuffer({ resolveWithObject: true }),
      sharp(b).raw().toBuffer({ resolveWithObject: true }),
    ])
    if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height) {
      failures.push({ variant: r.variant, reason: `尺寸变化 ${ia.info.width}×${ia.info.height} → ${ib.info.width}×${ib.info.height}` })
      continue
    }
    let changed = 0
    const total = ia.info.width * ia.info.height
    for (let i = 0; i < ia.data.length; i += ia.info.channels) {
      if (Math.abs(ia.data[i] - ib.data[i]) > 8
        || Math.abs(ia.data[i + 1] - ib.data[i + 1]) > 8
        || Math.abs(ia.data[i + 2] - ib.data[i + 2]) > 8) changed++
    }
    const ratio = changed / total
    if (ratio > THRESHOLD) {
      await sharp(b).composite([{ input: a, blend: 'difference' }]).png()
        .toFile(path.join(DIFF_DIR, `${r.variant}.png`)).catch(() => {})
      failures.push({ variant: r.variant, reason: `像素差 ${(ratio * 100).toFixed(2)}%` })
    }
  }

  const layoutIssues = results.filter(r => r.issues.length)
  for (const r of layoutIssues) {
    failures.push({ variant: r.variant, reason: `布局自检：${r.issues.join(' / ')}` })
  }

  if (!failures.length) {
    console.log(`\n✓ 全部通过：${shotCount} 张截图与基线一致（阈值 ${(THRESHOLD * 100).toFixed(2)}%），无布局异常`)
  } else {
    console.error(`\n✗ ${failures.length} 处差异：`)
    for (const f of failures) console.error(`  · ${f.variant} → ${f.reason}`)
    console.error(`\n对比图（若有）：${path.relative(process.cwd(), DIFF_DIR)}`)
    console.error('确认是新预期就重跑 --update 更新基线。')
    process.exitCode = 1
  }
}
