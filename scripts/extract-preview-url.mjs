import { appendFile, readFile } from "node:fs/promises";

const logPath = process.argv[2];
const outputPath = process.env.GITHUB_OUTPUT;
if (!logPath || !outputPath) {
  throw new Error("Wrangler log path and GITHUB_OUTPUT are required");
}

const log = await readFile(logPath, "utf8");
const marker = '{\n  "preview":';
const start = log.lastIndexOf(marker);
if (start < 0) throw new Error("Could not find Wrangler Preview JSON in the captured output");

let payload;
try {
  payload = JSON.parse(log.slice(start));
} catch {
  throw new Error("Wrangler Preview JSON could not be parsed");
}

const url = payload?.deployment?.urls?.[0];
if (typeof url !== "string") throw new Error("Wrangler did not return an immutable deployment URL");
const parsed = new URL(url);
if (parsed.protocol !== "https:" ||
    !/^[0-9a-f]{8}-solana-smart-bot\.hesamtanya75\.workers\.dev$/.test(parsed.hostname)) {
  throw new Error("Wrangler returned an unexpected Preview deployment host");
}

await appendFile(outputPath, `preview_url=${url}\n`);
console.log("Captured the exact immutable Wrangler Preview deployment URL.");
