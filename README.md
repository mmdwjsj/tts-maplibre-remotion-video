# Thailand Province Ranking Video

数据驱动的泰国府级排名动画，默认输出竖屏 1080×1920 / 30fps（可选横屏、方形）。当前 MVP 已实现 77 府底图、Top N 倒序揭晓、一次点亮后保持、信息标签、数据驱动的固定地图取景、JSON/Excel 解析器，以及按旁白片段真实时长驱动的时间轴——画面与旁白严格对齐。

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

**id 与名称必须指向同一个府**。地图只按 `provinceId` 高亮，标签文字用的是你填的 `provinceEn` / `provinceTh`：如果一行写的是「Narathiwat」却填了 `TH-45`（那其实是东北的黎逸府 Roi Et），成片就会在黎逸府点亮、标签写着那拉提瓦——看起来像地图错了，其实是 id 错了。所以生成前会做一次一致性校验（`src/data/provinceAudit.ts`）：名称归一化后与边界数据比对（空格/连字符/`Province` 后缀/常见别名都能对上），不一致时**反查并给出正确 id**，同时写进生成日志、HTTP 响应、`timeline.json`，Web 界面还会把出错的行标红并给一键修正。

- 查 id 用 [`PROVINCE_IDS.md`](./PROVINCE_IDS.md)（含英文名与泰文名三列对照）。
- Web 界面的三列是互通的：**选「府 ID」自动带出英文名与泰文名；输入或选择「泰文名」（或「英文名」）自动回填府 ID 与另一列**。候选来自边界数据，模糊输入由 `POST /api/provinces/resolve` 用 `lookupProvince()` 解析（能认 `TH-96` / `th96` / `96` / `Narathiwat` / `นราธิวาส` / `จังหวัดนราธิวาส` / `Ayutthaya` 这类写法），匹配到多个候选时不会瞎猜，而是提示改用府 ID。
- 命令行校验：`npm run validate:data`（默认只警告）；`npm run validate:data -- --strict-naming` 存在不一致时以非零码退出。
- 生成接口传 `"strictNaming": true` 时，存在不一致会直接返回 400 而不再渲染。
- 泰文名存放在边界数据的 `provinceTh` 字段（77 府全覆盖），由 `npm run data:thai-names` 写入；该脚本只改 `provinceTh`，不动几何数据，可重复执行。

JSON 示例位于 `public/data/rankings.json`。Excel 使用相同列名，可通过 `parseExcelRankings()` 转成统一模型。

**Web 界面版面**（一屏铺满，页面本身不滚动）：第一排是「排名数据 / 地图取景预览 / 视频与 TTS 设置」三列，预览列最宽、设置列最窄；第二排是「地图取景控件 + 生成音频与视频」，生成按钮靠右；第三排是「将要生成的完整音频文案」。排名数据表超出可视区域时横向、纵向都自己出滚动条，设置项与文案同理；窗口窄于 1180px 时才退回单列并允许整页滚动。

## 分层

- `src/data`：JSON / Excel 校验与统一数据模型；`provinceAudit.ts` 负责 `provinceId` 与府名的一致性校验、以及 id/英文名/泰文名的三向解析（纯函数、可单测）
- `src/data/thailand-provinces.geo.json`：独立的 77 府边界数据（含 `provinceId` / `provinceEn` / `provinceTh`）
- `src/framing`：数据驱动的静态取景算法（纯函数、可单测）
- `src/timeline`：音频片段时长 → Remotion 帧时间轴
- `src/config`：主题与动画参数
- `src/video`：确定性 SVG 地图渲染和 UI

## 地图取景（开场运镜 + 固定镜头）

地图不再强制显示完整国家。生成每个视频前，`src/framing/resolveViewport.ts` 会根据**本次完整排名集合**一次性算出固定视口；开场白期间镜头从**完整国家全景**推进到这个视口，之后整个视频从头到尾固定——不随排名逐条移动，不因高亮重新取景，也没有额外的推拉或抖动。

工作方式：

1. **匹配**：排名记录按 `provinceId`（大小写/空白容错）与 GeoJSON 要素关联，绝不使用府名；重复 id 只计一次并告警，找不到要素的区域进入 `missingIds` 并告警，不参与取景计算。
2. **边界**：用 d3-geo 的 `fitExtent` 在真实投影后的多边形边界上取景（不做经纬度线性近似，也不用质心平均当作中心）。
3. **离群取舍（默认关闭，双重保险）**：`coverageThreshold` 默认 `1` —— **每一个排名府都必须出现在画面里**。要启用剔除必须**同时**满足两个条件：`coverageThreshold` 降到 1 以下，**并且**显式设置 `allowOutlierDrop: true`（UI 上是「离群剔除」开关，默认关闭）。缺任何一个都会被强制按"全部可见"处理，并写一条 `allowOutlierDrop` 提示——这样旧页面、旧请求体里残留的 `coverageThreshold: 0.9` 也不可能悄悄隐藏排名府。剔除按排名区域数量计算（一个排名项 = 一份权重，保留名额 = `floor(条数 × 阈值)`，小数名额即离群豁免，例如 6 条 × 0.9 允许剔 1 个）。被剔区域的数据、排名、播报全部保留，并写进生成日志与 UI。
4. **国土居中**：全部排名府可见且画面宽度超过国土时（南北向长链的典型结果），画面不再以排名包围盒居中——那会把整块国土挤到一侧、另一侧留下大片空海——而是横向对齐**画布**中心，把空余的海洋均分到左右两侧（自动测试断言左右留白差 < 2px）。因为国土完整在画面内，居中不可能把任何排名府推出画面。当排名链的纵向跨度撑满整个国土时，横向留白由泰国宽高比（约 0.54）决定——此时画面已经做到“尽量大”，再放大只能靠裁掉最北/最南的排名府。
5. **收敛**：zoom 被限制在 `[minZoom, maxZoom]`（默认 5–12），异常输入一律回退默认值并给出可定位的警告。全覆盖取景也**不会比全景更小**——当排名范围已经覆盖整个国家（或一条贯穿南北的链），继续内缩只会得到"四周带留白的迷你全景"，此时直接使用标准全景，因为它同样包含每一个排名府。
6. **上下文地板**：`fitExtent` 只看排名区域自身的包围盒，所以当所有排名府恰好排在一条南北线上时，画面会被一根窄条填满、放大到只剩泰国的一小片——白陆压白陆，连海岸线和国境都不在画面里。`contextFloor` 规定画面**至少要横跨全国经度的这个比例**，不足时只后退到刚好够（覆盖不受影响，因为后退只会让排名府更靠内），并在取景日志里写明退了多少。默认值随预设：`tight` 0.22 / `balanced` 0.30 / `wide` 0.45，设 `0` 可完全关闭。
7. **开场运镜**：视频第一帧是完整国家全景 + 标题；开场白**一开口**镜头开始推进、**说完那一帧**镜头落位，运镜窗口与开场白完全重合（`timeline.camera = {start, end}`，开场白后的静音里镜头已经静止，绝不会压到第一个名次段）。插值只发生在 zoom（对数空间，观感速度均匀）和地理中心（经纬度线性）上，两端就是 `full-country` 与目标取景这两个已解析视口，缓动为 ease-in-out。没有开场白、`cameraMove: false`、或两端本来就一致（例如取景模式就是 `full-country`）时运镜自动退化为空操作，画面与旧版逐像素一致。

**画布与标题/页脚的关系**：地图仍是铺满整幅 1080×1920 画布的底层，但上下都让出遮盖带（`MAP_SAFE_INSET.top` = `MAP_OVERLAY_BANDS.top` = 250，`MAP_SAFE_INSET.bottom` = `MAP_OVERLAY_BANDS.bottom` = 200）——大标题字号大、颜色深，不再压住任何排名区域；底部留白则是给手机端的字幕条/按钮，抖音底部文字不会盖住府或数据标签。左右两侧仍然贴边。顶部渐变遮罩只覆盖标题带附近；浮动排名标签被钳制在标题/页脚之间的无遮挡安全带里（`viewport.labelRect`）。预览界面会用暗色带标出这两条遮盖区。

配置项（`ProjectData.framing`，Web 端「4 / 地图取景」面板，或请求体 `framing` 字段）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `fitMode` | `data-driven` | `data-driven` 按数据自动取景 / `full-country` 完整国家（铺满整幅画布）/ `manual` 手动中心与缩放 |
| `framingPreset` | `balanced` | `tight` 尽量放大重点区域 / `balanced` 平衡（默认）/ `wide` 展示更广范围；松紧只影响 padding 与上下文地板，**任何预设都不会剔除排名府** |
| `coverageThreshold` | `1` | `(0, 1]`，按排名区域数量计算的目标覆盖比例；`1`（默认）= 所有排名府必须可见 |
| `allowOutlierDrop` | `false` | 剔除离群府的显式开关；`false` 时 `coverageThreshold` 即使低于 1 也会被强制按 1 处理 |
| `padding` | 随预设 | `0 – 0.3`，在安全区内额外留白；`full-country` 模式忽略此项 |
| `contextFloor` | 随预设 | `[0, 1)`，画面至少横跨全国经度的这个比例；`0` = 关闭，让排名府尽可能贴满两侧 |
| `strictCoverage` | `false` | 开启后，未能覆盖全部排名区域时输出显式告警 |
| `cameraMove` | `true` | 开场运镜：开场白期间由全图推进到取景、说完停住；`false` 恢复全片固定镜头 |
| `manualCenter` / `manualZoom` | — | 仅 `fitMode: "manual"` 时生效，zoom 会被收敛到限制内 |

同一份输入、同一配置永远得到同一个视口（结果可复现且带缓存），不同视频任务之间互不共享。取景结果同时写进 `timeline.json` 的 `framing` 块，方便核对。取景计算与逐帧渲染完全分离：地图组件每帧只用现成的 `scale/translate` 重建投影。

测试：`npm run test:framing` 覆盖集中、南部、离群、分散、异常输入、多任务隔离与模式切换（A–G 场景，使用真实 77 府数据），以及开场运镜插值（两端即两个视口、zoom 单调推进、画面中心不漂、开关语义）；`npm run test:timeline` 覆盖「一行拆成名次/府名两段」「府名开口即点亮」「名次播报期间保持上一个府」「标题随开场白消失」「开场运镜窗口正好等于开场白」「无开场白时运镜为空」「旧 props 兼容」「无音频元数据回退」；`npm run test:data` 覆盖 id 与名称不一致、别名归一化、相似府名、空名与未知 id，以及 id/英文名/泰文名三向解析（含泰文 `จังหวัด` 前缀、短泰文名不误配、多候选不猜）与府列表三列完整性。


## 画幅与分辨率

`src/Root.tsx` 通过 `calculateMetadata` 返回 `width` / `height`，所以 `ProjectData.width` / `height` 可以直接改变输出画幅，Web 端的「画幅」下拉框也会透传到渲染命令。版式按 1080×1920 设计稿等比缩放居中，因此横屏和方形不会拉伸变形（会留深色边）。

## 音画同步

时间轴有两条来源，优先级如下：

1. `ProjectData.audioSegments`（推荐）：Web 端合成完 WAV 后，把每段的 `duration` 和 `gapAfter` 回写进渲染参数，`buildTimeline()` 直接按真实音频的秒数换算帧，画面与旁白逐段对齐。
2. `narrationDuration`（离线回退）：纯 Remotion Studio / CLI 渲染且没有音频分段信息时，每个府使用记录里的标称时长，缺省 3.2s。

每一行旁白都被拆成**两段时间轴分段**（`part: "rank"` / `"name"`）：`อันดับ 3` 是名次段，`ร้อยเอ็ด (Roi Et) มีค่า 5,600` 是府名段。**切分点量在真实旁白文本里**——服务端按空行把 `script` 拆成一行一行（`alignScriptLines`，行数对不上生成行时退回生成的模板行），再在行内定位府名的位置下刀（`splitSpokenLine`，找不到府名时退到名次数字之后），所以「名次念完、声音转到府名」的那一帧就是 `name` 段的起始帧。两段拼回整行、中间没有静音（静音只插在行与行之间），音频切片与高亮用的是同一份文本，因此解说和高亮天然一致。`timeline.json` 的 `segments` 里能看到这个拆分。

节奏规则（两条来源一致）：

- **府名一开口就点亮**：府在它的**名字开始被念**的那一刻点亮（`segment.revealAt` = 府名段起始帧），也就是名次刚播完、声音转到府名上的瞬间；名次播报期间画面保持上一个已揭晓的府。
- **标题是片头卡**：开场白一说完，标题（连同顶部遮罩）就淡出消失；没有开场白时标题保持不变。
- **片尾停留**：最后一名解说完后视频多停留 `max(各排名解说间隔, 1.5)` 秒（`finalHoldSeconds`），混流时音频用 `apad=whole_dur` 补静音，保证 #1 的高亮和标签真的看得见。

所有边界都从绝对秒数取整，不做累加，避免长视频出现帧漂移；总帧数向上取整，保证视频不会比音轨短而被 `ffmpeg -shortest` 截断。

## TTS 接入

把 Gemini TTS 生成的整段音频放入 `public/audio/`，在项目数据中设置 `audioSrc`；同时把每段实际时长写入对应记录的 `narrationDuration`。生产自动化可在此基础上增加脚本：生成泰语文案 → 调 Gemini TTS → ffprobe 获取时长 → 写入项目 JSON → Remotion render。

Web 端（`npm run web`）已经内置这条链路：表单/JSON → 6 个引擎可选合成 → 插静音 → 写 `timeline.json` → Remotion render → ffmpeg 混流。环境变量可参考 `.env.tts.example` 复制为 `.env.tts` 自动加载（详见 `TTS_ENGINES.md`）。

## 数据来源

府级多边形基于 Thailand Canonical Administrative-Names Reference 的 77 ADM1 GeoJSON（CC BY 4.0；多边形上游为 OCHA CODs / CC BY 3.0 IGO）。发布成品时请保留相应署名和 NOTICE。
