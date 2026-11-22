const base = process.env.PREVIEW_URL;
const expectedBuild = process.env.EXPECTED_BUILD_ID;

if (!base || !expectedBuild) {
  throw new Error("PREVIEW_URL and EXPECTED_BUILD_ID are required");
}
const preview = new URL(base);
if (preview.protocol !== "https:" ||
    !/^[0-9a-f]{8}-solana-smart-bot-new\.hesamtanya75\.workers\.dev$/.test(preview.hostname)) {
  throw new Error("Refusing to smoke-test a non-Preview URL");
}

async function getJson(path) {
  const response = await fetch(new URL(path, preview), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${path}: expected HTTP 200, received ${response.status}`);
  const value = await response.json();
  if (!value || typeof value !== "object") throw new Error(`${path}: invalid JSON response`);
  return value;
}

const health = await getJson("/health");
if (health.ok !== true || health.mode !== "paper-trading" || health.build !== expectedBuild) {
  throw new Error("/health mismatch: " + JSON.stringify({ ok: health.ok, mode: health.mode, build: health.build, expectedBuild }));
}

const version = await getJson("/version");
if (version.ok !== true || version.build !== expectedBuild ||
    version.frontend !== "premium-dashboard-v2" || version.asset !== "index.html") {
  throw new Error("/version does not match the expected Preview build");
}

const asset = await getJson("/health");
if (asset.ok !== true || asset.status !== 200 ||
    !String(asset.contentType || "").toLowerCase().includes("text/html") ||
    asset.hasPremiumDesign !== true || asset.hasFinalPurpleGlass !== true ||
    asset.hasOldClaudeSkin !== false || asset.hasLegacyPremiumSection !== false ||
    asset.hasLoginPanel !== true) {
  throw new Error("/asset-check did not confirm the expected dashboard asset");
}

const privatePaths = [
  "/.git/config",
  "/.wrangler/",
  "/worker.js",
  "/paper-state-coordinator.js",
  "/mfa-rate-limiter.js",
  "/display-test.html",
  "/wrangler.jsonc",
  "/package.json",
  "/.dev.vars",
  "/deno-bot-state-backup.json"
];
for (const path of privatePaths) {
  const response = await fetch(new URL(path, preview), {
    redirect: "manual",
    signal: AbortSignal.timeout(15000)
  });
  if (response.status !== 404) {
    throw new Error(`Asset boundary failed: ${path} returned HTTP ${response.status}, expected 404`);
  }
}

console.log("PASS: Preview health/version match the requested SHA.");
console.log("PASS: dashboard asset and Purple Glass markers are present.");
console.log(`PASS: ${privatePaths.length} repository/source/diagnostic paths are not publicly served.`);
console.log("Read-only only; no login, state mutation, Cron, Deno import, or chain transaction was performed.");
