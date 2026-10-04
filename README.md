# Thailand Province Ranking Video

数据驱动的泰国府级竖屏排名动画，输出规格为 1080×1920 / 30fps。当前 MVP 已实现 77 府底图、Top N 倒序揭晓、一次点亮后保持、信息标签、排行榜、轻微镜头缩放、JSON/Excel 解析器和按旁白片段时长驱动的时间轴。

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

## TTS 接入

把 Gemini TTS 生成的整段音频放入 `public/audio/`，在项目数据中设置 `audioSrc`；同时把每段实际时长写入对应记录的 `narrationDuration`。生产自动化可在此基础上增加脚本：生成泰语文案 → 调 Gemini TTS → ffprobe 获取时长 → 写入项目 JSON → Remotion render。

## 数据来源

府级多边形基于 Thailand Canonical Administrative-Names Reference 的 77 ADM1 GeoJSON（CC BY 4.0；多边形上游为 OCHA CODs / CC BY 3.0 IGO）。发布成品时请保留相应署名和 NOTICE。
