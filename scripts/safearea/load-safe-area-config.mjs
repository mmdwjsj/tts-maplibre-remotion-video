import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads the TikTok / 抖音 safe-area configuration.
 *
 * Path resolution follows the exact same convention as the TTS config loader
 * (`scripts/tts/log-config.mjs`): an env override first, then a top-level
 * `config/` override, then the checked-in `src/config/` file. There is
 * deliberately **one** config file for the whole pipeline — the dev server, the
 * render props and the Remotion component all resolve the same numbers, so the
 * preview can never disagree with the MP4.
 *
 * A missing or broken file is never fatal: the caller falls back to the
 * defaults compiled into `src/safearea/safeArea.ts` and the warning is logged.
 * Nothing here duplicates validation — `normalizeSafeAreaConfig` owns that.
 */
export const loadSafeAreaConfig = (root) => {
  const configuredPath = process.env.SAFE_AREA_CONFIG_PATH
    ? path.resolve(root, process.env.SAFE_AREA_CONFIG_PATH)
    : path.join(root, 'config', 'safe-area.config.json');
  const sourceConfigPath = path.join(root, 'src', 'config', 'safe-area.config.json');
  const configPath = fs.existsSync(configuredPath) ? configuredPath : sourceConfigPath;

  if (!fs.existsSync(configPath)) {
    return {
      config: null,
      configPath,
      warning: `未找到安全区配置文件（${configPath}），已使用内置默认值`,
    };
  }

  try {
    return {config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath, warning: null};
  } catch (error) {
    return {
      config: null,
      configPath,
      warning: `安全区配置文件无法解析（${configPath}）：${error.message}，已使用内置默认值`,
    };
  }
};
