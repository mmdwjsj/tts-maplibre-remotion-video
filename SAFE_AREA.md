# TikTok / 抖音 UI 安全区适配

竖屏 1080×1920 成片在 TikTok / 抖音客户端里会被平台自己的 UI 盖住一部分：
顶部标题栏、右侧点赞/评论/转发互动栏、底部文案与进度条。本项目通过一份
**可配置的 JSON 安全区配置** 让标题、排名标签、地图取景自动避开这些区域。

## 配置在哪

`src/config/safe-area.config.json`（源码默认值）。可用环境变量或项目根目录
`config/safe-area.config.json` 覆盖，加载优先级与 TTS 配置一致：

1. 环境变量 `SAFE_AREA_CONFIG_PATH`
2. `<项目根>/config/safe-area.config.json`
3. `src/config/safe-area.config.json`（默认）

坏配置**只降级不改行为**：单个字段非法时回退默认值并在 `warnings` 里逐条告警，
不会让生成流程失败。

## 字段说明

| 字段 | 含义 |
| --- | --- |
| `version` | 配置版本号（当前 `2026-10-16.1`），进生成日志与预览 |
| `canvas` | 画布尺寸，默认 1080×1920 |
| `defaultPlatform` | 请求未指定平台时用哪个平台 |
| `contentGapPx` | 重要内容与安全区边界 / 禁入区的额外间距（24px） |
| `descriptionTiers[]` | 描述长度分档：`maxChars` 边界 + 各档底部预留 |
| `platforms.<id>.margins` | 上/下/左/右四边预留 |
| `platforms.<id>.bottomByTier` | 按描述等级覆盖底部预留（优先于全局档位值） |
| `platforms.<id>.interactiveKeepOut` | 右侧互动栏禁入区（x/y/w/h） |
| `platforms.<id>.mapBleed` | 底图允许吃进上/下预留带的像素（只影响地图底图） |

两个平台的配置**互相隔离**：改抖音不会影响 TikTok，反之亦然；
缺少的平台块用默认值补齐，而不是抄另一个平台。

### 描述等级（短 / 中 / 长）

按发布文案的字符数（`Array.from` 计数，泰文/中文/emoji/换行各算 1 个）分档：

- short ≤ 80 字符 → 底部预留 480px
- medium 81~200 → 540px
- long > 200 → 600px

边界值在 `descriptionTiers[].maxChars` 里改。发布文案缺失时回退 short 档并告警。
**发布文案（`publishDescription`，请求字段）与视频内口播字幕是两回事**：
前者只用于估底部 UI 遮挡，不会改动任何音频/字幕内容。

## 矩形含义

| 矩形 | 用途 |
| --- | --- |
| `coreRect` | 核心内容安全区：标题、排名数字、府名、图例必须完整落在这里。**排名府的取景目标也是它**——一个府的形状跑进状态栏或文案区，就不算"可见" |
| `labelRect` | `coreRect` 内缩 `contentGapPx`，浮动标签允许区 |
| `mapRect` | 地图底图可用区：海面与未排名府允许出血到画布边缘和平台 UI 带 |
| `interactiveRect` | 右侧互动栏禁入区 |
| `interactiveGapRect` | 禁入区外扩 `contentGapPx`：重要内容的"实际禁入"范围 |

禁入区贴着画布右边缘时，`coreRect.x1` 会自动收到 `禁入区左边界 - contentGapPx`，
保证贴着安全区右边放下内容不会正好落进那段间距里。

### 底图纵向压扁（`framing.verticalSquash`，默认 12%）

泰国很瘦高（宽高比约 0.54），按核心安全区等比装下只有约 714px 宽，两侧空出
一大片。取景目标从出血区改成安全区之后，这个差距靠**纵向压扁**补回来：

- 只压缩**地理形状**的 y 方向，x 不动。压 12% 时地图宽约 812px（+14%），
  压 19% 时宽度刚好顶满安全区（约 882px，+23%）。
- 文字、标签卡片、引线**从不压扁**——压扁做在投影层，标签坐标用的是压扁后
  的真实位置，所以文字永远是正的。
- 这张图的颜色编码的是名次，不是面积或距离；画面里也没有网格、比例尺、
  正圆这类会暴露形变的参照物，所以压 12%~19% 肉眼基本看不出。
- `verticalSquash: 0` 即恢复严格等比。
- 超过 19% 后宽度不再增加（已被安全区宽度顶满），只会白白变矮，不建议。

## 参数可信度（重要）

**当前所有像素值都是工程初始估值（`provenance: "initial-estimate"`），
未用真机截图逐台校准，且 TikTok 的广告位与自然流量位布局不同、
TikTok 与抖音布局也不同。** 上线前请用目标机型的客户端截图核对一遍，
确认后把对应平台块的 `verified` 改为 `true` 并更新 `version`。

## 取景与标签如何避让

- `resolveViewport(..., stage, safe)` 接收安全区的 `fitRect`（= `coreRect`）/
  `labelRect` / `keepOutRect`。排名府的**外接矩形**必须完整落在取景框内
  （含 1px 容差）才算覆盖——相交不算；收敛不到时逐次后退（每次 3%，
  最多 24 次），被 `minZoom` 拦住时给出警告。相机仍是**全程静态**的。
- 国土的水平居中目标从画布中心改成了**取景框中心**（右侧互动栏会把安全区
  推离画布中线），且只在横向有富余时才滑，滑动量被"不把任何排名府推出框"
  硬性限制。
- 排名标签沿用 `placeLabel` 的偏好位/翻转逻辑，仅当偏好位压进禁入区时才尝试
  推左 / 推上 / 推下 / 翻转，**不缩字号、不挪地图**。
- 审计输出可定位的诊断（元素 id、坐标、方向、所属组件）；
  标签之间的重叠以"提示"呈现——本项目的地图每帧只渲染一个活动标签，
  不同府的标签不会同屏（见 `ThailandMap` 的 `active` 渲染分支）。

## 开发期预览遮罩

网页端第三排「发布设置（平台 UI 安全区）」里勾选 **显示安全区预览**，
取景预览图上会叠加：安全区外半透明遮罩、核心区实线框、标签区虚线框、
右侧禁入区橙红框与各边界坐标。

- 遮罩只存在于浏览器预览与显式传 `debugSafeArea: true` 的 Remotion 渲染里；
  生成接口写出的 renderProps **永远不含** `debugSafeArea`，
  所以导出的 MP4 不会带遮罩（有测试 + 实渲静帧双重验证）。
- 不新增开发服务器，走现有 `npm run web`。

## 测试

```bash
npm run test:safe-area   # 安全区 26 项（含 12 个任务场景与向后兼容）
npm run test:framing     # 取景（含不传安全区的旧行为一致性）
```

全量：`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test
scripts/safearea/safe-area.test.mjs scripts/framing/viewport.test.mjs
scripts/timeline/timeline.test.mjs scripts/timeline/narration.test.mjs
scripts/data/province-audit.test.mjs`
