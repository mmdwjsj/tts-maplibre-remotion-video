const supportedFormats = new Set(["wav", "mp3", "ogg", "flac", "aac"]);

export const normalizeTtsRequest = (value = {}) => {
  const text = String(value.text ?? value.script ?? "").trim();
  const language = String(value.language ?? "auto").trim() || "auto";
  const voice = String(value.voice ?? value.speaker ?? "").trim();
  const rawSpeed = Number(value.speed ?? value.ttsSpeed ?? 1);
  const speed = Number.isFinite(rawSpeed) ? Math.max(0.25, Math.min(4, rawSpeed)) : 1;
  const candidateFormat = String(value.format ?? "wav").trim().toLowerCase();
  const format = supportedFormats.has(candidateFormat) ? candidateFormat : "wav";
  return { language, voice, speed, format, text };
};
