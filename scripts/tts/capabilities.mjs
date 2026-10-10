const state = (status, details = {}) => ({ status, ...details });

const numeric = (label, min, max, step, defaultValue) =>
  state("supported", { label, min, max, step, defaultValue });

const parameter = (definition) => ({
  required: false,
  editable: true,
  group: "advanced",
  ...definition,
});

const unknownFeature = () => state("unknown");

const httpCapabilities = (engineConfig) => ({
  languages: state("unknown", { options: engineConfig.languages || [] }),
  voices: state("conditional", {
    reason: "Only configured or service-discovered voices are exposed",
  }),
  speed: numeric("Speed", 0.25, 4, 0.05, 1),
  pitch: unknownFeature(),
  volume: unknownFeature(),
  streaming: unknownFeature(),
  ssml: unknownFeature(),
  voiceCloning: unknownFeature(),
  referenceAudio: unknownFeature(),
  parameters: (engineConfig.parameters || []).map(parameter),
});

export const buildEngineDescriptors = (config = {}) => {
  const engineConfig = config.engines || {};
  const descriptors = [
    {
      id: "edge",
      name: "Microsoft Edge TTS",
      type: "remote-api",
      capabilities: {
        languages: state("supported", {
          options: [{ value: "th-TH", label: "Thai (Thailand)" }],
          defaultValue: "th-TH",
        }),
        voices: state("supported"),
        speed: numeric("Speed", 0.5, 2, 0.05, 1),
        pitch: state("unsupported"),
        volume: state("unsupported"),
        streaming: state("unsupported"),
        ssml: state("unknown"),
        voiceCloning: state("unsupported"),
        referenceAudio: state("unsupported"),
        parameters: [],
      },
    },
    {
      id: "sapi",
      name: "Windows SAPI",
      type: "system",
      capabilities: {
        languages: state("conditional", {
          reason: "Derived from voices installed on this Windows system",
          options: [],
        }),
        voices: state("conditional", {
          reason: "Detected from voices installed on this Windows system",
        }),
        speed: numeric("Speed", 0.25, 2, 0.05, 1),
        pitch: state("unsupported"),
        volume: state("unsupported"),
        streaming: state("unsupported"),
        ssml: state("unsupported"),
        voiceCloning: state("unsupported"),
        referenceAudio: state("unsupported"),
        parameters: [],
      },
    },
  ];

  for (const [id, name] of [
    ["voxcpm2", "VoxCPM 2"],
    ["moss-tts", "MOSS-TTS"],
    ["kokoro", "Kokoro"],
    ["sakthai", "SakThai"],
  ]) {
    descriptors.push({
      id,
      name,
      type: "local-api",
      capabilities: httpCapabilities(engineConfig[id] || {}),
    });
  }

  return descriptors.map((descriptor) => {
    const configured = engineConfig[descriptor.id] || {};
    const models = (configured.models || []).map((model) => ({
      id: String(model.id),
      name: String(model.name || model.id),
      enabled: model.enabled !== false,
      capabilities: model.capabilities || descriptor.capabilities,
      defaults: model.defaults || {},
    }));
    return {
      ...descriptor,
      enabled: configured.enabled !== false,
      defaultModel: configured.defaultModel || models[0]?.id || "",
      defaultVoice: configured.defaultVoice || "",
      models,
    };
  });
};

