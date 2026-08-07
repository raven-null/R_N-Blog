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

// ---------- 原文正文提取（RSS 仅摘要时增强） ----------

// 常见站点噪音（导航/侧栏/相关阅读/版权/分享等）
const NOISE_RE = /(扫码|关注公众号|来源[:：]|编辑[:：]|责任编辑|声明|未经.*授权|版权所有|转载|相关阅读|热门文章|上一篇|下一篇|返回顶部|广告|推广|搜索[:：]|分享至|打开App|下载客户端|加微信|QQ群|加入我们|商务合作|关于我们|菜单|首页|资讯|智能车|智库|活动|AIGC)/;

// 取文档中"最长连续正文段落"（去噪音、去短段），返回拼接文本
function extractParagraphRun(html) {
    const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .split('\n')
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    // 找出连续正文块：累计长度最大的连续序列
    let best = [];
    let cur = [];
    let bestLen = 0;
    for (const line of clean) {
        if (line.length >= 15 && !NOISE_RE.test(line)) {
            cur.push(line);
        } else {
            const len = cur.join('').length;
            if (len > bestLen) { bestLen = len; best = cur; }
            cur = [];
        }
    }
    const len = cur.join('').length;
    if (len > bestLen) { bestLen = len; best = cur; }
    return best;
}

// 从 HTML 中裁剪出最可能的正文容器，返回其内部 HTML
function extractMainHtml(html) {
    const pick = (re) => {
        const m = html.match(re);
        return m ? m[1] || m[0] : '';
    };
    // 优先精确容器（避免匹配到整页 main/body 引入导航侧栏）
    const patterns = [
        /<article[\s>][\s\S]*?<\/article>/i,
        /<div[^>]*class=["'][^"']*\bartcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*\barticle-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*\bpost-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*class=["'][^"']*\barticle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<div[^>]*id=["'](?:content|article|post|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        /<main[\s>][\s\S]*?<\/main>/i
    ];
    for (const re of patterns) {
        const raw = pick(re);
        const txt = stripTags(raw).replace(/\s+/g, '').length;
        if (txt > MIN_CONTENT_LEN) return raw;
    }
    return '';
}

// 从正文 HTML 中提取文本段落（去脚本/样式/注释），用于回退
function textParagraphs(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<p[^>]*>[\s\S]*?<\/p>/gi, m => m + '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/tr>/gi, '\n');
}

// 抓取原文页面正文（供摘要型来源补全 content）
async function fetchArticleContent(url, sourceName) {
    try {
        const html = await fetchText(url, 20000);
        if (!html) return '';

        // 先尝试精确容器；若命中且正文长度足够则直接用
        const raw = extractMainHtml(html);
        if (raw) {
            const md = htmlToMarkdown(raw);
            const textLen = stripTags(raw).replace(/\s+/g, '').length;
            if (md && textLen >= MIN_CONTENT_LEN) return md;
        }

        // 容器识别失败或正文过短：退化用"最长连续正文段落"
        const runs = extractParagraphRun(html);
        if (runs.join('').length >= MIN_CONTENT_LEN) {
            return runs.join('\n\n');
        }

        // 最终回退：正文区域前 N 段
        const paragraphs = textParagraphs(html)
            .split('\n')
            .map(s => s.replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim())
            .filter(s => s.length >= 20);
        const clean = paragraphs.filter((s, i) => i === 0 ? true : !NOISE_RE.test(s)).slice(0, 12);
        if (clean.join('').length < MIN_CONTENT_LEN) return '';
        return clean.join('\n\n');
    } catch (e) {
        console.warn(`  ↳ ${sourceName} 正文抓取失败：${e.message}`);
        return '';
    }
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

    // 增强：RSS 仅摘要的条目，尝试抓取原文页面补全正文（限并发 3）
    console.log('· 开始抓取原文正文（摘要型来源增强）...');
    const concurrency = 3;
    let index = 0;
    const work = fresh.filter(it => !it.content && it.url);
    const worker = async () => {
        while (index < work.length) {
            const item = work[index++];
            console.log(`  ↳ ${item.source}：${item.title.slice(0, 30)}...`);
            const body = await fetchArticleContent(item.url, item.source);
            if (body) item.content = body;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));

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
