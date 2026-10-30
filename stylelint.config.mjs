/**
 * Stylelint · 止血配置（极简版）
 * ------------------------------------------------------------
 * 不 extends standard——旧代码会刷出数千条无关噪音。
 * 只守两条底线，全部 warning（不阻断构建）；P6 清账后转 error：
 *   1. 新代码 0 个 !important
 *   2. 不出现无效 hex 颜色
 *
 * 忽略 bundle.css（build-css.mjs 生成物）与 vendor 第三方样式。
 */

/** @type {import('stylelint').Config} */
export default {
  ignoreFiles: [
    'public/css/bundle.css',
    'public/css/highlight-github-dark.min.css',
    'public/js/vendor/**',
    'node_modules/**',
    '.local-data/**',
  ],
  rules: {
    'declaration-no-important': [true, { severity: 'warning' }],
    'color-no-invalid-hex': true,
  },
};
