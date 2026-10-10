import fs from "node:fs";
import path from "node:path";
import { Communicate } from "@travisvn/edge-tts";
import { normalizeToWav, writeAudioResponse } from "./audio.mjs";
import { buildEngineDescriptors } from "./capabilities.mjs";

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

const createEdgeEngine = ({ run,
  remotionCli,
  engineConfig = {},
  config = {}, }) => ({
  id: "edge",
  name: "Microsoft Edge TTS",
  kind: "cloud",
  configured: true,
  async health() {
    return { available: true };
  },
  async listVoices(_modelId, language) {
    if (!language || language === "auto") return edgeVoices;
    return edgeVoices.filter((voice) =>
      voice.culture.toLowerCase().startsWith(language.toLowerCase()),
    );
  },
  async synthesize({ text, language, voice, targetSeconds = 3, speed = 1, output }) {
    const paragraphs = Math.max(
      1,
      text.split(/\n\s*\n/).filter(Boolean).length,
    );
    const estimatedSeconds = Math.max(0.5, text.length / 12);
    const desiredSeconds = Math.max(0.5, targetSeconds * paragraphs);
    const automaticRate = Math.round((estimatedSeconds / desiredSeconds - 1) * 100);
    const ratePercent = Math.max(-50, Math.min(100, Math.round((Number(speed) - 1) * 100 + automaticRate)));
    
    const edgeTimeoutMs = Math.max(
      5_000,
      Number(process.env.EDGE_TTS_TIMEOUT_MS || engineConfig.timeoutMs) ||
      Math.min(config.timeoutMs || timeoutMs, 30_000),
    );

    const communicate = new Communicate(text, {
      voice: selectVoiceForLanguage(edgeVoices, language, voice),
      rate: `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`,
      connectionTimeout: edgeTimeoutMs,
      proxy: process.env.EDGE_TTS_PROXY || engineConfig.proxy || undefined,
    });

    const synthesize = async () => {
      const chunks = [];

      for await (const chunk of communicate.stream()) {
        if (chunk.type === "audio" && chunk.data) {
          chunks.push(chunk.data);
        }
      }

      if (!chunks.length) {
        throw new Error("Edge TTS returned no audio data");
      }

      return Buffer.concat(chunks);
    };

    let audio;

    try {
      audio = await withTimeout(
        synthesize(),
        edgeTimeoutMs,
        "Edge TTS connection/synthesis",
      );
    } catch (error) {
      if (/timed out/i.test(error.message)) {
        throw new Error(
          `Edge TTS 无法在 ${edgeTimeoutMs}ms 内连接微软语音服务。` +
            "请检查网络，或设置 EDGE_TTS_PROXY。",
        );
      }

      throw error;
    }

    const source = `${output}.source.mp3`;
    fs.writeFileSync(source, audio);

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
  async listVoices(_modelId, language) {
    const output = await runPowerShell(
      path.join(root, "scripts", "tts-speakers.ps1"),
    );
    const voices = output ? JSON.parse(output) : [];
    const result = Array.isArray(voices) ? voices : [voices];
    if (!language || language === "auto") return result;
    return result.filter((voice) =>
      String(voice.culture || "").toLowerCase().startsWith(language.toLowerCase()),
    );
  },
  async synthesize({ textPath, voice, targetSeconds = 3, speed = 1, output }) {
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
    async listVoices(_modelId, language) {
      if (!language || language === "auto") return voices;
      return voices.filter((voice) => {
        const culture = String(voice.culture || "").toLowerCase();
        return !culture || culture === "default" || culture === "multi" || culture.startsWith(language.toLowerCase());
      });
    },
    async synthesize({ text, language, model: selectedModel, voice, speed = 1, format = "wav", output }) {
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
          response_format: format,
          ...(language && language !== "auto" ? { language } : {}),
          speed,
        }),
      });
      await writeAudioResponse({ response, output, run, remotionCli });
    },
  };
};

export const createTtsRegistry = (dependencies) => {
  const config = dependencies.config || { defaultEngine: "edge", engines: {} };
  const descriptors = buildEngineDescriptors(config);
  const descriptorById = new Map(descriptors.map((item) => [item.id, item]));
  const modelIds = new Map();
  for (const descriptor of descriptors) {
    for (const model of descriptor.models) {
      const owner = modelIds.get(model.id);
      if (owner) throw new Error(`Duplicate TTS model id ${model.id} in ${owner} and ${descriptor.id}`);
      modelIds.set(model.id, descriptor.id);
    }
  }
  const getEngineConfig = (id) => config.engines[id] || {};
  const engines = [
    createEdgeEngine({...dependencies,config,engineConfig: getEngineConfig("edge"),}),
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
  for (const engine of engines) engine.descriptor = descriptorById.get(engine.id);
  return {
    get: (id) => byId.get(id),
    getModel: (modelId) => {
      const engineId = modelIds.get(modelId);
      return engineId
        ? descriptorById.get(engineId)?.models.find((model) => model.id === modelId)
        : undefined;
    },
    listDescriptors: () => descriptors,
    describe: () =>
      Promise.all(
        engines.map(async (engine) => ({
          ...engine.descriptor,
          kind: engine.kind,
          configured: engine.configured,
          ...(await engine.health()),
        })),
      ),
  };
};



