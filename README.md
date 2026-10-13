# Thailand Province Ranking Video

数据驱动的泰国府级排名动画，默认输出竖屏 1080×1920 / 30fps（可选横屏、方形）。当前 MVP 已实现 77 府底图、Top N 倒序揭晓、一次点亮后保持、信息标签、轻微镜头缩放、JSON/Excel 解析器，以及按旁白片段真实时长驱动的时间轴——画面与旁白严格对齐。

## 启动

```bash
npm install
npm run dev
npm run typecheck
npm run render
```

Windows PowerShell 若禁用了 `npm.ps1`，使用 `npm.cmd run dev`。

## 换数据

排名记录必须包含稳定的 `provinceId`（TIS-1099 / ISO 风格，例如 `TH-10`），避免用府名做脆弱关联。字段：`rank, provinceId, provinceEn, provinceTh, value`；可选 `valueLabel, narrationDuration`。`narrationDuration` 是对应泰语旁白片段的实际秒数，时间轴不会写死每府时长。

JSON 示例位于 `public/data/rankings.json`。Excel 使用相同列名，可通过 `parseExcelRankings()` 转成统一模型。

## 分层

- `src/data`：JSON / Excel 校验与统一数据模型
- `src/data/thailand-provinces.geo.json`：独立的 77 府边界数据
- `src/timeline`：音频片段时长 → Remotion 帧时间轴
- `src/config`：主题与动画参数
- `src/video`：确定性 SVG 地图渲染和 UI

## 画幅与分辨率

`src/Root.tsx` 通过 `calculateMetadata` 返回 `width` / `height`，所以 `ProjectData.width` / `height` 可以直接改变输出画幅，Web 端的「画幅」下拉框也会透传到渲染命令。版式按 1080×1920 设计稿等比缩放居中，因此横屏和方形不会拉伸变形（会留深色边）。

## 音画同步

时间轴有两条来源，优先级如下：

1. `ProjectData.audioSegments`（推荐）：Web 端合成完 WAV 后，把每段的 `duration` 和 `gapAfter` 回写进渲染参数，`buildTimeline()` 直接按真实音频的秒数换算帧，画面高亮与旁白逐段对齐；静音间隔期间保持上一个已点亮的府。
2. `narrationDuration`（离线回退）：纯 Remotion Studio / CLI 渲染且没有音频分段信息时，每个府使用记录里的标称时长，缺省 3.2s。

所有边界都从绝对秒数取整，不做累加，避免长视频出现帧漂移；总帧数向上取整，保证视频不会比音轨短而被 `ffmpeg -shortest` 截断。

## TTS 接入

把 Gemini TTS 生成的整段音频放入 `public/audio/`，在项目数据中设置 `audioSrc`；同时把每段实际时长写入对应记录的 `narrationDuration`。生产自动化可在此基础上增加脚本：生成泰语文案 → 调 Gemini TTS → ffprobe 获取时长 → 写入项目 JSON → Remotion render。

Web 端（`npm run web`）已经内置这条链路：表单/JSON → 6 个引擎可选合成 → 插静音 → 写 `timeline.json` → Remotion render → ffmpeg 混流。环境变量可参考 `.env.tts.example` 复制为 `.env.tts` 自动加载（详见 `TTS_ENGINES.md`）。

## 数据来源

府级多边形基于 Thailand Canonical Administrative-Names Reference 的 77 ADM1 GeoJSON（CC BY 4.0；多边形上游为 OCHA CODs / CC BY 3.0 IGO）。发布成品时请保留相应署名和 NOTICE。
