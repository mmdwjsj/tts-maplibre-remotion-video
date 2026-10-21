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
    `[safe-area] 无法加载标签落位模块，标签安全区审计不可用：${error.message}`,
  );
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
 * Audits where every floating rank label would land, plus the fixed headline
 * blocks, against the resolved safe area.
 *
 * Label positions are derived from `viewport.diagnostics` (the real projected
 * centre of every ranked province in the final viewport) and from the very same
 * `placeLabel` the map component calls — so this is a check of the *actual*
 * layout, not of a second guess. Nothing is silently hidden: every conflict is
 * reported with the element id, its component, the direction and the pixels.
 */
const auditSafeArea = (resolution, viewport, { silent = false } = {}) => {
  if (!safeAreaModule || !viewport || !resolution) return null;
  const elements = [];

  if (labelPlacementModule) {
    for (const diagnostic of viewport.diagnostics ?? []) {
      const placement = labelPlacementModule.placeLabel({
        cx: diagnostic.center[0],
        cy: diagnostic.center[1],
        rect: viewport.mapRect ?? viewport.rect,
        panelBounds: viewport.labelRect,
        keepOut: viewport.keepOutRect ?? null,
      });
      elements.push({
        id: `label:${diagnostic.provinceId}`,
        component: "ThailandMap/placeLabel",
        rect: placement.panelRect,
        kind: "panel",
        conflict: placement.conflict,
      });
    }
  }

  // The fixed headline blocks: their rects mirror the styles the render applies
  // (header pinned to the top of the core rect, footer just inside its bottom).
  elements.push(
    {
      id: "header:title",
      component: "ThailandRankingVideo/header",
      kind: "text",
      rect: {
        x0: resolution.coreRect.x0,
        y0: resolution.coreRect.y0 + 24,
        x1: resolution.coreRect.x1,
        y1: resolution.coreRect.y0 + 24 + 110,
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
      const labelAudit = auditSafeArea(safeArea, viewport, { silent: true });
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
      const safeArea = resolveSafeAreaFor(body);

      // The static viewport is resolved once, from the complete ranking set and
      // before any render work starts, then held for the whole video. Resolving
      // it here also writes the framing log (including every region that ends up
      // outside the frame).
      const viewport = resolveFraming(body.rankings, body.framing, safeArea);
      const safeAreaAudit = auditSafeArea(safeArea, viewport);

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
      // With the highlight following the voice, the last province would only be
      // lit for a single frame if the video ended with the audio. Give it the
      // same quiet moment the other provinces get (never shorter than 1.5s, so
      // the #1 reveal is always actually visible).
      const finalHoldSeconds = Math.max(gap, 1.5);
      const totalDuration = +(
        sourceDuration +
        gap * Math.max(0, items.length - 1)
      ).toFixed(3);
      const videoDuration = +(totalDuration + finalHoldSeconds).toFixed(3);

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
          unit: "",
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
  });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => console.log(`Web UI: http://localhost:${port}`));
