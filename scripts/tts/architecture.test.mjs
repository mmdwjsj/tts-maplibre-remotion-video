import assert from "node:assert/strict";
import test from "node:test";
import { buildEngineDescriptors } from "./capabilities.mjs";
import { validateTtsRequest } from "./validation.mjs";
import fs from "node:fs";

const projectConfig = JSON.parse(
  fs.readFileSync(
    new URL("../../src/config/tts.config.json", import.meta.url),
    "utf8",
  ),
);

const config = {
  engines: {
    edge: { enabled: true, defaultModel: "edge-neural", models: [{ id: "edge-neural", name: "Edge" }] },
    sapi: { enabled: true, defaultModel: "windows-sapi", models: [{ id: "windows-sapi", name: "SAPI" }] },
    voxcpm2: { models: [{ id: "voxcpm2", name: "VoxCPM" }] },
    "moss-tts": { models: [{ id: "moss-tts", name: "MOSS" }] },
    kokoro: projectConfig.engines.kokoro,
    sakthai: { models: [{ id: "sakthai", name: "SakThai" }] },
  },
};

test("descriptors preserve unknown capabilities", () => {
  const descriptors = buildEngineDescriptors(config);
  assert.equal(descriptors.length, 6);
  assert.equal(descriptors.find((item) => item.id === "voxcpm2").models[0].capabilities.voiceCloning.status, "unknown");
});

test("validator rejects unsupported controls", async () => {
  const descriptor = buildEngineDescriptors(config).find((item) => item.id === "edge");
  const registry = { get: () => ({ descriptor, listVoices: async () => [] }) };
  await assert.rejects(
    validateTtsRequest(registry, { engineId: "edge", modelId: "edge-neural", text: "hello", controls: { pitch: 1 }, parameters: {} }),
    /pitch is not supported/,
  );
});

test("validator rejects unknown parameters", async () => {
  const descriptor = buildEngineDescriptors(config).find((item) => item.id === "edge");
  const registry = { get: () => ({ descriptor, listVoices: async () => [] }) };
  await assert.rejects(
    validateTtsRequest(registry, { engineId: "edge", modelId: "edge-neural", text: "hello", controls: { speed: 1 }, parameters: { seed: 1 } }),
    /Unsupported parameter: seed/,
  );
});

test("Kokoro Thai configuration exposes its model, language, voices, and speed range", () => {
  const descriptor = buildEngineDescriptors(config).find(
    (item) => item.id === "kokoro",
  );

  assert.equal(descriptor.defaultModel, "kokoro-thai");
  assert.equal(descriptor.defaultVoice, "speaker_00");
  assert.equal(projectConfig.engines.kokoro.voices.length, 12);
  assert.equal(descriptor.models[0].id, "kokoro-thai");
  assert.equal(
    descriptor.models[0].capabilities.languages.status,
    "supported",
  );
  assert.equal(
    descriptor.models[0].capabilities.languages.defaultValue,
    "th-TH",
  );
  assert.deepEqual(
    descriptor.models[0].capabilities.languages.options.map(
      (item) => item.value,
    ),
    ["th-TH"],
  );
  assert.equal(descriptor.models[0].capabilities.speed.min, 0.5);
  assert.equal(descriptor.models[0].capabilities.speed.max, 2);
});

test("validator rejects speed outside the Kokoro Thai range", async () => {
  const descriptor = buildEngineDescriptors(config).find(
    (item) => item.id === "kokoro",
  );
  const registry = {
    get: () => ({
      descriptor,
      listVoices: async () => projectConfig.engines.kokoro.voices,
    }),
  };

  await assert.rejects(
    validateTtsRequest(registry, {
      engineId: "kokoro",
      modelId: "kokoro-thai",
      text: "hello",
      language: "th-TH",
      controls: { speed: 2.05 },
      parameters: {},
    }),
    /speed must be at most 2/,
  );
});

test("HTTP engines without configured speed keep the default range", () => {
  const descriptor = buildEngineDescriptors(config).find(
    (item) => item.id === "voxcpm2",
  );

  assert.equal(descriptor.models[0].capabilities.speed.min, 0.25);
  assert.equal(descriptor.models[0].capabilities.speed.max, 4);
});