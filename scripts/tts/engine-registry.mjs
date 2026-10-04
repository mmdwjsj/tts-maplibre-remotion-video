import fs from "node:fs";
import path from "node:path";
import { EdgeTTS } from "@travisvn/edge-tts";
import { normalizeToWav, writeAudioResponse } from "./audio.mjs";

const timeoutMs = Math.max(
  5_000,
  Number(process.env.TTS_TIMEOUT_MS) || 120_000,
);
const healthTimeoutMs = Math.max(
  500,
  Number(process.env.TTS_HEALTH_TIMEOUT_MS) || 1_500,
);

const withTimeout = async (promise, milliseconds, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const edgeVoices = [
  {
    id: "th-TH-PremwadeeNeural",
    name: "Premwadee (Thai female)",
    culture: "th-TH",
  },
  { id: "th-TH-NiwatNeural", name: "Niwat (Thai male)", culture: "th-TH" },
];

const selectVoiceForLanguage = (voices, language, requestedVoice) => {
  if (requestedVoice) return requestedVoice;
  if (!language || language === "auto") return voices[0]?.id;
  return voices.find((item) => String(item.culture || "").toLowerCase().startsWith(language.toLowerCase()))?.id || voices[0]?.id;
};

const createEdgeEngine = ({ run, remotionCli }) => ({
  id: "edge",
  name: "Microsoft Edge TTS",
  kind: "cloud",
  configured: true,
  async health() {
    return { available: true };
  },
  async listVoices() {
    return edgeVoices;
  },
  async synthesize({ text, language, voice, targetSeconds, speed = 1, output }) {
    const paragraphs = Math.max(
      1,
      text.split(/\n\s*\n/).filter(Boolean).length,
    );
    const estimatedSeconds = Math.max(0.5, text.length / 12);
    const desiredSeconds = Math.max(0.5, targetSeconds * paragraphs);
    const automaticRate = Math.round((estimatedSeconds / desiredSeconds - 1) * 100);
    const ratePercent = Math.max(-50, Math.min(100, Math.round((Number(speed) - 1) * 100 + automaticRate)));
    const tts = new EdgeTTS(text, selectVoiceForLanguage(edgeVoices, language, voice), {
      rate: `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`,
      connectionTimeout: Math.min(timeoutMs, 30_000),
    });
    const result = await withTimeout(tts.synthesize(), timeoutMs, "Edge TTS");
    const source = `${output}.source.mp3`;
    fs.writeFileSync(source, Buffer.from(await result.audio.arrayBuffer()));
    await normalizeToWav({ input: source, output, run, remotionCli });
  },
});

const createSapiEngine = ({ runPowerShell, root }) => ({
  id: "sapi",
  name: "Windows SAPI",
  kind: "local",
  configured: process.platform === "win32",
  async health() {
    return { available: process.platform === "win32" };
  },
  async listVoices() {
    const output = await runPowerShell(
      path.join(root, "scripts", "tts-speakers.ps1"),
    );
    const voices = output ? JSON.parse(output) : [];
    return Array.isArray(voices) ? voices : [voices];
  },
  async synthesize({ textPath, voice, targetSeconds, speed = 1, output }) {
    await runPowerShell(
      path.join(root, "scripts", "synthesize-wav.ps1"),
      [
        "-TextPath",
        textPath,
        "-OutputPath",
        output,
        "-VoiceName",
        voice || "",
        "-TargetSeconds",
        String(targetSeconds),
        "-Rate",
        String(Math.max(-10, Math.min(10, Math.round((Number(speed) - 1) * 10)))),
      ],
      timeoutMs,
    );
  },
});

const createHttpEngine = ({
  id,
  name,
  envPrefix,
  defaults,
  run,
  remotionCli,
  engineConfig = {},
}) => {
  const baseUrl = String(
    process.env[`${envPrefix}_BASE_URL`] || engineConfig.baseUrl || "",
  ).replace(/\/$/, "");

  const speechPath =
    process.env[`${envPrefix}_SPEECH_PATH`] ||
    engineConfig.speechPath ||
    "/v1/audio/speech";

  const model =
    process.env[`${envPrefix}_MODEL`] ||
    engineConfig.defaultModel ||
    defaults.model;
  const configuredVoices =
    process.env[`${envPrefix}_VOICES`] ||
    engineConfig.voices ||
    defaults.voices;
  const voices = (
    Array.isArray(configuredVoices)
      ? configuredVoices
      : String(configuredVoices).split(",")
  ).map((voice) =>
    typeof voice === "string"
      ? {
          id: voice.trim(),
          name: voice.trim(),
          culture: "default",
        }
      : voice,
  );

  const enabled =
    engineConfig.enabled === true ||
    Boolean(process.env[`${envPrefix}_BASE_URL`]);

  const apiKey =
    process.env[`${envPrefix}_API_KEY`] || engineConfig.apiKey || "";

  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  return {
    id,
    name,
    kind: "local-http",
    configured: enabled && Boolean(baseUrl),
    async health() {
      if (!enabled) {
        return {
          available: false,
          reason: "Disabled in config/tts.config.json",
        };
      }

      if (!baseUrl)
        return {
          available: false,
          reason: `${envPrefix}_BASE_URL is not configured`,
        };
      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          headers,
          signal: AbortSignal.timeout(healthTimeoutMs),
        });
        return {
          available: response.ok,
          reason: response.ok ? undefined : `HTTP ${response.status}`,
        };
      } catch (error) {
        return { available: false, reason: error.message };
      }
    },
    async listVoices() {
      return voices;
    },
    async synthesize({ text, language, model: selectedModel, voice, speed, format, output }) {
      if (!baseUrl)
        throw new Error(
          `${name} is not configured. Set ${envPrefix}_BASE_URL.`,
        );
      const response = await fetch(`${baseUrl}${speechPath}`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: selectedModel || model,
          input: text,
          voice: voice || engineConfig.defaultVoice || voices[0]?.id,
          response_format: format || "wav",
          ...(language && language !== "auto" ? { language } : {}),
          speed: speed || 1,
        }),
      });
      await writeAudioResponse({ response, output, run, remotionCli });
    },
  };
};

export const createTtsRegistry = (dependencies) => {
  const config = dependencies.config || { defaultEngine: "edge", engines: {} };
  const getEngineConfig = (id) => config.engines[id] || {};
  const engines = [
    createEdgeEngine(dependencies),
    createSapiEngine(dependencies),
    createHttpEngine({
      id: "voxcpm2",
      name: "VoxCPM 2",
      envPrefix: "VOXCPM2",
      defaults: { model: "voxcpm2", voices: "default" },
      engineConfig: getEngineConfig("voxcpm2"),
      ...dependencies,
    }),
    createHttpEngine({
      id: "moss-tts",
      name: "MOSS-TTS",
      envPrefix: "MOSS_TTS",
      defaults: { model: "moss-tts", voices: "default" },
      engineConfig: getEngineConfig("moss-tts"),
      ...dependencies,
    }),
    createHttpEngine({
      id: "kokoro",
      name: "Kokoro",
      envPrefix: "KOKORO",
      defaults: { model: "kokoro", voices: "af_heart" },
      engineConfig: getEngineConfig("kokoro"),
      ...dependencies,
    }),
    createHttpEngine({
      id: "sakthai",
      name: "SakThai",
      envPrefix: "SAKTHAI",
      defaults: { model: "sakthai", voices: "default" },
      engineConfig: getEngineConfig("sakthai"),
      ...dependencies,
    }),
  ];
  const byId = new Map(engines.map((engine) => [engine.id, engine]));
  return {
    get: (id) => byId.get(id),
    describe: () =>
      Promise.all(
        engines.map(async (engine) => ({
          id: engine.id,
          name: engine.name,
          kind: engine.kind,
          configured: engine.configured,
          ...(await engine.health()),
        })),
      ),
  };
};


