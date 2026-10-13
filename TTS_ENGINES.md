# TTS Engine configuration

The web UI supports these engines:

- `edge`: Microsoft Edge TTS (built in, online)
- `sapi`: Windows SAPI (built in, local)
- `voxcpm2`: VoxCPM 2 local HTTP service
- `moss-tts`: MOSS-TTS local HTTP service
- `kokoro`: Kokoro local HTTP service
- `sakthai`: SakThai local HTTP service

Local HTTP engines are intentionally kept outside the Node web server. Start each model with its own Python/runtime environment and point this project at it with environment variables. The adapter expects an OpenAI-compatible endpoint:

```http
POST /v1/audio/speech
Content-Type: application/json

{
  "model": "sakthai",
  "input": "...",
  "voice": "default",
  "response_format": "wav",
  "speed": 1
}
```

The response may be WAV, MP3, or OGG. This project normalizes it to mono, 24 kHz, 16-bit PCM WAV before building the timeline and muxing the video.

## Configuration

`npm run web` loads `.env.tts` (then `.env`) from the project root automatically — copy `.env.tts.example` and edit it. Real environment variables always win, so the PowerShell example below still works for one-off overrides.

```powershell
$env:SAKTHAI_BASE_URL = 'http://127.0.0.1:10004'
$env:SAKTHAI_MODEL = 'sakthai'
$env:SAKTHAI_VOICES = 'default'
$env:TTS_TIMEOUT_MS = '120000'
npm.cmd run web
```

Every `*_BASE_URL` / `*_MODEL` / `*_VOICES` value must match `src/config/tts.config.json`, because a value present in the environment overrides the config file. A wrong port makes the engine show up as unavailable in the UI instead of falling back.

See `.env.tts.example` for every supported variable. `*_SPEECH_PATH` can override `/v1/audio/speech`, and `*_API_KEY` adds a Bearer token.

An engine is disabled in the UI when it is not configured or its `/v1/models` health check cannot be reached.

## Capability-driven architecture

The Node server keeps engine-specific transport inside `scripts/tts/engine-registry.mjs` and exposes a stable catalog:

- `GET /api/tts/engines`
- `GET /api/tts/engines/:engineId/models`
- `GET /api/tts/models/:modelId/capabilities`
- `GET /api/tts/models/:modelId/voices?language=th-TH`

`scripts/tts/capabilities.mjs` contains registered model capabilities. A capability is `supported`, `unsupported`, `conditional`, or `unknown`; unverified local-service features remain `unknown`. `scripts/tts/validation.mjs` validates the selected engine/model relationship, controls, voices, and model-specific parameters before synthesis. The existing `POST /api/generate` route and legacy field names remain supported.

To add a seventh engine/model:

1. Add its persisted connection settings and model entry to `src/config/tts.config.json` (do not put secrets in browser-visible descriptors).
2. Register an adapter in `scripts/tts/engine-registry.mjs` with `health`, `listVoices`, and `synthesize` methods.
3. Add its capability descriptor in `scripts/tts/capabilities.mjs`. Only mark behavior as supported after verifying the real service.
4. Give every model a globally unique ID, then run `npm run test:tts`, `npm run typecheck`, and `npm run validate:data`.

The web UI reads this metadata and does not require engine-specific conditions when a new model only introduces schema-defined controls.
