# 桌宠动效引擎（第三方，仅供学习）

来源：https://github.com/blessonism/grok-icon-study （replica 目录）
作者说明：素材归 xAI / 相应权利人所有，仅供学习参考，请勿商用或再分发。

本项目只把这些文件当作动效引擎使用（弹簧动画 / 多边形眼睛 / 状态机）。

## 本地补丁（仅 character.js）

为了在 58px 的小尺寸下让「眼睛一直看着鼠标」看得清楚，`character.js` 加了三处
带 `LOCAL PATCH` 注释的小改动，默认行为与原版完全一致：

| 差异 | 说明 |
| --- | --- |
| 构造参数 `gazeRange: { x, y }` | 注视幅度（原实现写死 22 / 14），默认值不变 |
| 构造参数 `gazeClamp` | 归一化上限（原实现写死 0.6），默认值不变 |
| 构造参数 `gazeFalloff` | 多远算"看得很偏"（原实现写死 2，即 2 倍身宽就满幅），默认值不变 |
| `rectAt = 0` | 外部可强制刷新 SVG 矩形缓存，桌宠被拖动时眼睛不会朝旧位置看 |

引用这些文件时记得同步 `?v=` 版本参数（`grok/character.js?v=1.0.2`），否则浏览器会用旧缓存。

引用的文件：
- geometry-data.js  几何数据（身形 / 眼睛拓扑 / 配色）
- math.js           数学与弹簧工具
- tables.js         状态表、眼睛播放列表、眨眼参数
- pose.js           姿态插值
- tricks.js         小动作
- fx.js             特效与覆盖层
- eyes.js           眼睛形变、眨眼队列
- character.js      对外入口 window.GrokCharacter（含上述本地补丁）
