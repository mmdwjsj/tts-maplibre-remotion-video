import "./tts/load-env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTtsRegistry } from "./tts/engine-registry.mjs";
import { loadTtsConfig } from "./tts/log-config.mjs";
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

const muxAudioIntoVideo = async ({ videoInput, audioInput, output }) => {
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
    "-shortest",
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

  if (req.method === "POST" && pathname === "/api/generate") {
    try {
      const body = await readBody(req);
      const ttsRequest = normalizeTtsRequest(body);
      if (!ttsRequest.text) throw new Error("TTS text cannot be empty");
      if (!Array.isArray(body.rankings) || !body.rankings.length)
        throw new Error("Request failed");

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
      const items = [
        ...(opening ? [{ type: "opening", text: opening }] : []),
        ...body.rankings
          .slice()
          .sort((a, b) => b.rank - a.rank)
          .map((ranking) => ({
            type: "ranking",
            rank: ranking.rank,
            provinceId: ranking.provinceId,
            provinceEn: ranking.provinceEn,
            provinceTh: ranking.provinceTh,
            text: `Rank ${ranking.rank}: ${ranking.provinceTh || ranking.provinceEn} (${ranking.provinceEn}), ${Number(ranking.value).toLocaleString()}`,
          })),
      ];
      const totalCharacters =
        items.reduce((sum, item) => sum + item.text.length, 0) || 1;
      const duration = sourceDuration;
      const spokenDuration = Math.max(0, sourceDuration);
      let cursor = 0;
      const segments = items.map((item, index) => {
        const segmentDuration =
          (spokenDuration * item.text.length) / totalCharacters;
        const segment = {
          ...item,
          start: +cursor.toFixed(3),
          duration: +segmentDuration.toFixed(3),
          gapAfter: index < items.length - 1 ? gap : 0,
          mapAnimationStart: +cursor.toFixed(3),
          mapAnimationDuration: +segmentDuration.toFixed(3),
        };
        cursor += segmentDuration + (index < items.length - 1 ? gap : 0);
        return segment;
      });
      const totalDuration = +(
        sourceDuration +
        gap * Math.max(0, items.length - 1)
      ).toFixed(3);
      const totalFrames = Math.ceil(
        (sourceDuration + gap * Math.max(0, items.length - 1)) * fps,
      );

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
        totalDuration,
        totalFrames,
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
          finalHoldDuration: 0,
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
            duration: segment.duration,
            gapAfter: segment.gapAfter,
          })),
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
      });

      json(res, 200, {
        duration,
        totalDuration,
        totalFrames,
        resolution: `${width}x${height}`,
        fps,
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
