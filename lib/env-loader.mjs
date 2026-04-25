import fs from "node:fs";
import path from "node:path";

export function loadLocalEnv(rootDir = process.cwd()) {
  for (const file of [".env.local", ".env"]) {
    const envPath = path.join(rootDir, file);
    if (!fs.existsSync(envPath)) continue;
    for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = stripQuotes(line.slice(separator + 1).trim());
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
