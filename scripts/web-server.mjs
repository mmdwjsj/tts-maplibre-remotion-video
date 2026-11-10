import "./tts/load-env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTtsRegistry } from "./tts/engine-registry.mjs";
import { loadTtsConfig } from "./tts/log-config.mjs";
import { loadSafeAreaConfig } from "./safearea/load-safe-area-config.mjs";
import {
  normalizeTtsRequest,
  normalizeUnifiedTtsRequest,
} from "./tts/request.mjs";
import { validateTtsRequest } from "./tts/validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = path.join(root, "out", "generated");
const remotionCli = path.join(
  root,
  "node_modules",
  "@remotion",
  "cli",
  "remotion-cli.js",
);
fs.mkdirSync(generatedDir, { recursive: true });

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".css": "text/css",
};
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const jsonError = (res, error) =>
  json(res, error.statusCode || 500, {
    error: { code: error.code || "TTS_ERROR", message: error.message },
    message: error.message,
  });
const safeName = (value) =>
  String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100) || "thailand-ranking";

const DEFAULT_RESOLUTION = { width: 1080, height: 1920 };
// H.264 requires even dimensions.
const toEven = (value) => (value % 2 === 0 ? value : value + 1);
const parseResolution = (value) => {
  const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(String(value ?? "").trim());
  if (!match) return DEFAULT_RESOLUTION;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 240 || height < 240 || width > 4096 || height > 4096) {
    return DEFAULT_RESOLUTION;
  }
  return { width: toEven(width), height: toEven(height) };
};

const run = (command, args, timeoutMs = 0) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: root });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(
            new Error(
              `${path.basename(command)} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs)
      : null;
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              stderr.trim() || `${path.basename(command)} exited ${code}`,
            ),
          );
    });
  });

const runPowerShell = (script, args = [], timeoutMs = 0) =>
  run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    timeoutMs,
  );
const { config: ttsConfig, configPath: ttsConfigPath } = loadTtsConfig(root);

const ttsRegistry = createTtsRegistry({
  run,
  runPowerShell,
  root,
  remotionCli,
  config: ttsConfig,
});

/**
 * The static framing algorithm lives in `src/framing/resolveViewport.ts` and is
 * loaded by the render pipeline. The dev server loads the very same module (Node
 * executes TypeScript directly here) so the preview, the generation log and the
 * MP4 all use one implementation. If the running Node cannot execute TypeScript,
 * framing simply degrades: generation still works, only the preview endpoint and
 * the framing log report the limitation.
 */
let framingModule = null;
try {
  framingModule = await import("../src/framing/resolveViewport.ts");
} catch (error) {
  console.warn(
    `[framing] 无法加载 TypeScript 取景模块，预览取景与取景日志不可用：${error.message}`,
  );
}

let provinceAuditModule = null;
try {
  provinceAuditModule = await import("../src/data/provinceAudit.ts");
} catch (error) {
  console.warn(
    `[data] 无法加载府名校验模块，provinceId 与名称一致性检查不可用：${error.message}`,
  );
}

/**
 * TikTok / 抖音 UI 安全区。配置来自 `src/config/safe-area.config.json`（可用
 * `SAFE_AREA_CONFIG_PATH` 或 `config/safe-area.config.json` 覆盖），计算逻辑
 * 来自 `src/safearea/safeArea.ts` —— 与渲染端**同一份**实现，所以预览、日志
 * 和成片不会算出三套不同的边距。模块加载失败时退回内置默认值并告警。
 */
let safeAreaModule = null;
try {
  safeAreaModule = await import("../src/safearea/safeArea.ts");
} catch (error) {
  console.warn(
    `[safe-area] 无法加载安全区模块，将退回内置默认值：${error.message}`,
  );
}

/** 标签落位算法（与 `ThailandMap` 用的是同一个模块，不是复制品）。 */
let labelPlacementModule = null;
try {
  labelPlacementModule = await import("../src/video/layout/labelPlacement.ts");
} catch (error) {
  console.warn(
    `[safe-area] 无法加载标签落位模块，标签落位审计不可用：${error.message}`,
  );
}

/**
 * 视觉主题：预览页要画和成片一模一样的三行读数，文字颜色必须来自同一份主题，
 * 否则网页上「深墨绿 + 白描边」和 MP4 里的颜色会悄悄分叉。
 */
let themeModule = null;
try {
  themeModule = await import("../src/config/theme.ts");
} catch (error) {
  console.warn(`[theme] 无法加载主题模块，预览读数退回内置墨绿色：${error.message}`);
}

const {
  config: safeAreaConfig,
  configPath: safeAreaConfigPath,
  warning: safeAreaConfigWarning,
} = loadSafeAreaConfig(root);
if (safeAreaConfigWarning) {
  console.warn(`[safe-area] ${safeAreaConfigWarning}`);
} else {
  console.log(`[safe-area] 配置 ${safeAreaConfigPath}`);
}

/**
 * The narration module turns the ranking table into the lines the engine speaks
 * and locates the rank/name boundary inside each of them. The timeline is split
 * on exactly those boundaries, so the map lights a province the moment the voice
 * reaches its name.
 */
let narrationModule = null;
try {
  narrationModule = await import("../src/timeline/narration.ts");
} catch (error) {
  console.warn(
    `[timeline] 无法加载旁白拆分模块，将退回按名次/府名固定比例拆分：${error.message}`,
  );
}

/**
 * The timeline module owns the intro camera window (start delay + landing beat),
 * so the audit file written below reports exactly what the renderer will do
 * instead of a second, hand-copied rule. Falls back to the documented default if
 * the TypeScript module cannot be loaded.
 */
let timelineModule = null;
try {
  timelineModule = await import("../src/timeline/buildTimeline.ts");
} catch (error) {
  console.warn(
    `[timeline] 无法加载时间轴模块，运镜窗口将使用内置默认值：${error.message}`,
  );
}
const CAMERA_START_DELAY_SECONDS =
  timelineModule?.CAMERA_START_DELAY_SECONDS ?? 0.5;
const CAMERA_END_SECONDS = timelineModule?.CAMERA_END_SECONDS ?? null;

let provinceGeoJson = null;
try {
  provinceGeoJson = JSON.parse(
    fs.readFileSync(
      path.join(root, "src", "data", "thailand-provinces.geo.json"),
      "utf8",
    ),
  );
} catch (error) {
  console.warn(
    `[data] 无法读取行政区域边界数据，取景预览与名称校验不可用：${error.message}`,
  );
}

/**
 * Resolves the static viewport for one job and prints the generation log:
 * framing mode, centre, zoom, coverage and — explicitly — every ranking region
 * that ended up outside the frame.
 */
const resolveFraming = (rankings, framing, safeArea) => {
  if (!framingModule || !provinceGeoJson) return null;
  const viewport = framingModule.resolveViewport(
    provinceGeoJson,
    (Array.isArray(rankings) ? rankings : []).map((row) => row?.provinceId),
    framing,
    framingModule.MAP_STAGE,
    // The platform safe area is resolved by `src/safearea/safeArea.ts`; it only
    // supplies the fit/label rectangles, it never adds per-frame motion.
    safeArea
      ? {
          mapRect: safeArea.mapRect,
          labelRect: safeArea.labelRect,
          keepOutRect: safeArea.interactiveGapRect,
        }
      : undefined,
  );
  framingModule
    .describeViewport(viewport)
    .forEach((line) =>
      line.startsWith("警告：")
        ? console.warn(`[framing] ${line}`)
        : console.log(`[framing] ${line}`),
    );
  return viewport;
};

/**
 * Checks every row's `provinceId` against the name that row carries.
 *
 * The renderer keys off `provinceId` on purpose (province names are unreliable),
 * so a row that *names* one province while *pointing* at another lights up the
 * wrong shape and looks like a map bug. This is the check that catches it before
 * a render ships, and it reverse-looks-up the id the name implies.
 */
const auditProvinces = (rankings) => {
  if (!provinceAuditModule || !provinceGeoJson) return null;
  const audit = provinceAuditModule.auditRankings(provinceGeoJson, rankings);
  audit.warnings.forEach((line) => console.warn(`[data] ${line}`));
  if (!audit.warnings.length) {
    console.log(
      `[data] provinceId 与府名一致（${audit.checked}/${audit.total} 行可比对）`,
    );
  }
  return audit;
};

/**
 * Resolves the platform UI safe area for one job and writes the log.
 *
 * The platform and the **publish description** come straight from the request;
 * the description only ever picks a tier (short / medium / long) — it is not the
 * on-video narration, and the video never re-flows its own text because the
 * caption got longer.
 */
const resolveSafeAreaFor = (body, { silent = false } = {}) => {
  if (!safeAreaModule) return null;
  const resolution = safeAreaModule.resolveSafeArea(safeAreaConfig, {
    platform: body?.platform,
    description: body?.publishDescription,
    // 四个分区的四条边界 = 唯一一组可调参数（核心框四边）。预览与成片把同一组
    // 值送进同一个 resolveSafeArea，所以只有一个矩形、只有一套来源。
    coreMargins: body?.coreMargins,
  });
  // The preview endpoint re-resolves while the user types; only the generation
  // path writes the log, so nothing is spammed and nothing is swallowed either.
  if (silent) return resolution;
  safeAreaModule
    .describeSafeArea(resolution)
    .forEach((line) =>
      line.startsWith("警告：")
        ? console.warn(`[safe-area] ${line}`)
        : console.log(`[safe-area] ${line}`),
    );
  return resolution;
};

/**
 * 取景基准没有独立入口（2026-11-07 合并）：`mapRect` 恒等于四分区的
 * `coreRect`。四分区的四条边界就是唯一一组可调参数 `body.coreMargins`
 * （上 / 下 / 左 / 右 = 核心框四条边距屏幕四边的像素），由
 * `resolveSafeAreaFor` 透传给 `resolveSafeArea` 一次派生。
 *
 * 历史上这里先后有两套覆盖参数：地图取景预览里的四个相对位移滑块、发布设置
 * 里的四边间距输入框，叠加出一个比核心区大一圈的取景矩形，预览里因此出现
 * 「文字边界」与「地图形状边界」两个框。那两条链路都已删除。现在只剩一组
 * 绝对边界值：`/api/framing/preview` 与 `/api/generate` 都经过本函数，
 * 预览响应也原样回传这份 safeArea，页面只画核心区那一个框。
 */

/**
 * 三行读数的排版标尺，与渲染端同源（`src/video/layout/labelPlacement.ts`）。
 * 预览页只拿这份数字，不自己写字号——网页与成片因此不会出现「字号/行距不一样」。
 */
const labelStyle = () => {
  const p = labelPlacementModule;
  return {
    font: p ? {...p.LABEL_FONT_SIZE} : {rank: 18, name: 27, value: 20},
    baseline: p ? {...p.LABEL_BASELINE} : {rank: 26, name: 57, value: 84},
    box: p ? {...p.LABEL_BOX} : {width: 230, height: 92},
    ink: themeModule?.theme?.text ?? "#203027",
    halo: p ? p.LABEL_HALO.color : "#FFFFFF",
    haloWidth: p ? p.LABEL_HALO.width : 6,
    // 拖拽上限：预览页用它判断「拖飞了」并弹回原位，与渲染端同一个数。
    maxOffset: p ? p.MAX_MANUAL_OFFSET_PX : 150,
  };
};

/**
 * 排名读数的真实落位：与 `ThailandMap` 调同一个 `placeLabel`，按**名次顺序**
 * 依次避让（诊断本身就是名次顺序），再叠上手动微调（预览图拖拽）。结果同时
 * 喂给安全区审计和网页预览，所以「拖过界回原位」这条规则在网页与 MP4 里一致。
 *
 * 返回每个府的矩形 + 三行文字，预览直接照着画；审计只取矩形与冲突。
 */
const placeRankingLabels = (viewport, labelOffsets) => {
  if (!labelPlacementModule || !viewport) return [];
  const toRect = (bbox) => ({
    x0: bbox[0][0],
    y0: bbox[0][1],
    x1: bbox[1][0],
    y1: bbox[1][1],
  });
  const offsets = labelPlacementModule.normalizeLabelOffsetMap(labelOffsets);
  const occupied = [];
  return (viewport.diagnostics ?? []).map((diagnostic) => {
    const key = String(diagnostic.provinceId ?? "").trim().toUpperCase();
    const auto = labelPlacementModule.placeLabel({
      bounds: toRect(diagnostic.bboxPx),
      panelBounds: viewport.labelRect,
      keepOut: viewport.keepOutRect ?? null,
      occupied,
    });
    // 避让只认**自动落位**的骨架：先把自动矩形放进 occupied，再叠手动位移。
    // 否则拖动一个读数会改变邻居的占位、把别人的位置一起带跑 —— 手动微调
    // 只该动被拖的那一个；拖出来的重叠由审计如实报出。
    occupied.push(auto.panelRect);
    const placement = labelPlacementModule.applyLabelOffset(auto, offsets[key]);
    return {diagnostic, placement, auto};
  });
};

/**
 * 预览页要画的内容：落位矩形 + 三行文字（`NO.02` / 泰文府名 / 数值）。
 * 文字口径与 `ThailandMap` 一致：`valueLabel` 优先，否则用千分位；单位来自项目。
 *
 * `rect` 是**自动落位**的矩形，`offset` 是叠加在上面的手动位移 —— 网页拖动时
 * 直接用 transform 平移，不再等一次服务端往返；重新打开页面时读同一个 offset。
 */
const rankingLabelsPayload = (viewport, rankings, unit, labelOffsets) => {
  const byId = new Map(
    (Array.isArray(rankings) ? rankings : []).map((row) => [
      String(row?.provinceId ?? "").trim().toUpperCase(),
      row,
    ]),
  );
  return placeRankingLabels(viewport, labelOffsets)
    .map(({diagnostic, placement, auto}) => {
      const row = byId.get(String(diagnostic.provinceId).trim().toUpperCase());
      if (!row) return null;
      const valueText =
        row.valueLabel ??
        (Number.isFinite(Number(row.value))
          ? Number(row.value).toLocaleString()
          : String(row.value ?? ""));
      // 单位：网页表格里每行自己填的 `unit` 优先，没这个字段才回退到项目级
      // `unit`（兼容旧 API 调用）；留空则只有数值。直接跟在数值后面，成片
      // `ThailandMap` 用同一口径拼，预览与 MP4 一字不差。
      const unitText = String(row.unit ?? unit ?? "").trim();
      return {
        provinceId: diagnostic.provinceId,
        rank: row.rank,
        text: {
          rank: `NO.${String(row.rank).padStart(2, "0")}`,
          name: row.provinceTh || row.provinceEn || "",
          value: `${valueText}${unitText ? ` ${unitText}` : ""}`.trim(),
        },
        rect: auto.panelRect,
        offset: placement.manualOffset ?? null,
        conflict: placement.conflict,
      };
    })
    .filter(Boolean);
};

/**
 * Audits where every floating rank label would land, plus the fixed headline
 * blocks, against the resolved safe area.
 *
 * Label positions are derived from `viewport.diagnostics` (the real projected
 * centre of every ranked province in the final viewport) and from the very same
 * `placeLabel` the map component calls — so this is a check of the *actual*
 * layout, not of a second guess. Nothing is silently hidden: every conflict is
 * reported with the element id, its component, the direction and the pixels.
 */
const auditSafeArea = (resolution, viewport, { silent = false, labelOffsets } = {}) => {
  if (!safeAreaModule || !viewport || !resolution) return null;
  const elements = [];

  // Every revealed province keeps its readout on screen, so the audit mirrors the
  // render's placement order. Both sides use **rank order** (diagnostics already
  // come in ranking order, the map sorts by rank): the narration counts down
  // 5 → 1, so reveal order would describe a layout the render never has.
  for (const {diagnostic, placement} of placeRankingLabels(viewport, labelOffsets)) {
    elements.push({
      id: `label:${diagnostic.provinceId}`,
      component: "ThailandMap/placeLabel",
      rect: placement.panelRect,
      // `panel`, not `text`: every revealed province keeps its readout on screen
      // now, so two readouts really can collide in the render — the pairwise
      // overlap check must see them instead of skipping them.
      kind: "panel",
      // Manual drags are part of the layout under audit: if a hand-placed block
      // collides with the rail or a neighbour, that is exactly what the user
      // just did, and the audit should say so instead of checking the auto layout.
      ...(placement.manualOffset ? { manualOffset: placement.manualOffset } : {}),
      conflict: placement.conflict,
    });
  }

  // The fixed headline blocks: their rects mirror the styles the render applies.
  // The title owns no band any more — it is an overlay whose centre sits one
  // third of the way down the core rect, about 110px tall, and it fades out with
  // the opening line. The footer sits just inside the core rect's bottom edge.
  const titleCenterY =
    resolution.coreRect.y0 +
    (resolution.coreRect.y1 - resolution.coreRect.y0) / 3;
  elements.push(
    {
      id: "header:title",
      component: "ThailandRankingVideo/header",
      kind: "text",
      rect: {
        x0: resolution.coreRect.x0,
        y0: titleCenterY - 55,
        x1: resolution.coreRect.x1,
        y1: titleCenterY + 55,
      },
    },
    {
      id: "footer:meta",
      component: "ThailandRankingVideo/footer",
      kind: "text",
      rect: {
        x0: resolution.coreRect.x0,
        y0: resolution.coreRect.y1 - 48,
        x1: resolution.coreRect.x1,
        y1: resolution.coreRect.y1 - 24,
      },
    },
  );

  const audit = safeAreaModule.auditSafeAreaLayout({
    resolution,
    elements,
    labelGapPx: resolution.contentGapPx,
  });

  const labelConflicts = elements.filter((element) => element.conflict);
  // Only real violations (outside the safe area, or inside the action rail)
  // fail the check. Two labels overlapping is reported separately: the video
  // shows one label at a time, so a potential overlap between neighbouring
  // provinces is a hint, not a defect.
  const ok = audit.issues.length === 0;

  if (!silent) {
    labelConflicts.forEach((element) =>
      console.warn(`[safe-area] ${element.conflict.detail}`),
    );
    audit.lines.forEach((line) => console.warn(`[safe-area] ${line}`));
    if (ok) {
      console.log(
        `[safe-area] 布局检查通过：${elements.length} 个元素均在安全区内（右 ${resolution.margins.right}px / 下 ${resolution.margins.bottom}px 已避开）` +
          (audit.overlaps.length
            ? `；另有 ${audit.overlaps.length} 处潜在标签重叠（成片同一时刻只显示一个标签，属提示）`
            : ""),
      );
    }
  }

  return {
    ok,
    platform: audit.platform,
    descriptionTier: audit.descriptionTier,
    issues: audit.issues,
    overlaps: audit.overlaps,
    violatingIds: audit.violatingIds,
    labelConflicts: labelConflicts.map((element) => element.conflict),
    checkedElements: elements.length,
  };
};

/** Compact safe-area summary for the timeline file and the HTTP response. */
const safeAreaSummary = (resolution) =>
  resolution
    ? {
        version: resolution.version,
        provenance: resolution.provenance,
        verified: resolution.verified,
        platform: resolution.platform,
        platformLabel: resolution.platformLabel,
        descriptionTier: resolution.descriptionTier,
        descriptionChars: resolution.descriptionChars,
        margins: resolution.margins,
        bottomSource: resolution.bottomSource,
        contentGapPx: resolution.contentGapPx,
        coreRect: resolution.coreRect,
        labelRect: resolution.labelRect,
        interactiveRect: resolution.interactiveRect,
        interactiveGapRect: resolution.interactiveGapRect,
        mapRect: resolution.mapRect,
        warnings: resolution.warnings,
      }
    : null;

const framingSummary = (viewport) =>
  viewport
    ? {
        mode: viewport.mode,
        requestedMode: viewport.requestedMode,
        preset: viewport.preset,
        coverageThreshold: viewport.coverageThreshold,
        allowOutlierDrop: viewport.allowOutlierDrop,
        coverage: viewport.coverage,
        coveredCount: viewport.coveredCount,
        totalCount: viewport.totalCount,
        center: viewport.center,
        zoom: viewport.zoom,
        referenceZoom: viewport.referenceZoom,
        cameraMove: viewport.cameraMove,
        contextFloor: viewport.contextFloor,
        contextFloorApplied: viewport.contextFloorApplied,
        countryLonSpan: viewport.countryLonSpan,
        visibleLonSpan: viewport.visibleLonSpan,
        keptIds: viewport.keptIds,
        droppedIds: viewport.droppedIds,
        missingIds: viewport.missingIds,
        warnings: viewport.warnings,
      }
    : null;

const wavDuration = (file) => {
  const buffer = fs.readFileSync(file);
  const byteRate = buffer.readUInt32LE(28);
  const dataTag = buffer.indexOf(Buffer.from("data"));
  if (dataTag < 0 || !byteRate) throw new Error("Request failed");
  return buffer.readUInt32LE(dataTag + 4) / byteRate;
};

const insertAudioGaps = async ({
  input,
  output,
  duration,
  gap,
  items,
  run,
  remotionCli,
}) => {
  if (!gap || gap <= 0 || items.length < 2) return input;

  const totalCharacters =
    items.reduce((sum, item) => sum + item.text.length, 0) || 1;

  const spokenDurations = items.map(
    (item) => (duration * item.text.length) / totalCharacters,
  );

  const filters = [];
  const concatInputs = [];
  let cursor = 0;

  spokenDurations.forEach((segmentDuration, index) => {
    const audioLabel = `a${index}`;

    filters.push(
      `[0:a]atrim=start=${cursor}:end=${cursor + segmentDuration},` +
        `asetpts=PTS-STARTPTS[${audioLabel}]`,
    );
    concatInputs.push(`[${audioLabel}]`);

    cursor += segmentDuration;

    if (index < spokenDurations.length - 1) {
      const silenceLabel = `s${index}`;

      filters.push(`anullsrc=r=24000:cl=mono:d=${gap}[${silenceLabel}]`);
      concatInputs.push(`[${silenceLabel}]`);
    }
  });

  const filterComplex =
    `${filters.join(";")};` +
    `${concatInputs.join("")}concat=n=${concatInputs.length}:v=0:a=1[out]`;

  await run(process.execPath, [
    remotionCli,
    "ffmpeg",
    "-y",
    "-i",
    input,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    output,
  ]);

  return output;
};

const muxAudioIntoVideo = async ({ videoInput, audioInput, output, muxDuration }) => {
  await run(process.execPath, [
    remotionCli,
    "ffmpeg",
    "-y",
    "-i",
    videoInput,
    "-i",
    audioInput,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    // The video runs `finalHoldSeconds` past the narration so the last province
    // stays visible; pad the audio to exactly the video length. A bare `apad`
    // pads forever and deadlocks `-shortest` (the muxer then never finalises
    // the mp4), so the pad gets an explicit whole duration instead.
    "-af",
    `apad=whole_dur=${muxDuration}`,
    output,
  ]);
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON request"));
      }
    });
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url ?? "/", "http://localhost").pathname,
  );

  if (req.method === "GET" && pathname === "/api/tts/speakers") {
    try {
      const output = await runPowerShell(
        path.join(root, "scripts", "tts-speakers.ps1"),
      );
      // ConvertTo-Json emits a bare object when only one voice is installed.
      const parsed = output ? JSON.parse(output) : [];
      const voices = Array.isArray(parsed) ? parsed : [parsed];
      json(res, 200, { engine: "sapi", voices });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/tts/engines") {
    try {
      json(res, 200, await ttsRegistry.describe());
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  const modelsMatch = pathname.match(/^\/api\/tts\/engines\/([^/]+)\/models$/);
  if (req.method === "GET" && modelsMatch) {
    const engine = ttsRegistry.get(modelsMatch[1]);
    if (!engine)
      return json(res, 404, {
        error: { code: "UNKNOWN_ENGINE", message: "Unknown TTS engine" },
      });
    return json(res, 200, engine.descriptor.models);
  }

  const capabilitiesMatch = pathname.match(
    /^\/api\/tts\/models\/([^/]+)\/capabilities$/,
  );
  if (req.method === "GET" && capabilitiesMatch) {
    const model = ttsRegistry.getModel(capabilitiesMatch[1]);
    if (!model)
      return json(res, 404, {
        error: { code: "UNKNOWN_MODEL", message: "Unknown TTS model" },
      });
    return json(res, 200, model.capabilities);
  }

  const modelVoicesMatch = pathname.match(
    /^\/api\/tts\/models\/([^/]+)\/voices$/,
  );
  if (req.method === "GET" && modelVoicesMatch) {
    try {
      const modelId = modelVoicesMatch[1];
      const descriptor = ttsRegistry
        .listDescriptors()
        .find((item) => item.models.some((model) => model.id === modelId));
      const engine = descriptor && ttsRegistry.get(descriptor.id);
      if (!engine)
        throw Object.assign(new Error("Unknown TTS model"), {
          statusCode: 404,
          code: "UNKNOWN_MODEL",
        });
      const language =
        new URL(req.url, "http://localhost").searchParams.get("language") ||
        "auto";
      json(res, 200, await engine.listVoices(modelId, language));
    } catch (error) {
      jsonError(res, error);
    }
    return;
  }

  const voicesMatch = pathname.match(/^\/api\/tts\/engines\/([^/]+)\/voices$/);
  if (req.method === "GET" && voicesMatch) {
    try {
      const engine = ttsRegistry.get(voicesMatch[1]);
      if (!engine) throw new Error("Request failed");
      const language =
        new URL(req.url, "http://localhost").searchParams.get("language") ||
        "auto";
      json(
        res,
        200,
        await engine.listVoices(engine.descriptor.defaultModel, language),
      );
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provinces/resolve") {
    try {
      if (!provinceAuditModule || !provinceGeoJson) {
        throw Object.assign(
          new Error(
            "当前 Node 无法直接执行 TypeScript，府名解析不可用；可直接填府 ID",
          ),
          { statusCode: 501, code: "PROVINCE_LOOKUP_UNAVAILABLE" },
        );
      }
      const body = await readBody(req);
      // The form fills 府 ID / 英文名 / 泰文名 from whichever column the user
      // touched; the fuzzy half of that lives here so the browser does not
      // re-implement (and drift from) the normalisation rules.
      json(
        res,
        200,
        provinceAuditModule.lookupProvince(provinceGeoJson, body.value),
      );
    } catch (error) {
      jsonError(res, error);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/framing/preview") {
    try {
      if (!framingModule || !provinceGeoJson) {
        throw Object.assign(
          new Error(
            "当前 Node 无法直接执行 TypeScript，取景预览不可用；生成流程不受影响",
          ),
          { statusCode: 501, code: "FRAMING_UNAVAILABLE" },
        );
      }
      const body = await readBody(req);
      const { options } = framingModule.normalizeFramingOptions(body.framing);
      // 取景矩形由四分区直接派生（mapRect === coreRect）：这份 safeArea 既
      // 参与取景计算，也原样回给前端 —— 面板读数与遮罩都用它。
      const safeArea = resolveSafeAreaFor(body, { silent: true });
      const viewport = framingModule.resolveViewport(
        provinceGeoJson,
        (Array.isArray(body.rankings) ? body.rankings : []).map(
          (row) => row?.provinceId,
        ),
        // Raw options on purpose: `resolveViewport` validates them and merges the
        // validation warnings into `viewport.warnings`, so nothing is swallowed.
        body.framing,
        framingModule.MAP_STAGE,
        safeArea
          ? {
              mapRect: safeArea.mapRect,
              labelRect: safeArea.labelRect,
              keepOutRect: safeArea.interactiveGapRect,
            }
          : undefined,
      );
      const labelAudit = auditSafeArea(safeArea, viewport, {
        silent: true,
        labelOffsets: body.labelOffsets,
      });
      // Opening position of the intro camera move: the whole country, resolved
      // with the same options the render uses (only `fitMode` is overridden), so
      // the preview can show both ends of the move instead of guessing.
      const introViewport = framingModule.resolveViewport(
        provinceGeoJson,
        (Array.isArray(body.rankings) ? body.rankings : []).map(
          (row) => row?.provinceId,
        ),
        { ...(body.framing ?? {}), fitMode: "full-country" },
        framingModule.MAP_STAGE,
        safeArea
          ? {
              mapRect: safeArea.mapRect,
              labelRect: safeArea.labelRect,
              keepOutRect: safeArea.interactiveGapRect,
            }
          : undefined,
      );
      // Path data is produced by the same projection the render uses, so what
      // the browser draws is pixel-for-pixel what Remotion will draw.
      json(res, 200, {
        options,
        viewport,
        introViewport: framingSummary(introViewport),
        paths: framingModule.projectFeatures(viewport, provinceGeoJson),
        safeArea,
        labelAudit,
        // 排名读数：网页预览按这份矩形 + 文案把三行字画在府上，字号/基线也来自
        // 服务端（`labelStyle`），所以预览看到的就是成片的版面。手动拖拽的偏移
        // 原样回传（`labelOffsets`），刷新页面后读数还停在拖过的位置。
        labels: rankingLabelsPayload(
          viewport,
          body.rankings,
          body.unit,
          body.labelOffsets,
        ),
        labelOffsets: labelPlacementModule
          ? labelPlacementModule.normalizeLabelOffsetMap(body.labelOffsets)
          : {},
        labelStyle: labelStyle(),
        // The full province list (id + 英文名 + 泰文名) feeds the 府 ID picker and
        // the name columns in the UI, so none of the three is ever typed from
        // memory, and choosing any one of them fills the other two.
        provinces:
          provinceAuditModule && provinceGeoJson
            ? provinceAuditModule.listProvinces(provinceGeoJson)
            : [],
        // Silent here on purpose: the preview runs while typing, the generation
        // path is the one that writes the log.
        audit:
          provinceAuditModule && provinceGeoJson
            ? provinceAuditModule.auditRankings(provinceGeoJson, body.rankings)
            : null,
      });
    } catch (error) {
      jsonError(res, error);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/generate") {
    try {
      const body = await readBody(req);
      const ttsRequest = normalizeTtsRequest(body);
      if (!ttsRequest.text) throw new Error("TTS text cannot be empty");
      if (!Array.isArray(body.rankings) || !body.rankings.length)
        throw new Error("Request failed");

      // The id/name check runs first: a row that points at province A while
      // naming province B would otherwise render a perfectly valid — and
      // completely wrong — highlight.
      const provinceAudit = auditProvinces(body.rankings);
      if (
        body.strictNaming === true &&
        provinceAudit &&
        provinceAudit.mismatched.length
      ) {
        throw Object.assign(
          new Error(
            `provinceId 与名称不一致，已按 strictNaming 拒绝生成：${provinceAudit.mismatched
              .map(
                (item) =>
                  `${item.provinceId}=${item.geoName}（填的是 ${item.givenName}${
                    item.suggestedIds.length
                      ? `，应为 ${item.suggestedIds.join('/')}`
                      : ''
                  }）`,
              )
              .join("；")}`,
          ),
          { statusCode: 400, code: "PROVINCE_NAME_MISMATCH" },
        );
      }

      // The platform safe area is resolved first: it depends on the publish
      // description (a request field), not on anything the render computes, and
      // it feeds the static viewport below.
      // 与 /api/framing/preview 用同一个派生函数：取景矩形就是核心区，
      // MP4 与预览构图完全一致，没有可漂移的独立参数。
      const safeArea = resolveSafeAreaFor(body);

      // The static viewport is resolved once, from the complete ranking set and
      // before any render work starts, then held for the whole video. Resolving
      // it here also writes the framing log (including every region that ends up
      // outside the frame).
      const viewport = resolveFraming(body.rankings, body.framing, safeArea);
      const safeAreaAudit = auditSafeArea(safeArea, viewport, {
        labelOffsets: body.labelOffsets,
      });

      const outputName = safeName(body.outputName);
      const wavPath = path.join(generatedDir, `${outputName}.wav`);
      const timelinePath = path.join(
        generatedDir,
        `${outputName}.timeline.json`,
      );
      const mp4Path = path.join(generatedDir, `${outputName}.mp4`);
      const textPath = path.join(generatedDir, `${outputName}.txt`);
      fs.writeFileSync(textPath, ttsRequest.text, "utf8");

      const engineId = String(
        body.ttsEngine || ttsConfig.defaultEngine || "edge",
      );
      const descriptor = ttsRegistry.get(engineId)?.descriptor;
      const unifiedRequest = normalizeUnifiedTtsRequest(body, {
        engineId,
        modelId: descriptor?.defaultModel,
        voiceId: descriptor?.defaultVoice,
      });
      const { engine } = await validateTtsRequest(ttsRegistry, unifiedRequest);
      await engine.synthesize({
        ...ttsRequest,
        language: unifiedRequest.language,
        voice: unifiedRequest.voiceId,
        model: unifiedRequest.modelId,
        speed: unifiedRequest.controls.speed,
        format: unifiedRequest.output.format,
        textPath,
        output: wavPath,
      });

      const sourceDuration = wavDuration(wavPath);
      const fps = Math.max(1, Number(body.fps) || 30);
      const gap = Math.max(0, Number(body.gap) || 0);
      const { width, height } = parseResolution(body.resolution);
      const opening = String(body.opening || "").trim();
      const ranked = body.rankings.slice().sort((a, b) => b.rank - a.rank);
      // The script is the ground truth for the timeline: it is literally what the
      // engine speaks. Reading its real lines (rather than re-deriving them from
      // a template) is what keeps the highlight on the voice — the per-line audio
      // slicing and the rank/name boundary are both measured in the spoken text.
      // A script that no longer lines up with the ranking table (hand-edited, or
      // missing/extra lines) is ignored and the generated lines are used instead.
      const scriptLines = narrationModule
        ? narrationModule.alignScriptLines(
            body.script,
            (opening ? 1 : 0) + ranked.length,
          )
        : null;
      const lineAt = (index) => (scriptLines ? scriptLines[index] : undefined);
      const lineOffset = opening ? 1 : 0;
      // One item is one gap-delimited block of audio. A ranking item carries the
      // two `parts` it is spoken in, and each part becomes its own timeline
      // segment below, so the map can light the province as its name is voiced
      // instead of waiting for the whole line to be read out.
      const items = [
        ...(opening ? [{ type: "opening", text: lineAt(0) || opening }] : []),
        ...ranked.map((ranking, index) => {
          const narration = narrationModule
            ? narrationModule.buildRankingNarration(
                ranking,
                lineAt(lineOffset + index),
              )
            : null;
          const parts = narration?.parts ?? [
            { part: "rank", text: `Rank ${ranking.rank}: ` },
            {
              part: "name",
              text: `${ranking.provinceTh || ranking.provinceEn} (${ranking.provinceEn}), ${Number(ranking.value).toLocaleString()}`,
            },
          ];
          return {
            type: "ranking",
            rank: ranking.rank,
            provinceId: ranking.provinceId,
            provinceEn: ranking.provinceEn,
            provinceTh: ranking.provinceTh,
            parts,
            text: narration?.text ?? parts.map((part) => part.text).join(""),
          };
        }),
      ];
      const totalCharacters =
        items.reduce((sum, item) => sum + item.text.length, 0) || 1;
      const duration = sourceDuration;
      const spokenDuration = Math.max(0, sourceDuration);
      // Each item keeps its share of the synthesized audio; inside an item the
      // parts split that share by their own text length. The silence only lands
      // on the last part, so it still separates provinces and never interrupts
      // a line (the audio itself is only sliced per item — see insertAudioGaps).
      let cursor = 0;
      const segments = [];
      items.forEach((item, index) => {
        const spoken = (spokenDuration * item.text.length) / totalCharacters;
        const { parts, ...head } = item;
        const pieces = parts ?? [{ text: item.text }];
        const piecesCharacters =
          pieces.reduce((sum, piece) => sum + piece.text.length, 0) || 1;
        let pieceCursor = cursor;

        pieces.forEach((piece, pieceIndex) => {
          const pieceDuration = (spoken * piece.text.length) / piecesCharacters;
          segments.push({
            ...head,
            ...(piece.part ? { part: piece.part } : {}),
            text: piece.text,
            start: +pieceCursor.toFixed(3),
            duration: +pieceDuration.toFixed(3),
            gapAfter:
              pieceIndex === pieces.length - 1 && index < items.length - 1
                ? gap
                : 0,
          });
          pieceCursor += pieceDuration;
        });

        cursor += spoken + (index < items.length - 1 ? gap : 0);
      });
      // The readouts now show one at a time and only the closing beat presents
      // the complete ranking, so that final shot needs real reading time: it
      // used to get the inter-line gap (~1.5s) because earlier the numbers had
      // already accumulated on screen. `finaleHoldSeconds` scales with the
      // number of provinces (5 → 4.5s, capped at 8s) and never goes below the
      // per-line gap, so the #1 reveal is always visible for a beat.
      const finaleHold =
        Number.isFinite(Number(body.finaleHold)) && body.finaleHold !== undefined && body.finaleHold !== null && body.finaleHold !== ""
          ? Math.max(0, Number(body.finaleHold))
          : (timelineModule?.finaleHoldSeconds?.(ranked.length) ?? 1.5);
      const finalHoldSeconds = Math.max(gap, finaleHold);
      // The closing shot is preceded by a silent beat (readouts leave → empty map
      // → whole ranking returns), which is added on top of the reading time so
      // the pause never shortens the hold. Same constant the timeline uses, so
      // the muxed audio and the composition report the same length.
      const finalePauseSeconds = timelineModule?.FINALE_PAUSE_SECONDS ?? 0.6;
      const totalDuration = +(
        sourceDuration +
        gap * Math.max(0, items.length - 1)
      ).toFixed(3);
      const videoDuration = +(
        totalDuration +
        finalePauseSeconds +
        finalHoldSeconds
      ).toFixed(3);

      // The map lights a province when its *name* is voiced — the rank piece has
      // just been read out and the voice moves onto the province — so the
      // animation window opens at the start of the `name` piece. Everything else
      // (the opening line and the rank piece) only reveals at its own end, where
      // there is nothing to light.
      const revealAt = segments.map((segment) =>
        segment.part === "name"
          ? segment.start
          : segment.start + segment.duration,
      );
      segments.forEach((segment, index) => {
        const nextReveal =
          index + 1 < revealAt.length ? revealAt[index + 1] : videoDuration;
        segment.mapAnimationStart = +revealAt[index].toFixed(3);
        segment.mapAnimationDuration = +Math.max(
          0,
          nextReveal - revealAt[index],
        ).toFixed(3);
      });

      const totalFrames = Math.ceil(videoDuration * fps);

      // The title header is an intro card: it leaves the stage once the opening
      // line has been spoken (`0` when there is no opening line to wait for).
      const titleEnd =
        segments[0]?.type === "opening"
          ? +(segments[0].start + segments[0].duration).toFixed(3)
          : 0;

      // The intro camera move: it starts `CAMERA_START_DELAY_SECONDS` after the
      // video begins and lands the instant the *first* ranking line has read out
      // its rank ("อันดับ 5"), so the province name is spoken in front of a
      // standing camera. A rank piece has no highlight of its own, which is why
      // its end (`start + duration`, silence excluded) is the landing beat.
      // `CAMERA_END_SECONDS` (when set) pins the landing beat to an absolute time
      // instead. Recorded in the timeline so a rendered MP4 can be traced back to
      // its camera path.
      const cameraDelay = Math.max(0, CAMERA_START_DELAY_SECONDS);
      const firstRankSegment = segments.find(
        (segment) => segment.part === "rank",
      );
      const automaticLandSeconds = firstRankSegment
        ? firstRankSegment.start + firstRankSegment.duration
        : segments[0]?.type === "opening"
          ? segments[0].start + segments[0].duration
          : 0;
      const cameraLandSeconds =
        typeof CAMERA_END_SECONDS === "number" &&
        Number.isFinite(CAMERA_END_SECONDS)
          ? Math.max(CAMERA_END_SECONDS, cameraDelay + 1 / fps)
          : automaticLandSeconds;
      const cameraMove =
        viewport?.cameraMove !== false && cameraLandSeconds > 0
          ? {
              enabled: true,
              // Keep a beat of travel when the rank is announced faster than the
              // delay (mirrors `CAMERA_MIN_FRAMES` in the timeline module).
              start: +Math.min(
                cameraDelay,
                Math.max(0, cameraLandSeconds - 6 / fps),
              ).toFixed(3),
              end: +cameraLandSeconds.toFixed(3),
            }
          : { enabled: false, start: 0, end: 0 };

      const timeline = {
        title: body.title,
        outputName,
        fps,
        width,
        height,
        resolution: `${width}x${height}`,
        ttsEngine: engineId,
        language: ttsRequest.language,
        voice: ttsRequest.voice,
        speed: ttsRequest.speed,
        format: ttsRequest.format,
        speaker: ttsRequest.voice,
        targetSpeechDuration: ttsRequest.targetSeconds,
        ttsModel: ttsRequest.model,
        gap,
        // Seconds of narrated audio; the rendered video is `finalHoldSeconds`
        // longer so the last province stays on screen after its reveal.
        audioDuration: totalDuration,
        finalHoldSeconds,
        totalDuration: videoDuration,
        totalFrames,
        titleEnd,
        cameraMove,
        framing: viewport
          ? {
              // Raw options plus the values that actually took effect: without
              // `allowOutlierDrop`, a stale `coverageThreshold: 0.9` is clamped
              // to 1, and the audit file must not suggest otherwise.
              options: {
                ...(body.framing ?? {}),
                coverageThreshold: viewport.coverageThreshold,
                allowOutlierDrop: viewport.allowOutlierDrop,
              },
              viewport: framingSummary(viewport),
            }
          : undefined,
        provinceAudit: provinceAudit ?? undefined,
        // Platform UI safe area used for this render: margins, tiers, the four
        // rectangles and every compatibility warning, so a timeline file alone is
        // enough to reproduce (and audit) the layout.
        safeArea: safeAreaSummary(safeArea) ?? undefined,
        safeAreaAudit: safeAreaAudit ?? undefined,
        // 手动微调记录：哪个府的读数被拖到哪里，时间轴文件里可追溯。
        labelOffsets: labelPlacementModule
          ? labelPlacementModule.normalizeLabelOffsetMap(body.labelOffsets)
          : undefined,
        segments,
      };
      fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");

      const gappedWavPath = path.join(generatedDir, `${outputName}.gapped.wav`);

      await insertAudioGaps({
        input: wavPath,
        output: gappedWavPath,
        duration,
        gap,
        items,
        run,
        remotionCli,
      });

      const renderPropsPath = path.join(
        generatedDir,
        `${outputName}.props.json`,
      );

      const renderProps = {
        project: {
          title: String(body.title || ""),
          subtitle: "",
          // 项目级单位只作兜底：网页表格里每行自定义的单位在 rankings 里，
          // 由 ThailandMap 优先取用。外部 API 只传顶层 unit 时仍然生效。
          unit: String(body.unit ?? ""),
          locale: "th",
          rankings: body.rankings,
          // The opening line is narrated, so it lives in audioSegments rather
          // than being a silent intro card.
          introDuration: 0,
          // Keeps the last province on screen after its reveal instead of
          // cutting the video the instant its narration ends.
          finalHoldDuration: finalHoldSeconds,
          audioSrc: "",
          fps,
          width,
          height,
          // Drives the video timeline from the real audio segments. Without
          // this the render fell back to the default 3.2s per province and
          // ffmpeg -shortest silently truncated the narration.
          audioSegments: segments.map((segment) => ({
            type: segment.type,
            ...(segment.type === "ranking" ? { rank: segment.rank } : {}),
            ...(segment.part ? { part: segment.part } : {}),
            duration: segment.duration,
            gapAfter: segment.gapAfter,
          })),
          // Same raw options as everywhere else: the framing module inside the
          // bundle validates them exactly like the server just did, so preview
          // and MP4 resolve to the identical viewport.
          framing: body.framing ?? {},
          // The resolved safe area travels with the props: the render consumes
          // these exact rectangles instead of re-deriving them, so the MP4 can
          // never disagree with the preview.
          platform: safeArea?.platform ?? undefined,
          safeArea: safeArea ?? undefined,
          // 预览图里手动拖拽过的读数位移，随生成请求一起进渲染 props：
          // `ThailandMap` 用同一个 `applyLabelOffset` 叠在自动落位上，所以 MP4
          // 与预览逐像素一致；超出上限的偏移在规整时就被丢弃（= 回自动落位）。
          labelOffsets: labelPlacementModule
            ? labelPlacementModule.normalizeLabelOffsetMap(body.labelOffsets)
            : undefined,
          // NOTE: `debugSafeArea` is deliberately **not** set here. The
          // development overlay only draws when the props explicitly ask for it,
          // so an exported MP4 can never contain the safe-area mask or labels.
        },
      };

      fs.writeFileSync(
        renderPropsPath,
        JSON.stringify(renderProps, null, 2),
        "utf8",
      );

      const sourceMp4 = path.join(generatedDir, `${outputName}.video.mp4`);

      await run(process.execPath, [
        remotionCli,
        "render",
        path.join(root, "src", "index.ts"),
        "ThailandProvinceRanking",
        sourceMp4,
        `--props=${renderPropsPath}`,
        `--fps=${fps}`,
        `--width=${width}`,
        `--height=${height}`,
      ]);

      await muxAudioIntoVideo({
        videoInput: sourceMp4,
        audioInput: gappedWavPath,
        output: mp4Path,
        // Exact length of the rendered video (totalFrames frames), so the
        // padded audio ends together with the last frame.
        muxDuration: +(totalFrames / fps).toFixed(3),
      });

      json(res, 200, {
        duration,
        // The rendered video, including the final hold — this is what the UI
        // reports and what the download actually plays.
        totalDuration: videoDuration,
        totalFrames,
        resolution: `${width}x${height}`,
        fps,
        framing: framingSummary(viewport),
        safeArea: safeAreaSummary(safeArea),
        safeAreaAudit: safeAreaAudit,
        // 这次成片实际采用的手动微调（规整后），UI 用它提示「已生效 N 处」。
        labelOffsets: labelPlacementModule
          ? labelPlacementModule.normalizeLabelOffsetMap(body.labelOffsets)
          : {},
        // `mismatched` is the actionable part; the UI turns it into a per-row
        // hint plus a one-click fix.
        provinceAudit: provinceAudit
          ? {
              mismatched: provinceAudit.mismatched,
              unknownIds: provinceAudit.unknownIds,
              duplicateIds: provinceAudit.duplicateIds,
              warnings: provinceAudit.warnings,
            }
          : null,
        files: {
          wav: `/out/generated/${outputName}.wav`,
          timeline: `/out/generated/${outputName}.timeline.json`,
          mp4: `/out/generated/${outputName}.mp4`,
        },
        names: {
          wav: `${outputName}.wav`,
          timeline: `${outputName}.timeline.json`,
          mp4: `${outputName}.mp4`,
        },
      });
    } catch (error) {
      jsonError(res, error);
    }
    return;
  }

  const relative =
    pathname === "/"
      ? "public/index.html"
      : pathname.startsWith("/out/")
        ? pathname.slice(1)
        : `public${pathname}`;
  const file = path.resolve(root, relative);
  if (
    !file.startsWith(root) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
    // 开发页禁缓存：页面/脚本改动后普通刷新立即生效，避免浏览器沿用
    // 旧版 index.html（旧请求体缺字段会导致新控件"改了没反应"）。
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => console.log(`Web UI: http://localhost:${port}`));
