/**
 * 生成「加载遮罩背景图池」
 *
 * 数据源：博客自己的图库代理 /api/gallery（缓存了 r-gallery 的列表，含 fav / rating / 分类）
 * 选图规则：
 *   - 只要 rating === 'general'（默认）。带 --allow-r18 时才把 r16/r18 也收进来，
 *     且必须提供图库 token（GALLERY_TOKEN 环境变量）——那些图游客接口本来就不发。
 *   - 横向构图（width > height）：竖图铺宽屏会被裁成一条缝
 *   - 宽度 >= 1600：保证 1920 档不是硬放大的糊图
 *   - 收藏（fav）优先，其次按分辨率降序
 * 产物：
 *   public/images/loader/<id>-1280.webp / -1920.webp / -2560.webp
 *   public/images/loader/manifest.json  （前台据此按屏幕选档 + 随机挑一张）
 *
 * 用法：node scripts/build-loader-bg.mjs [--limit=6] [--allow-r18]
 */
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';

const LIST_URL = process.env.GALLERY_LIST_URL || 'https://ravennull.work/api/gallery?limit=1000';
const OUT_DIR = 'public/images/loader';
const SRC_DIR = '.local-data/loader-src';

const args = process.argv.slice(2);
const argNum = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const LIMIT = argNum('limit', 6);
const ALLOW_R18 = args.includes('--allow-r18');
const TOKEN = process.env.GALLERY_TOKEN || '';

const SIZES = [
  { w: 1280, q: 80 },
  { w: 1920, q: 78 },
  { w: 2560, q: 76 },
];

const log = (...a) => console.log(...a);

async function fetchList() {
  // 两个来源合并：
  //   r-gallery 的 /api/photos → id / fav / width / height / rating（但 src 是 null，拿不到原图）
  //   博客的 /api/gallery     → id / url（原图地址，游客只发 general 那些）
  const url = TOKEN ? `${LIST_URL}&token=${encodeURIComponent(TOKEN)}` : LIST_URL;
  const blogRes = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!blogRes.ok) throw new Error(`列表请求失败 HTTP ${blogRes.status}`);
  const blogData = await blogRes.json();
  const urlById = new Map((Array.isArray(blogData.photos) ? blogData.photos : []).map((p) => [p.id, p]));
  log(`博客代理：${urlById.size} 张可用原图（cached=${blogData.cached}）`);

  const meta = [];
  let cursor = '';
  for (let round = 0; round < 12; round += 1) {
    const u = new URL('https://r-gallery.netlify.app/api/photos');
    u.searchParams.set('limit', '500');
    u.searchParams.set(cursor ? 'cursor' : 'token', cursor || TOKEN);
    if (!TOKEN) u.searchParams.set('safe', '1');
    if (cursor) u.searchParams.set('safe', TOKEN ? '0' : '1');
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`图库元数据请求失败 HTTP ${res.status}`);
    const data = await res.json();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    meta.push(...photos);
    cursor = data.cursor || '';
    if (!cursor || !photos.length) break;
  }
  log(`图库元数据：${meta.length} 张（含 fav / 尺寸 / 评级）`);

  // 合并：有原图地址的才算可用
  const merged = meta
    .filter((p) => urlById.has(p.id))
    .map((p) => ({ ...p, url: urlById.get(p.id).url }));
  return merged;
}

function pick(photos) {
  const allowedRatings = ALLOW_R18 ? ['general', 'r16', 'r18'] : ['general'];
  const usable = photos.filter((p) => {
    if (!p || !p.id || !p.url) return false;
    if (!allowedRatings.includes(String(p.rating || 'general'))) return false;
    return true;
  });
  // 横向 + 宽度达标（列表里有 width/height 就先用它初筛，没有就靠下载后的真实尺寸兜底）
  const landscape = usable.filter((p) => {
    const w = Number(p.width) || 0;
    const h = Number(p.height) || 0;
    if (w && h) return w > h && w >= 1600;
    return true;
  });
  const favs = landscape.filter((p) => p.fav);
  const rest = landscape.filter((p) => !p.fav).sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  const ordered = [...favs.sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0)), ...rest];
  log(`可选横向高清图 ${landscape.length} 张（其中收藏 ${favs.length} 张），取前 ${LIMIT} 张`);
  return ordered.slice(0, LIMIT);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(SRC_DIR, { recursive: true });

  // 老产物先清掉，避免 manifest 里的图和文件对不上
  for (const f of await readdir(OUT_DIR)) {
    if (f.endsWith('.webp') || f === 'manifest.json') await unlink(`${OUT_DIR}/${f}`);
  }

  const photos = await fetchList();
  const picked = pick(photos);
  const manifest = [];
  let totalBytes = 0;

  for (const p of picked) {
    try {
      const raw = await download(p.url);
      const img = sharp(raw);
      const meta = await img.metadata();
      if (!meta.width || !meta.height) { log(`跳过 ${p.id}：读不到尺寸`); continue; }
      if (meta.width <= meta.height) { log(`跳过 ${p.id}：${meta.width}x${meta.height} 是竖图`); continue; }
      if (meta.width < 1600) { log(`跳过 ${p.id}：只有 ${meta.width}px 宽，不够 1920 档`); continue; }

      const slots = {};
      for (const s of SIZES) {
        const out = `${OUT_DIR}/${p.id}-${s.w}.webp`;
        const buf = await sharp(raw)
          .resize({ width: s.w, withoutEnlargement: true })
          .webp({ quality: s.q, effort: 5 })
          .toBuffer();
        await writeFile(out, buf);
        slots[String(s.w)] = `/images/loader/${p.id}-${s.w}.webp`;
        totalBytes += buf.length;
      }

      // 取个平均色，前端可以在图到位前先铺一块同色底，避免闪
      const { dominant } = await sharp(raw).resize(24, 24, { fit: 'inside' }).stats();
      const color = dominant ? `rgb(${dominant.r}, ${dominant.g}, ${dominant.b})` : '';

      manifest.push({
        id: p.id,
        title: p.title || '',
        rating: p.rating || 'general',
        fav: !!p.fav,
        w: meta.width,
        h: meta.height,
        color,
        slots,
      });
      log(`✓ ${p.id}  ${meta.width}x${meta.height}${p.fav ? '  ★收藏' : ''}  → 三档 ${Math.round(totalBytes / 1024)}KB 累计`);
    } catch (e) {
      log(`✗ ${p.id} 失败：${e.message}`);
    }
  }

  await writeFile(`${OUT_DIR}/manifest.json`, JSON.stringify({ generatedAt: new Date().toISOString(), allowR18: ALLOW_R18, items: manifest }, null, 2));
  log(`\n完成：${manifest.length} 张，总计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (!existsSync(`${OUT_DIR}/manifest.json`)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
