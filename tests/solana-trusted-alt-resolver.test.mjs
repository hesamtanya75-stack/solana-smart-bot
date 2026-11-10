import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair
} from "@solana/web3.js";
import { createTrustedAltResolver } from "../solana-trusted-alt-resolver.mjs";

const MAX_U64 = (1n << 64n) - 1n;

function fixture(overrides = {}) {
  const key = Keypair.generate().publicKey;
  const address = Keypair.generate().publicKey;
  const state = {
    deactivationSlot: MAX_U64,
    lastExtendedSlot: 90,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: [address],
    ...overrides.state
  };
  const calls = [];
  const connection = {
    rpcEndpoint: "https://trusted-rpc.example",
    async getAccountInfoAndContext(requestedKey, config) {
      calls.push({ method: "getAccountInfoAndContext", requestedKey, config });
      return {
        context: { slot: overrides.responseSlot ?? 100 },
        value: {
          owner: overrides.owner ?? AddressLookupTableProgram.programId,
          data: Buffer.from("fixture")
        }
      };
    },
    async getSlot(commitment) {
      calls.push({ method: "getSlot", commitment });
      return overrides.currentSlot ?? 101;
    }
  };
  const resolver = createTrustedAltResolver({
    connection,
    trustedRpcEndpoint: "https://trusted-rpc.example",
    maxSlotLag: overrides.maxSlotLag ?? 32,
    minContextSlot: overrides.minContextSlot ?? 0,
    deserializeLookupTable: () => state
  });
  return { key, address, state, calls, connection, resolver };
}

test("resolves a canonical, active ALT from a fresh trusted RPC context", async () => {
  const { key, address, calls, resolver } = fixture();
  const table = await resolver(key);

  assert.ok(table instanceof AddressLookupTableAccount);
  assert.ok(table.key.equals(key));
  assert.ok(table.state.addresses[0].equals(address));
  assert.deepEqual(calls.map((call) => call.method), [
    "getAccountInfoAndContext",
    "getSlot"
  ]);
  assert.deepEqual(calls[0].config, { commitment: "confirmed", minContextSlot: 0 });
});

test("rejects an ALT owned by a different program", async () => {
  const { key, resolver } = fixture({ owner: Keypair.generate().publicKey });
  await assert.rejects(
    () => resolver(key),
    /canonical Address Lookup Table Program/
  );
});

test("rejects missing ALT accounts and malformed ALT data", async () => {
  const missing = fixture();
  missing.connection.getAccountInfoAndContext = async () => ({
    context: { slot: 100 }, value: null
  });
  await assert.rejects(() => missing.resolver(missing.key), /missing or its RPC context/);

  const malformed = fixture();
  const badResolver = createTrustedAltResolver({
    connection: malformed.connection,
    trustedRpcEndpoint: "https://trusted-rpc.example",
    deserializeLookupTable: () => null
  });
  await assert.rejects(() => badResolver(malformed.key), /state is invalid/);
});

test("rejects deactivated, stale, and inconsistent ALT state", async () => {
  const deactivated = fixture({ state: { deactivationSlot: 99n } });
  await assert.rejects(() => deactivated.resolver(deactivated.key), /Deactivated ALT/);

  const stale = fixture({ responseSlot: 50, currentSlot: 101, maxSlotLag: 10 });
  await assert.rejects(() => stale.resolver(stale.key), /context is stale/);

  const inconsistent = fixture({ responseSlot: 102, currentSlot: 101 });
  await assert.rejects(() => inconsistent.resolver(inconsistent.key), /stale or inconsistent/);
});

test("rejects an ALT extended in the current slot or a future slot", async () => {
  const current = fixture({ state: { lastExtendedSlot: 101 }, currentSlot: 101 });
  await assert.rejects(() => current.resolver(current.key), /extended too recently/);

  const future = fixture({ state: { lastExtendedSlot: 102 }, currentSlot: 101 });
  await assert.rejects(() => future.resolver(future.key), /extended too recently/);
});

test("requires an exact trusted RPC endpoint and valid freshness settings", () => {
  const connection = {
    rpcEndpoint: "https://one.example",
    getAccountInfoAndContext() {},
    getSlot() {}
  };
  assert.throws(() => createTrustedAltResolver({
    connection, trustedRpcEndpoint: "https://two.example"
  }), /does not match/);
  assert.throws(() => createTrustedAltResolver({
    connection, trustedRpcEndpoint: "https://one.example", maxSlotLag: -1
  }), /freshness settings/);
  assert.throws(() => createTrustedAltResolver({
    connection: { ...connection, rpcEndpoint: "http://one.example" },
    trustedRpcEndpoint: "http://one.example"
  }), /HTTPS trusted RPC endpoint/);
});

test("rejects malformed ALT state metadata", async () => {
  const { key, connection } = fixture();
  const malformed = createTrustedAltResolver({
    connection,
    trustedRpcEndpoint: "https://trusted-rpc.example",
    deserializeLookupTable: () => ({
      deactivationSlot: MAX_U64,
      lastExtendedSlot: 90,
      lastExtendedSlotStartIndex: 3,
      addresses: []
    })
  });
  await assert.rejects(() => malformed(key), /state is invalid/);
});
