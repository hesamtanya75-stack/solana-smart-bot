import test from "node:test";
import assert from "node:assert/strict";
import {
  JUPITER_AUTHORITY_COUNT,
  deriveJupiterProgramAuthorityId,
  identifyJupiterProgramAuthority
} from "../solana-jupiter-authority.mjs";

test("Jupiter program-authority derivation produces 16 distinct pinned PDAs", () => {
  const addresses = Array.from({ length: JUPITER_AUTHORITY_COUNT }, (_, id) =>
    deriveJupiterProgramAuthorityId(id)
  );
  assert.equal(addresses.length, 16);
  assert.equal(new Set(addresses).size, 16);
  addresses.forEach((address, id) => {
    assert.equal(identifyJupiterProgramAuthority(address), id);
  });
});

test("Jupiter program-authority derivation rejects out-of-range indexes and unknown keys", () => {
  assert.throws(() => deriveJupiterProgramAuthorityId(-1), /outside the pinned source range/);
  assert.throws(() => deriveJupiterProgramAuthorityId(16), /outside the pinned source range/);
  assert.equal(identifyJupiterProgramAuthority("11111111111111111111111111111111"), null);
  assert.equal(identifyJupiterProgramAuthority(null), null);
});
