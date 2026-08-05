/**
 * 生成图库清单：扫描 images/R-N-picture 目录，输出 manifest.json
 * 用法：node scripts/build-gallery.js
 * 添加图片后运行本脚本即可在页面上自动显示
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'images', 'R-N-picture');

if (!fs.existsSync(dir)) {
    console.error('目录不存在:', dir);
    process.exit(1);
}

const files = fs.readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp|gif|svg|bmp)$/i.test(f))
    .sort();

const manifest = path.join(dir, 'manifest.json');
fs.writeFileSync(manifest, JSON.stringify(files, null, 2) + '\n', 'utf8');

console.log(`图库清单已更新: ${files.length} 张图片 -> ${path.relative(process.cwd(), manifest)}`);
