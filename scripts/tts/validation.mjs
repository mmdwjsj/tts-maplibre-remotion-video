const fail = (message, code = "INVALID_TTS_REQUEST") => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  throw error;
};

const supports = (feature) =>
  feature?.status === "supported" || feature?.status === "conditional";

export const validateTtsRequest = async (registry, request) => {
  if (!request.text) fail("TTS text cannot be empty");
  const engine = registry.get(request.engineId);
  if (!engine) fail(`Unknown TTS engine: ${request.engineId}`, "UNKNOWN_ENGINE");
  if (!engine.descriptor.enabled) fail(`TTS engine is disabled: ${request.engineId}`, "ENGINE_DISABLED");
  const model = engine.descriptor.models.find((item) => item.id === request.modelId);
  if (!model) fail(`Model ${request.modelId} does not belong to engine ${request.engineId}`, "UNKNOWN_MODEL");
  if (!model.enabled) fail(`TTS model is disabled: ${request.modelId}`, "MODEL_DISABLED");
  const capabilities = model.capabilities;

  const languageOptions = capabilities.languages?.options || [];
  if (request.language && request.language !== "auto" && languageOptions.length &&
      !languageOptions.some((option) => option.value === request.language)) {
    fail(`Language ${request.language} is not supported by model ${request.modelId}`, "UNSUPPORTED_LANGUAGE");
  }

  for (const [key, value] of Object.entries(request.controls || {})) {
    if (value === undefined) continue;
    const feature = capabilities[key];
    if (!supports(feature)) fail(`${key} is not supported by model ${request.modelId}`, "UNSUPPORTED_CAPABILITY");
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${key} must be a finite number`);
    if (feature.min !== undefined && value < feature.min) fail(`${key} must be at least ${feature.min}`);
    if (feature.max !== undefined && value > feature.max) fail(`${key} must be at most ${feature.max}`);
  }

  const definitions = new Map((capabilities.parameters || []).map((item) => [item.key, item]));
  for (const [key, value] of Object.entries(request.parameters || {})) {
    const definition = definitions.get(key);
    if (!definition) fail(`Unsupported parameter: ${key}`, "UNSUPPORTED_PARAMETER");
    if (definition.editable === false) fail(`Parameter is not editable: ${key}`);
    if (definition.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) fail(`${key} must be a number`);
    if (definition.type === "boolean" && typeof value !== "boolean") fail(`${key} must be a boolean`);
    if ((definition.type === "string" || definition.type === "select") && typeof value !== "string") fail(`${key} must be a string`);
    if (definition.min !== undefined && value < definition.min) fail(`${key} must be at least ${definition.min}`);
    if (definition.max !== undefined && value > definition.max) fail(`${key} must be at most ${definition.max}`);
    if (definition.type === "select" && !definition.options?.some((option) => option.value === value)) fail(`${key} is not an allowed option`);
  }

  if (request.voiceId) {
    if (!supports(capabilities.voices)) fail(`Voice selection is not supported by model ${request.modelId}`, "UNSUPPORTED_CAPABILITY");
    const voices = await engine.listVoices(request.modelId, request.language);
    if (!voices.some((voice) => voice.id === request.voiceId)) fail(`Unknown voice for selected model/language: ${request.voiceId}`, "UNKNOWN_VOICE");
  }
  return { engine, model, capabilities };
};

