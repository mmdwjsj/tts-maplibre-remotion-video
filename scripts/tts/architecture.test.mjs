import assert from "node:assert/strict";
import test from "node:test";
import { buildEngineDescriptors } from "./capabilities.mjs";
import { validateTtsRequest } from "./validation.mjs";

const config = {
  engines: {
    edge: { enabled: true, defaultModel: "edge-neural", models: [{ id: "edge-neural", name: "Edge" }] },
    sapi: { enabled: true, defaultModel: "windows-sapi", models: [{ id: "windows-sapi", name: "SAPI" }] },
    voxcpm2: { models: [{ id: "voxcpm2", name: "VoxCPM" }] },
    "moss-tts": { models: [{ id: "moss-tts", name: "MOSS" }] },
    kokoro: { models: [{ id: "kokoro", name: "Kokoro" }] },
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
