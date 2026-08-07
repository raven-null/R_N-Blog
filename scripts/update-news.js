/**
 * 资讯推荐自动更新脚本（方案一：GitHub Actions 每日定时）
 * 用法：
 *   node scripts/update-news.js            # 抓取 RSS 生成 data/recommendations.json
 *   node scripts/update-news.js --dry      # 只抓取不落盘，打印生成结果
 *
 * 职责：抓取各来源 RSS → 解析/映射分类 → 提取正文转 Markdown → 合并去重 → 落盘自检
 * 依赖：仅 Node 内置模块（https / fs / path），零 npm 依赖
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA_FILE = path.join(__dirname, '..', 'data', 'recommendations.json');
const MAX_ITEMS = 12;
const MIN_CONTENT_LEN = 200; // 正文少于该字数视为"摘要型"，省略 content
const SUMMARY_LEN = 60;      // 摘要截断字数

// 来源配置：name → { url, category }
const SOURCES = [
    { name: '36氪', url: 'https://36kr.com/feed', category: '科技' },
    { name: '量子位', url: 'https://www.qbitai.com/feed', category: 'AI' },
    { name: '少数派', url: 'https://sspai.com/feed', category: '产品' },
    { name: '虎嗅', url: 'https://www.huxiu.com/rss/0.xml', category: '科技' },
    { name: '阮一峰的网络日志', url: 'https://www.ruanyifeng.com/blog/atom.xml', category: '互联网' },
    { name: 'CSS-Tricks', url: 'https://css-tricks.com/feed/', category: '前端' },
    { name: 'GitHub Blog', url: 'https://github.blog/feed/', category: '开发' }
];

// ---------- 基础工具 ----------

function fetchText(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (R_N-Blog news bot)' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const loc = res.headers.location;
                const next = /^https?:\/\//.test(loc) ? loc : new URL(loc, url).toString();
                fetchText(next, timeout).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

function unescapeHtml(s) {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<!\[CDATA\[/g, '')
        .replace(/\]\]>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–');
}

function stripTags(s) {
    return s.replace(/<[^>]+>/g, '');
}

// HTML 正文 → 简易 Markdown（段落/标题/列表/链接/图片/代码块/加粗斜体）
function htmlToMarkdown(html) {
    let s = unescapeHtml(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n\n');
    s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(n) + ' ');
    s = s.replace(/<\/h[1-6]>/gi, '\n\n');
    s = s.replace(/<li[^>]*>/gi, '\n- ');
    s = s.replace(/<\/li>/gi, '');
    s = s.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi, (m, code) => '\n\n```\n' + stripTags(code).trim() + '\n```\n\n');
    s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (m, src, alt) => `![${alt || '图片'}](${src})`);
    s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (m, alt, src) => `![${alt || '图片'}](${src})`);
    s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
        const t = stripTags(text).trim();
        return t ? `[${t}](${href})` : href;
    });
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/\n[ \t]+/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

// 解析 RSS / Atom XML，返回条目数组
function parseXml(xml) {
    const items = [];
    // RSS 2.0 <item> 与 Atom <entry>
    const itemRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const pick = (tag) => {
            const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
            const mm = block.match(r);
            return mm ? unescapeHtml(mm[1]).trim() : '';
        };
        // Atom 用 <link href="...">，RSS 用 <link>text</link>
        let link = '';
        const hrefRe = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
        if (hrefRe) link = hrefRe[1];
        else link = pick('link');
        const title = pick('title');
        const desc = pick('description') || pick('content:encoded') || pick('summary');
        let date = pick('pubDate') || pick('published') || pick('dc:date') || pick('updated') || pick('date');
        if (!title || !link) continue;
        items.push({ title, link, desc, date });
    }
    return items;
}

function formatDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

// ---------- 主流程 ----------

function makeSummary(desc) {
    const text = stripTags(unescapeHtml(desc)).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > SUMMARY_LEN ? text.slice(0, SUMMARY_LEN) + '…' : text;
}

function makeContent(desc) {
    const md = htmlToMarkdown(desc);
    const plainLen = stripTags(desc).replace(/\s+/g, '').length;
    if (!md || plainLen < MIN_CONTENT_LEN) return ''; // 摘要型来源，省略 content
    return md;
}

async function main() {
    const dry = process.argv.includes('--dry');

    // 读取已有数据（保留 id 与人工条目）
    let existing = [];
    if (fs.existsSync(DATA_FILE)) {
        try {
            existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (!Array.isArray(existing)) existing = [];
        } catch (e) {
            existing = [];
        }
    }

    // 并发抓取所有来源
    const results = await Promise.all(SOURCES.map(async src => {
        try {
            const xml = await fetchText(src.url);
            const entries = parseXml(xml).slice(0, 5);
            return { src, entries };
        } catch (e) {
            console.warn(`⚠ ${src.name} 抓取失败：${e.message}`);
            return { src, entries: [] };
        }
    }));

    const now = new Date();
    const fresh = [];
    for (const { src, entries } of results) {
        for (const e of entries) {
            const summary = makeSummary(e.desc);
            const content = makeContent(e.desc);
            const item = {
                title: e.title,
                url: e.link,
                source: src.name,
                category: src.category,
                date: formatDate(e.date) || now.toISOString().slice(0, 10)
            };
            if (summary) item.summary = summary;
            if (content) item.content = content;
            fresh.push(item);
        }
    }

    // 合并：新抓取优先，旧条目保留（按 url 去重）
    const seen = new Set();
    const merged = [];
    for (const item of [...fresh, ...existing]) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        merged.push(item);
    }

    // 按 date 降序，裁剪到上限
    merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const final = merged.slice(0, MAX_ITEMS);

    // 分配 / 保留 id：旧条目按 url 保留原 id，新条目补 n01..n99
    const idByUrl = {};
    let maxNum = 0;
    existing.forEach(it => {
        if (it.id && it.url) idByUrl[it.url] = it.id;
        const m = /^n(\d+)$/.exec(it.id || '');
        if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    final.forEach(it => {
        if (idByUrl[it.url]) {
            it.id = idByUrl[it.url];
        } else {
            maxNum += 1;
            it.id = 'n' + String(maxNum).padStart(2, '0');
        }
    });

    const out = JSON.stringify(final, null, 4) + '\n';

    if (dry) {
        console.log('（--dry 模式，未写入文件）生成结果：');
        console.log(out);
        return;
    }

    fs.writeFileSync(DATA_FILE, out, 'utf8');
    console.log(`✓ 已写入 ${DATA_FILE}，共 ${final.length} 条资讯`);

    // 自检：调用校验脚本
    const { execSync } = require('child_process');
    try {
        execSync('node ' + path.join(__dirname, 'check-recommendations.js'), { stdio: 'inherit' });
    } catch (e) {
        console.error('✗ 校验未通过，请检查生成结果');
        process.exit(1);
    }
}

main().catch(e => {
    console.error('更新失败：', e);
    process.exit(1);
});
