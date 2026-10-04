import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTtsRegistry } from "./tts/engine-registry.mjs";
import { loadTtsConfig } from "./tts/log-config.mjs";
import { normalizeTtsRequest } from "./tts/request.mjs";

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
const safeName = (value) =>
  String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100) || "thailand-ranking";

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
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON request")); }
    });
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url ?? "/", "http://localhost").pathname,
  );

  if (req.method === "GET" && pathname === "/api/tts/speakers") {
    try {
      const output = await runPowerShell(path.join(root, "scripts", "tts-speakers.ps1"));
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

  const voicesMatch = pathname.match(/^\/api\/tts\/engines\/([^/]+)\/voices$/);
  if (req.method === "GET" && voicesMatch) {
    try {
      const engine = ttsRegistry.get(voicesMatch[1]);
      if (!engine) throw new Error("Request failed");
      json(res, 200, await engine.listVoices());
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
      const engine = ttsRegistry.get(engineId);
      if (!engine) throw new Error(`Unknown TTS engine: ${engineId}`);
      await engine.synthesize({
        ...ttsRequest,
        textPath,
        model: String(body.ttsModel || ""),
        
        targetSeconds: Number(body.speechDuration) || 3,
        
        output: wavPath,
      });

      const duration = wavDuration(wavPath);
      const fps = Math.max(1, Number(body.fps) || 30);
      const gap = Math.max(0, Number(body.gap) || 0);
      const opening = String(body.opening || "").trim();
      const items = [
        ...(opening ? [{ type: "opening", text: opening }] : []),
        ...body.rankings.slice().sort((a, b) => a.rank - b.rank).map((ranking) => ({
          type: "ranking", rank: ranking.rank, provinceId: ranking.provinceId,
          provinceEn: ranking.provinceEn, provinceTh: ranking.provinceTh,
          text: `Rank ${ranking.rank}: ${ranking.provinceTh || ranking.provinceEn} (${ranking.provinceEn}), ${Number(ranking.value).toLocaleString()}`,
        })),
      ];
      const totalCharacters =
        items.reduce((sum, item) => sum + item.text.length, 0) || 1;
      const spokenDuration = Math.max(
        0,
        duration - gap * Math.max(0, items.length - 1),
      );
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
      const timeline = {
        title: body.title,
        outputName,
        fps,
        resolution: body.resolution,
        ttsEngine: engineId,
        language: ttsRequest.language,
        voice: ttsRequest.voice,
        speed: ttsRequest.speed,
        format: ttsRequest.format,
        speaker: ttsRequest.voice,
        targetSpeechDuration: Number(body.speechDuration),
        gap,
        totalDuration: +duration.toFixed(3),
        totalFrames: Math.ceil(duration * fps),
        segments,
      };
      fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2), "utf8");

      const sourceMp4 = path.join(root, "out", "thailand-ranking.mp4");
      if (!fs.existsSync(sourceMp4))
        throw new Error("Request failed");
      await muxAudioIntoVideo({
        videoInput: sourceMp4,
        audioInput: wavPath,
        output: mp4Path,
      });

      json(res, 200, {
        duration,
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
      json(res, 500, { error: error.message });
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





