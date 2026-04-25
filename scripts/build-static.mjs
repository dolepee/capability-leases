import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const webDir = path.join(root, "web");
const distDir = path.join(root, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const name of fs.readdirSync(webDir)) {
  fs.copyFileSync(path.join(webDir, name), path.join(distDir, name));
}

console.log(`Static demo written to ${distDir}`);
