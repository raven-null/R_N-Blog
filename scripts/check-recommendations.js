/**
 * 资讯数据校验与健康检查
 * 用法：
 *   node scripts/check-recommendations.js            # 字段合法性校验
 *   node scripts/check-recommendations.js --check    # 校验 + 外链健康检查
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const file = path.join(__dirname, '..', 'data', 'recommendations.json');

if (!fs.existsSync(file)) {
    console.error('文件不存在:', file);
    process.exit(1);
}

let items;
try {
    items = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
    console.error('JSON 解析失败:', e.message);
    process.exit(1);
}

if (!Array.isArray(items)) {
    console.error('根节点必须是数组');
    process.exit(1);
}

const errors = [];
const seenIds = new Set();
const seenUrls = new Set();

const isLink = (v) => /^(https?:)?\/\//.test(v);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

items.forEach((it, i) => {
    const at = `[第 ${i + 1} 条 ${it.title || it.id || '(未命名)'}]`;

    if (!it.id) errors.push(`${at} 缺少 id`);
    else if (seenIds.has(it.id)) errors.push(`${at} id 重复: ${it.id}`);
    else seenIds.add(it.id);

    if (!it.title) errors.push(`${at} 缺少 title`);

    if (!it.url || !isLink(it.url)) {
        errors.push(`${at} url 缺失或非法: ${it.url || '(空)'}`);
    } else if (seenUrls.has(it.url)) {
        errors.push(`${at} url 重复: ${it.url}`);
    } else {
        seenUrls.add(it.url);
    }

    if (it.source && typeof it.source !== 'string') {
        errors.push(`${at} source 应为字符串`);
    }

    if (it.category && typeof it.category !== 'string') {
        errors.push(`${at} category 应为字符串`);
    }

    if (it.date && !isDate(it.date)) {
        errors.push(`${at} date 格式应为 YYYY-MM-DD: ${it.date}`);
    }

    if (it.content !== undefined && typeof it.content !== 'string') {
        errors.push(`${at} content 应为字符串（Markdown 正文）`);
    }

    if (it.summary !== undefined && typeof it.summary !== 'string') {
        errors.push(`${at} summary 应为字符串`);
    }
});

if (errors.length) {
    console.error(`发现 ${errors.length} 个问题：`);
    errors.forEach(e => console.error('  ✗ ' + e));
    process.exit(1);
}

console.log(`✓ 校验通过：${items.length} 条资讯，字段合法、无重复 id/url`);

// 健康检查
if (process.argv.includes('--check')) {
    const urlCheck = (u) => new Promise(resolve => {
        const target = u.replace(/^\/\//, 'https://');
        const mod = target.startsWith('https') ? https : http;
        const req = mod.request(target, { method: 'HEAD', timeout: 10000 }, res => {
            resolve({ u, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
            res.resume();
        });
        req.on('timeout', () => { req.destroy(); resolve({ u, status: 'timeout', ok: false }); });
        req.on('error', () => resolve({ u, status: 'error', ok: false }));
        req.end();
    });

    (async () => {
        const results = await Promise.all(items.filter(it => it.url).map(it => urlCheck(it.url)));
        const bad = results.filter(r => !r.ok);
        if (bad.length) {
            console.error(`\n⚠ 发现 ${bad.length} 个无法访问的链接：`);
            bad.forEach(r => console.error(`  ✗ ${r.status} ${r.u}`));
            process.exit(1);
        }
        console.log(`✓ 健康检查通过：${results.length} 个链接均可访问`);
    })();
}
