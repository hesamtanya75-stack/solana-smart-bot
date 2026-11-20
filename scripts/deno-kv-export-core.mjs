export function denoKvConnectUrl(databaseId) {
  if (typeof databaseId !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(databaseId)) {
    throw new Error("DENO_KV_DATABASE_ID must be the actual database ID copied from Deno database details");
  }
  return `https://api.deno.com/v2/databases/${databaseId}/connect`;
}

export function isDefaultLookingState(state) {
  return state?.balance === 100 && Array.isArray(state?.trades) && state.trades.length === 0;
}
