import { openKv } from "@deno/kv";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDenoState } from "./migrate-deno-to-cloudflare.mjs";

export function denoKvConnectUrl(databaseId) {
  if (typeof databaseId !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(databaseId)) {
    throw new Error("DENO_KV_DATABASE_ID must be the actual database ID copied from Deno's database details");
  }
  return `https://api.deno.com/v2/databases/${databaseId}/connect`;
}

export function isDefaultLookingState(state) {
  return state?.balance === 100 && Array.isArray(state?.trades) && state.trades.length === 0;
}

async function main() {
  const databaseId = process.env.DENO_KV_DATABASE_ID;
  const accessToken = process.env.DENO_KV_ACCESS_TOKEN;
  if (!accessToken) throw new Error("Missing DENO_KV_ACCESS_TOKEN; never paste it into chat or commit it");
  const url = denoKvConnectUrl(databaseId);
  const backupPath = resolve(process.env.STATE_BACKUP_FILE || "deno-kv-paper-state-backup.json");

  const kv = await openKv(url, { accessToken });
  try {
    // Read-only access to the exact production key used by main.ts.
    const entry = await kv.get(["bot_state"]);
    if (entry.value === null) {
      throw new Error('Production key ["bot_state"] is absent. Stop; do not substitute the API default.');
    }
    const source = validateDenoState(entry.value);
    if (isDefaultLookingState(source) && process.env.CONFIRM_DEFAULT_SOURCE_STATE !== "YES") {
      throw new Error("Source looks default (balance 100, no trades). Inspect it first; set CONFIRM_DEFAULT_SOURCE_STATE=YES only if you verified this is the real intended state.");
    }
    const text = JSON.stringify(source, null, 2) + "\n";
    const checksum = createHash("sha256").update(text).digest("hex");
    await writeFile(backupPath, text, { flag: "wx", mode: 0o600 });
    console.log("Read-only Deno KV export completed.");
    console.log("Backup path: " + backupPath);
    console.log("SHA-256: " + checksum);
    console.log("Balance: " + source.balance + "; trades: " + source.trades.length);
    console.log("No Deno KV writes or Cloudflare imports were performed.");
  } finally {
    kv.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error("Deno KV export stopped safely: " + String(error?.message || error));
    process.exitCode = 1;
  });
}
