/**
 * 项目封面自动截图
 * ------------------------------------------------------------
 * 后台「项目管理」里填一个网址，点「自动截图」就用无头 Chrome 打开它、整屏截一张、
 * 压成 800×500 的 webp 交给调用方存进图库 Blob。
 *
 * 为什么用命令行 --screenshot 而不是 CDP：
 *   scripts/build-project-covers.mjs 走 CDP 是为了「等 SPA 渲染完再截」，
 *   但那条路要一个 WebSocket 客户端，Netlify Functions 的运行环境里没有现成的 ws 依赖。
 *   --screenshot + --virtual-time-budget 已经足够等到首次渲染，且零依赖。
 *
 * 可用性：只有跑到「本地机器上的 Chrome」时才有结果。
 *   Netlify 的线上运行时没有 Chrome，findChrome() 返回 null，调用方据此提示用户手填封面。
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean) as string[]

/** 本机可用的 Chrome/Edge 路径；线上环境返回 null */
export function findChrome(): string | null {
  return CHROME_CANDIDATES.find(p => existsSync(p)) || null
}

const SHOT_WAIT_MS = Number(process.env.PROJECT_SHOT_WAIT_MS || 15000)

/**
 * 截一张站点首页。
 * @returns 800×500 的 webp buffer；本机没有 Chrome 时返回 null
 */
export async function captureProjectCover(rawUrl: string): Promise<Buffer | null> {
  const chrome = findChrome()
  if (!chrome) return null

  const url = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`
  const dir = await mkdtemp(join(tmpdir(), "project-shot-"))
  const shotPath = join(dir, "shot.png")

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--force-device-scale-factor=1",
        // 截出来的原始尺寸取大一点，缩放成卡片比例的 800×500 时不会糊
        "--window-size=1280,800",
        // 等页面自己加载完（SPA 首屏渲染也在这个窗口内）
        `--virtual-time-budget=${SHOT_WAIT_MS}`,
        `--user-data-dir=${join(dir, "profile")}`,
        `--screenshot=${shotPath}`,
        url,
      ], { stdio: "ignore" })

      // 兜底：有些页面 --virtual-time-budget 不生效，进程可能不退出
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* 已经退出 */ }
        resolve()
      }, SHOT_WAIT_MS + 15000)

      proc.on("exit", () => { clearTimeout(timer); resolve() })
      proc.on("error", err => { clearTimeout(timer); reject(err) })
    })

    if (!existsSync(shotPath)) return null

    const png = await readFile(shotPath)
    const sharp = (await import("sharp")).default
    const webp = await sharp(png)
      .resize(800, 500, { fit: "cover", position: "top" })
      .webp({ quality: 82 })
      .toBuffer()

    return Buffer.from(webp)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* 临时目录清不掉就算了 */ })
  }
}
