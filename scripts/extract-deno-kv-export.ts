import { validateDenoState } from "./migrate-deno-to-cloudflare.mjs";

async function main() {
  const sourcePath = Deno.args[0];
  if (!sourcePath) {
    throw new Error("Usage: deno run --allow-read=<exported-db-file> --allow-write=. scripts/extract-deno-kv-export.ts <exported-db-file>");
  }
  const backupPath = Deno.env.get("STATE_BACKUP_FILE") ?? "deno-paper-state-from-export.json";
  const kv = await Deno.openKv(sourcePath);
  try {
    const entry = await kv.get(["bot_state"]);
    if (entry.value === null) {
      throw new Error('Exported production database has no ["bot_state"] key. Stop; do not substitute defaults.');
    }
    const state = validateDenoState(entry.value);
    if (state.balance === 100 && state.trades.length === 0 &&
        Deno.env.get("CONFIRM_DEFAULT_SOURCE_STATE") !== "YES") {
      throw new Error("State appears default (balance 100, no trades). Verify the live dashboard; only then set CONFIRM_DEFAULT_SOURCE_STATE=YES.");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(state, null, 2) + "\n");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
    const file = await Deno.open(backupPath, { write: true, createNew: true, mode: 0o600 });
    try {
      let offset = 0;
      while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    } finally {
      file.close();
    }
    console.log("Local Deno KV export inspected read-only.");
    console.log("JSON state backup: " + backupPath);
    console.log("SHA-256: " + sha);
    console.log("Balance: " + state.balance + "; trade count: " + state.trades.length);
    console.log("No source database mutation or Cloudflare import was performed.");
  } finally {
    kv.close();
  }
}
if (import.meta.main) main().catch(error => {
  console.error("Extraction stopped safely: " + String(error?.message ?? error));
  Deno.exitCode = 1;
});
