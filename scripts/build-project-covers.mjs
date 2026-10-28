#!/usr/bin/env node
/**
 * 为「项目」页的已上线站点批量生成封面截图
 *
 * 用法：
 *   node scripts/build-project-covers.mjs                 # 全部截图
 *   node scripts/build-project-covers.mjs --only=gallery  # 只截某个（逗号分隔可多选）
 *   COVER_WAIT_MS=6000 node scripts/build-project-covers.mjs
 *
 * 做法：
 *   1. 起一个无头 Chrome（远程调试端口），用 CDP 依次打开每个站点
 *   2. 等 load 事件 + 额外真实等待（SPA 首屏渲染需要时间），再整屏截图
 *   3. sharp 压成 800×500 webp 存进 public/images/projects/
 *
 * 截图是静态文件，随仓库提交；站点改版后重跑一次即可。Chrome 路径可用 CHROME_PATH 指定。
 */
import { spawn } from 'node:child_process'
import { mkdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

// 与 js/app.js 里 deployedProjects 的 slug 保持一致
const SITES = [
  { slug: 'gallery', url: 'https://r-gallery.netlify.app/' },
  { slug: 'database', url: 'https://r-database.netlify.app/' },
  { slug: 'interknot', url: 'https://interknot.netlify.app/' },
  { slug: 'world', url: 'https://ravennull.monster/' },
]

const OUT_DIR = path.resolve('public/images/projects')
const TMP_DIR = path.resolve('.local-data/project-covers')
const PROFILE_DIR = path.join(TMP_DIR, 'chrome-profile')
const WIDTH = 800
const HEIGHT = 500
const PORT = Number(process.env.COVER_CDP_PORT || 9333)
// load 之后额外等待的毫秒数（给 SPA 渲染数据用）
const WAIT_MS = Number(process.env.COVER_WAIT_MS || 5000)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const chrome = CHROME_CANDIDATES.find(p => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome/Edge，请用 CHROME_PATH 环境变量指定浏览器可执行文件')
  process.exit(1)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 起无头 Chrome，返回进程与 CDP 页面地址 */
async function startChrome() {
  await mkdir(PROFILE_DIR, { recursive: true })
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return { proc, wsUrl: page.webSocketDebuggerUrl }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  proc.kill()
  throw new Error('Chrome 远程调试端口未就绪')
}

/** 极简 CDP 客户端 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
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
    const timer = setTimeout(() => {
      pending.delete(msgId)
      reject(new Error(`${method} 超时`))
    }, 60000)
    pending.set(msgId, msg => { clearTimeout(timer); resolve(msg) })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

  return { send, events, close: () => ws.close() }
}

const only = process.argv
  .find(a => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const targets = SITES.filter(s => !only?.length || only.includes(s.slug))
if (!targets.length) {
  console.error(`没有匹配的站点：${only?.join(',')}`)
  process.exit(1)
}

await mkdir(OUT_DIR, { recursive: true })
await mkdir(TMP_DIR, { recursive: true })

console.log(`浏览器：${chrome}`)
console.log(`输出：${path.relative(process.cwd(), OUT_DIR)}（${WIDTH}×${HEIGHT} webp，加载后等待 ${WAIT_MS}ms）\n`)

const { proc, wsUrl } = await startChrome()
const cdp = await connect(wsUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

let ok = 0
for (const site of targets) {
  const out = path.join(OUT_DIR, `${site.slug}.webp`)
  try {
    cdp.events.length = 0
    await cdp.send('Page.navigate', { url: site.url })
    // 等 load（最多 20s），失败也继续尝试截图
    for (let i = 0; i < 80; i++) {
      if (cdp.events.includes('Page.loadEventFired')) break
      await sleep(250)
    }
    await sleep(WAIT_MS)

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const buf = Buffer.from(shot.result.data, 'base64')

    await sharp(buf)
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'top' })
      .webp({ quality: 78 })
      .toFile(out)

    const info = await stat(out)
    console.log(`✓ ${site.slug.padEnd(10)} → ${path.relative(process.cwd(), out)}（${Math.round(info.size / 1024)} KB）`)
    ok++
  } catch (err) {
    console.error(`✗ ${site.slug.padEnd(10)} 失败：${String(err?.message || err).split('\n')[0]}`)
  }
}

cdp.close()
proc.kill()
await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {})

console.log(`\n完成：${ok}/${targets.length}`)
if (ok !== targets.length) process.exitCode = 1
