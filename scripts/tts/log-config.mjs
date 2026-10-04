import fs from 'node:fs';
import path from 'node:path';

export const loadTtsConfig = (root) => {
  const configuredPath = process.env.TTS_CONFIG_PATH
    ? path.resolve(root, process.env.TTS_CONFIG_PATH)
    : path.join(root, 'config', 'tts.config.json');
  const sourceConfigPath = path.join(root, 'src', 'config', 'tts.config.json');
  const configPath = fs.existsSync(configuredPath) ? configuredPath : sourceConfigPath;

  if (!fs.existsSync(configPath)) {
    throw new Error(`TTS config file not found: ${configPath}`);
  }

  let config;

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid TTS config: ${error.message}`);
  }

  config.engines ??= {};
  config.defaultEngine ??= 'edge';
  config.timeoutMs = Math.max(
    5000,
    Number(process.env.TTS_TIMEOUT_MS || config.timeoutMs) || 120000,
  );
  config.healthTimeoutMs = Math.max(
    500,
    Number(
      process.env.TTS_HEALTH_TIMEOUT_MS || config.healthTimeoutMs,
    ) || 1500,
  );

  return {config, configPath};
};