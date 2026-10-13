import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads `.env.tts` (then `.env`) from the project root before any other module
 * reads `process.env`. Real environment variables always take precedence, so
 * `$env:SAKTHAI_BASE_URL=...` still overrides the file.
 */
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const fallbackParse = (content) => {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
};

let parseEnv = fallbackParse;
try {
  const nodeUtil = await import("node:util");
  if (typeof nodeUtil.parseEnv === "function") parseEnv = nodeUtil.parseEnv;
} catch {
  parseEnv = fallbackParse;
}

for (const name of [".env.tts", ".env"]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  try {
    const parsed = parseEnv(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log(`[env] 已加载 ${name}`);
  } catch (error) {
    console.warn(`[env] 无法加载 ${name}：${error.message}`);
  }
}
