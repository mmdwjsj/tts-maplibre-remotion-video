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

## PowerShell example

```powershell
$env:SAKTHAI_BASE_URL = 'http://127.0.0.1:8890'
$env:SAKTHAI_MODEL = 'sakthai'
$env:SAKTHAI_VOICES = 'default'
$env:TTS_TIMEOUT_MS = '120000'
npm.cmd run web
```

See `.env.tts.example` for every supported variable. `*_SPEECH_PATH` can override `/v1/audio/speech`, and `*_API_KEY` adds a Bearer token.

An engine is disabled in the UI when it is not configured or its `/v1/models` health check cannot be reached.
