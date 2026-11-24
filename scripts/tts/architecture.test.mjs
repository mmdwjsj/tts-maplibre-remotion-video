import assert from "node:assert/strict";
import test from "node:test";
import { buildEngineDescriptors } from "./capabilities.mjs";
import { validateTtsRequest } from "./validation.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    wayu: projectConfig.engines.wayu,
  },
};

test("descriptors preserve unknown capabilities", () => {
  const descriptors = buildEngineDescriptors(config);
  assert.equal(descriptors.length, 7);
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

test("Wayu configuration matches its local service contract", () => {
  const descriptor = buildEngineDescriptors(config).find(
    (item) => item.id === "wayu",
  );
  const capabilities = descriptor.models[0].capabilities;

  assert.equal(descriptor.defaultModel, "wayu");
  assert.equal(descriptor.defaultVoice, "m_young_clear");
  assert.equal(descriptor.models[0].id, "wayu");
  assert.equal(projectConfig.engines.wayu.baseUrl, "http://127.0.0.1:10005");
  assert.equal(projectConfig.engines.wayu.voices.length, 12);
  assert.deepEqual(
    capabilities.languages.options.map((item) => item.value),
    ["th-TH"],
  );
  assert.equal(capabilities.speed.max, 2);
  assert.equal(capabilities.speed.defaultValue, 1);
  assert.deepEqual(capabilities.parameters.map((item) => item.key), ["seed"]);
});

test("validator enforces the Wayu speed ceiling and seed type", async () => {
  const descriptor = buildEngineDescriptors(config).find(
    (item) => item.id === "wayu",
  );
  const registry = {
    get: () => ({
      descriptor,
      listVoices: async () => projectConfig.engines.wayu.voices,
    }),
  };
  const base = {
    engineId: "wayu",
    modelId: "wayu",
    text: "สวัสดี",
    language: "th-TH",
    controls: { speed: 1 },
    parameters: {},
  };

  await assert.rejects(
    validateTtsRequest(registry, { ...base, controls: { speed: 2.5 } }),
    /speed must be at most 2/,
  );
  await assert.rejects(
    validateTtsRequest(registry, { ...base, parameters: { seed: "abc" } }),
    /seed must be a number/,
  );
  await assert.rejects(
    validateTtsRequest(registry, { ...base, parameters: { bogus: 1 } }),
    /Unsupported parameter: bogus/,
  );
  assert.equal(
    (
      await validateTtsRequest(registry, {
        ...base,
        parameters: { seed: 42 },
      })
    ).model.id,
    "wayu",
  );
});

test("HTTP engine forwards declared parameters to the speech endpoint", async () => {
  const { createTtsRegistry } = await import("./engine-registry.mjs");
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(new Uint8Array([0, 0]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };

  try {
    const registry = createTtsRegistry({
      config: { engines: { wayu: projectConfig.engines.wayu } },
      run: async () => {},
      remotionCli: "ffmpeg",
    });
    await registry.get("wayu").synthesize({
      text: "สวัสดี",
      voice: "m_young_clear",
      model: "wayu",
      speed: 1,
      format: "wav",
      output: path.join(os.tmpdir(), `wayu-synth-${process.pid}.wav`),
      parameters: { seed: 7, bogus: 1 },
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /10005\/v1\/audio\/speech$/);
    assert.equal(requests[0].body.seed, 7);
    assert.equal(requests[0].body.bogus, undefined);
    assert.equal(requests[0].body.model, "wayu");
    assert.equal(requests[0].body.voice, "m_young_clear");
    assert.equal(requests[0].body.response_format, "wav");
  } finally {
    globalThis.fetch = originalFetch;
  }
});