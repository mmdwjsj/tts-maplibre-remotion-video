const supportedFormats = new Set(["wav", "mp3", "ogg", "flac", "aac"]);

export const normalizeTtsRequest = (value = {}) => {
  const text = String(value.text ?? value.script ?? "").trim();
  const language = String(value.language ?? "auto").trim() || "auto";
  const voice = String(value.voice ?? value.speaker ?? "").trim();
  const model = String(value.model ?? value.ttsModel ?? "").trim();
  const rawSpeed = Number(value.speed ?? value.ttsSpeed ?? 1);
  const speed = Number.isFinite(rawSpeed) ? Math.max(0.25, Math.min(4, rawSpeed)) : 1;
  const candidateFormat = String(value.format ?? "wav").trim().toLowerCase();
  const format = supportedFormats.has(candidateFormat) ? candidateFormat : "wav";
  const rawTargetSeconds = Number(value.targetSeconds ?? value.speechDuration ?? 3);
  const targetSeconds = Number.isFinite(rawTargetSeconds)
    ? Math.max(0.5, Math.min(3600, rawTargetSeconds))
    : 3;
  return { text, language, voice, model, speed, format, targetSeconds };
};

// Returns the first candidate that is a non-empty string, so blank request
// fields fall through to the engine defaults instead of short-circuiting `??`.
const pick = (...candidates) => {
  for (const candidate of candidates) {
    const text = candidate === undefined || candidate === null ? "" : String(candidate).trim();
    if (text) return text;
  }
  return "";
};

export const normalizeUnifiedTtsRequest = (value = {}, defaults = {}) => {
  const legacy = normalizeTtsRequest(value);
  const controls = value.controls && typeof value.controls === "object"
    ? value.controls
    : { speed: legacy.speed };
  return {
    engineId: pick(value.engineId, value.ttsEngine, defaults.engineId),
    modelId: pick(value.modelId, legacy.model, defaults.modelId),
    text: legacy.text,
    language: pick(value.language, defaults.language, legacy.language) || "auto",
    voiceId: pick(value.voiceId, legacy.voice, defaults.voiceId),
    controls,
    parameters: value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters) ? value.parameters : {},
    output: {
      format: String(value.output?.format ?? legacy.format ?? "wav").toLowerCase(),
      sampleRate: Number(value.output?.sampleRate ?? 24000),
    },
    targetSeconds: legacy.targetSeconds,
  };
};


