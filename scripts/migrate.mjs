/**
 * 迁移脚本：将本地静态文件上传到线上 Netlify Blobs
 * 用法：node scripts/migrate.mjs
 *
 * 迁移内容：
 * 1. 图库图片（images/R-N-picture/）→ blog-images Blobs，标记「图库」标签
 * 2. 静态文章（posts/*.md）→ blog-articles Blobs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SITE_URL = 'https://ravennull.work'
const ADMIN_KEY = 'Raven_NULL'
const postsDir = join(__dirname, '..', 'public', 'posts')
const galleryDir = join(__dirname, '..', 'public', 'images', 'R-N-picture')

async function apiFetch(action, options = {}) {
  try {
    const res = await fetch(`${SITE_URL}/api/admin?${action}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY, ...(options.headers || {}) },
    })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { status: 'error', message: `非 JSON 响应: ${text.slice(0, 100)}` } }
  } catch (e) { return { status: 'error', message: e.message } }
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return { frontmatter: {}, content: raw }
  const fm = {}
  let curKey = ''
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('- ') && curKey) {
      if (!Array.isArray(fm[curKey])) fm[curKey] = []
      fm[curKey].push(t.slice(2).trim())
      continue
    }
    const ci = t.indexOf(':')
    if (ci > 0) {
      curKey = t.slice(0, ci).trim()
      let val = t.slice(ci + 1).trim()
      if (val.startsWith('[') && val.endsWith(']')) {
        fm[curKey] = val.slice(1, -1).split(',').map(s => s.trim())
        curKey = ''
      } else if (val) { fm[curKey] = val; curKey = '' }
    }
  }
  return { frontmatter: fm, content: m[2] }
}

async function migrateArticles() {
  console.log('\n📝 开始迁移文章...')
  const files = readdirSync(postsDir).filter(f => f.endsWith('.md') && f !== 'manifest.json')
  let ok = 0, fail = 0
  for (const file of files) {
    try {
      const raw = readFileSync(join(postsDir, file), 'utf-8')
      const { frontmatter: fm, content } = parseFrontmatter(raw)
      const id = file.replace('.md', '')
      const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      const res = await apiFetch('action=articles', {
        method: 'POST',
        body: JSON.stringify({
          id,
          title: fm.title || id,
          tags: tags.join(', '),
          author: fm.author || '渡鸦NULL',
          image: fm.image || '',
          content,
          status: 'published',
          staticFile: file,
        }),
      })
      if (res.status === 'success') { console.log(`  ✅ ${file} → ${fm.title || id}`); ok++ }
      else { console.log(`  ❌ ${file}: ${res.message}`); fail++ }
    } catch (e) { console.log(`  ❌ ${file}: ${e.message}`); fail++ }
  }
  console.log(`📝 文章完成：${ok} 成功，${fail} 失败`)
}

async function migrateGalleryImages() {
  console.log('\n🖼️  开始迁移图库图片...')
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
  const files = readdirSync(galleryDir).filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f))
  let ok = 0, fail = 0

  console.log(`  找到 ${files.length} 张图库图片`)

  for (const file of files) {
    try {
      const fullPath = join(galleryDir, file)
      const base64 = readFileSync(fullPath).toString('base64')
      const mime = mimeMap[extname(file).toLowerCase()] || 'image/jpeg'
      const res = await apiFetch('action=images', {
        method: 'POST',
        body: JSON.stringify({
          data: base64,
          mime,
          name: file,
          tags: ['图库'],
        }),
      })
      if (res.status === 'success') {
        console.log(`  ✅ ${file} → ${res.key}${res.converted ? ' (→WebP)' : ''}`)
        ok++
      } else {
        console.log(`  ❌ ${file}: ${res.message}`)
        fail++
      }
    } catch (e) {
      console.log(`  ❌ ${file}: ${e.message}`)
      fail++
    }
  }
  console.log(`🖼️  图库图片完成：${ok} 成功，${fail} 失败`)
}

async function main() {
  console.log('🚀 迁移到 Netlify Blobs')
  console.log(`   站点：${SITE_URL}`)
  const test = await apiFetch('action=login', { method: 'POST', body: JSON.stringify({ key: ADMIN_KEY }) })
  if (test.status !== 'success') { console.error('❌ 认证失败'); process.exit(1) }
  console.log('✅ 认证成功')
  await migrateArticles()
  await migrateGalleryImages()
  console.log('\n🎉 全部完成！')
  console.log('   提示：迁移完成后，可以删除 public/posts/ 和 public/images/R-N-picture/ 目录')
}

main().catch(e => { console.error('失败:', e); process.exit(1) })
