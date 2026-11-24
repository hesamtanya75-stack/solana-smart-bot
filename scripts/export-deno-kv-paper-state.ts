import { validateDenoState } from "./migrate-deno-to-cloudflare.mjs";
import { denoKvConnectUrl, isDefaultLookingState } from "./deno-kv-export-core.mjs";

async function main() {
  const databaseId = Deno.env.get("DENO_KV_DATABASE_ID") ?? "";
  if (!Deno.env.get("DENO_KV_ACCESS_TOKEN")) {
    throw new Error("Set DENO_KV_ACCESS_TOKEN in your local environment; never paste it into chat or commit it.");
  }
  const connectUrl = denoKvConnectUrl(databaseId);
  const backupPath = Deno.env.get("STATE_BACKUP_FILE") ?? "deno-kv-paper-state-backup.json";

  const kv = await Deno.openKv(connectUrl);
  try {
    // Read-only: inspect the exact production key used by main.ts.
    const entry = await kv.get(["bot_state"]);
    if (entry.value === null) {
      throw new Error('Production key ["bot_state"] is absent. Stop; do not substitute the API default state.');
    }
    const source = validateDenoState(entry.value);
    if (isDefaultLookingState(source) && Deno.env.get("CONFIRM_DEFAULT_SOURCE_STATE") !== "YES") {
      throw new Error("State looks default (balance 100, no trades). Verify the dashboard first; only then set CONFIRM_DEFAULT_SOURCE_STATE=YES.");
    }

    const exportText = JSON.stringify(source, null, 2) + "\n";
    const bytes = new TextEncoder().encode(exportText);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const checksum = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");

    // Exclusive create avoids overwriting an earlier backup; Unix mode is owner-only.
    const file = await Deno.open(backupPath, { write: true, createNew: true, mode: 0o600 });
    try {
      let offset = 0;
      while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    } finally {
      file.close();
    }

    console.log("Read-only Deno KV export completed.");
    console.log("Backup file: " + backupPath);
    console.log("SHA-256: " + checksum);
    console.log("Balance: " + source.balance + "; trade count: " + source.trades.length);
    console.log("No KV writes, Cloudflare import, deployment, or cutover occurred.");
  } finally {
    kv.close();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error("Deno KV export stopped safely: " + String(error?.message ?? error));
    Deno.exitCode = 1;
  });
}
