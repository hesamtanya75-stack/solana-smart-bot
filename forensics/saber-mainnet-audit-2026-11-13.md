# Saber Mainnet forensic audit

Date: 2026-11-13  
Scope: read-only Solana Mainnet forensic analysis. No Mainnet transaction, deploy, merge, or frontend change was performed.

## Target

- Program: `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ`
- ProgramData: `54aePuBcYcf8G3CDrWWd2MEiw6Q7UGy2kjgQBDhqoMdt`
- Upgrade slot / deployment slot: `119721738`
- Deployed executable SHA-256: `c1e843d5134d3c93105f111629c364db4b8bc7aba109cc79e3b7e4b73c149c38`
- Deployed executable payload length after removing 15 trailing zero bytes: 217,177 bytes.

## Confirmed upgrade transaction

- Signature: `5ygvjFAXLwknuRLZVFNCCExmdPcvaTYEeYxHXv8JAWCT1cz6dgbnJ734mZaaCMcZeDQpdxFegrcwcwGKCratGiwb`
- Slot: `119721738`
- RPC blockTime: `1644216349` = `2022-02-07T06:45:49Z` (Solana blockTime is an estimated block timestamp; it is not proof of the exact wall-clock instant of execution).
- Transaction succeeded; transaction meta error was null.
- Outer program: Goki program `GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmpgBgs55bnpH`.
- Goki log: `Instruction: OwnerInvokeInstructionV2`, followed by `Instruction: ExecuteTransaction`.
- Inner Upgradeable Loader instruction discriminator: `3` (Upgrade).
- Loader accounts include the Saber ProgramData, Saber program, buffer `9kDwyNPvePGfAhVoY9pezC4jJRzBetQnfttzkBuHmiW9`, spill account `GVQzKmFPJDrJT1pBYiT7KhfhMqvmU6yQ6SAhQKR7roaj`, and authority `BkkBFsRm6VCbZyBG82yuHBnyjJwUJHv1nTJ3GiY44Tkr`.
- Top-level transaction signer: `GVQzKmFPJDrJT1pBYiT7KhfhMqvmU6yQ6SAhQKR7roaj`. This is distinct from the Goki wallet authority account; do not describe it as the authority.
- Goki program logs explicitly state: `Upgraded program SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ`.

## Buffer reconstruction — strong binary provenance evidence

- Buffer: `9kDwyNPvePGfAhVoY9pezC4jJRzBetQnfttzkBuHmiW9`
- 218 buffer signatures were examined.
- 215 write instructions reconstructed the payload.
- Covered bytes: 217,192 / 217,192.
- Gaps: 0 bytes.
- Full payload SHA-256: `eeacf0770556dabc19c0c5e11e3f3d743367e200781bdc3d9d1c5b49c2ca6992`.
- After trimming the 15 trailing zero bytes, length is 217,177 and SHA-256 is `c1e843d5134d3c93105f111629c364db4b8bc7aba109cc79e3b7e4b73c149c38`.
- This exactly matches the deployed Mainnet executable hash. The reconstruction report contains no errors.

## Authority history

- 2021-12-31, slot 114149612: Upgrade instruction with authority `H9XuKqszWYirDmXDQ12TZXGtxqUYYn4oi7FKzAm7RHGc`.
- 2022-01-02, slot 114384918: SetAuthority (loader discriminator 4) changed ProgramData authority from `H9Xu...` to `BkkBFsRm6VCbZyBG82yuHBnyjJwUJHv1nTJ3GiY44Tkr`.
- 2022-02-07, slot 119721738: Goki OwnerInvokeInstructionV2 executed the Saber upgrade under authority `Bkk...`.
- 2026-05-28, slot 422671196: SetAuthority (discriminator 4) changed authority from `Bkk...` to current authority `EVmbDJCTGeExFGUKxmZwrfnzw4zpf7SPhPgfiLDJkUEV`.
- The 2026 authority-change transaction succeeded; signer was `CisJJST2EVYEfnihh4yMtoXRQLiTG93bZpcv83xJaGNT`.

## Source / release comparison

### Saber v1.7.2

- Pinned v1.7.2 rebuild SHA-256 and published v1.7.2 release SHA-256 both equal `5bd0c7008ba2043b65efe74525e10b19620d4a9687bc5040716d23d18bc5a6cd`.
- Both differ from deployed Mainnet SHA-256 `c1e843...`; therefore this is not an exact binary identity match.
- Historical RBPF disassembly contains 28 one-byte `lddw` pointer-operand differences. The release references `0x1000341b8` 24 times and `0x1000341d8` 4 times; Mainnet uses the reverse counts.
- The `.data.rel.ro` section differs at two pointer fields, which swap references to `0x28908` and `0x28948`.
- The 28 changed `lddw` operands are exactly the references to the two adjacent 32-byte records at `0x1000341b8` and `0x1000341d8`: 24 references in `function_542` and 4 in `function_7784`; Mainnet reverses which record each group references.
- The `.data.rel.ro` records are otherwise identical, with only the two 32-bit pointer values at file offsets `0x341d4` and `0x341f4` swapped (`0x28908` / `0x28948`).
- The 64-byte target blocks at `0x28908` and `0x28948` are identical between release and Mainnet at the same address, but differ from each other. Disassembly identifies the first block as the formatter that emits `BorrowError` (11 bytes) and the second as the formatter that emits `BorrowMutError` (14 bytes).
- All 24 call sites that format the panic prefix `already mutably borrowed` pass record `0x1000341b8`; all 4 call sites that format `already borrowed` pass record `0x1000341d8`. In the v1.7.2 release, those records point respectively to the `BorrowError` and `BorrowMutError` formatters. In Mainnet, the two formatter pointers are swapped. Thus, on these exceptional `RefCell` borrow-panic paths, Mainnet's debug type suffix is reversed: the `already mutably borrowed` path formats `BorrowMutError`, and the `already borrowed` path formats `BorrowError`. The panic still occurs; the identified difference is the diagnostic type label, not the normal swap/accounting instruction path. This interpretation is grounded in the actual string literals, function bodies, and all 28 call sites.
- After normalizing the two pointer operands, the complete 25,558-line RBPF disassemblies are identical. This establishes instruction-stream identity modulo those pointer operands. The observed behavioral difference is confined to the debug label in these panic diagnostics; it does not establish exact source provenance or prove behavior in every untested execution path.
- This is strong evidence of a very close v1.7.2 relationship, but not proof that the deployed binary is the exact v1.7.2 artifact, exact source commit, or behaviorally identical in every case.

### Saber v1.6.9

- Rebuilt upgrade-era v1.6.9 source with Anchor 0.22.0 SHA-256: `5dfdbd04e39bf2d1291596c1abbd856c2f21ad1c3371b6075a15f89842102824`.
- This differs from Mainnet SHA-256 `c1e843...`.
- An independent control build of the unchanged v1.6.9 source with Anchor 0.22.0 reproduced the same executable hash as the historical Anchor 0.20.1 build (`5dfdbd04...`). This rules out the tested Anchor 0.20.1 vs 0.22.0 CLI choice as the cause of the mismatch.
- Earlier disassembly comparison found 3,584 line-level differences. v1.6.9 is not a confirmed Mainnet match.
- The original workflow temporarily removes `solana_version` from `Anchor.toml` only for the Anchor build command and restores the file via a shell trap; the pinned Solana 1.8.14 SDK/toolchain is used. The source commit and `flake.lock` hash are recorded in the evidence artifact.

### Other published releases

- Tested v1.8.2, v1.8.1, v1.8.0 and v1.7.3 release hashes differ from the deployed Mainnet hash.
- The published Anchor.so Mainnet artifact is labelled “Unverified Binary”; it is not an independent source-verification attestation.

## Conclusion

1. The historical Upgrade transaction is identified and succeeded.
2. The complete buffer payload was reconstructed without gaps; its trimmed SHA-256 exactly matches the deployed Mainnet executable.
3. The upgrade was invoked through Goki OwnerInvokeInstructionV2 with the Goki wallet as the loader authority.
4. The closest tested public source/release match is v1.7.2 at the instruction-disassembly level. The two swapped static pointers have now been traced to `BorrowError` / `BorrowMutError` debug formatters: Mainnet reverses the type label in 28 exceptional `RefCell` borrow-panic diagnostics (24 `already mutably borrowed` paths and 4 `already borrowed` paths). No normal swap/accounting logic difference was found in the normalized instruction stream. Exact release-binary identity is not established.
5. v1.6.9 and the tested later release binaries are not exact Mainnet hash matches.
6. The precise source commit/fork and historical build recipe that produced the deployed binary remain unproven. A follow-up binary/source chronology check below finds that Mainnet's instruction stream is extremely close to v1.7.2, including a swap-rounding change publicly merged after the Mainnet deployment date. This creates a source-history chronology conflict that cannot currently be resolved from public Git history.

## Safety boundary

All work recorded here is read-only Mainnet inspection and forensic-branch evidence. No Mainnet transaction, SOL transfer, production deployment, merge, or Saber source modification was made.


## Addendum: public-source chronology and executable text cross-check

This follow-up compares the actual ELF `.text` sections in the retained forensic artifacts and checks the public source history for the swap-rounding change.

- Mainnet `.text`: 190,664 bytes; SHA-256 `6b841dc63b3e446d57ec0cba631ad74eca58fb847af88f4461ca066cb175fac3`.
- v1.7.2 release `.text`: 190,664 bytes; SHA-256 `e70583fc7bed284f1e2056300ecc92cc1be0a2e7e1d69b4a0e5464e078b3061f`. Only 28 byte values differ from Mainnet, corresponding to the previously documented 28 `lddw` pointer operands.
- v1.6.9 rebuilt `.text`: 190,608 bytes; SHA-256 `48448b111e6b35e64b1995ab8337fa05752e947aabdc87f6d3902cbd09878bbb`. Across the shared 190,608-byte prefix, 37,467 byte positions differ from v1.7.2.
- Public v1.6.9 release commit `0386247a4b83bda3f0580f24b3bbdea988c15694` is dated 2022-02-07 01:15 UTC. The Mainnet Upgrade transaction's blockTime is 2022-02-07 06:45:49 UTC.
- The public PR [#132, “Patch rounding issue”](https://github.com/saber-hq/stable-swap/pull/132) merged at 2022-02-26 07:06:18 UTC (merge commit `05650f989c6f03b67fcb496a24269cfd3ed08ccd`). It changes the on-chain math in `stable-swap-math/src/curve.rs` from `swap_destination_amount.checked_sub(y)?` to `swap_destination_amount.checked_sub(y)?.checked_sub(1)?`. The public v1.6.9 source has the former expression; v1.7.2 has the latter.
- The Mainnet `.text` section matches the v1.7.2 release's instruction stream except for the 28 previously identified pointer-operand bytes. Therefore, the Mainnet executable is much closer to the later public v1.7.2 machine code than to the tested v1.6.9 rebuild, and its instruction stream includes the rounding behavior present in the post-deployment public PR.
- This is a chronology conflict: the public PR introducing that source change merged 19 days after the Upgrade transaction's blockTime. Plausible explanations include that the same change existed in an unpublished/private source revision before the public PR, that the deployed program came from another source fork/revision, or that an input to the historical source/build attribution is incomplete. The current evidence does not distinguish these explanations and does not identify the exact deployed source commit.
- This does not, by itself, establish misconduct or a security vulnerability. It establishes that the public v1.6.9 source is not a satisfactory source-provenance explanation for the deployed instruction stream, while the later public v1.7.2 build is a very close machine-code match but postdates deployment.

The earlier statement that no normal swap/accounting instruction-path difference was found is specifically relative to v1.7.2: Mainnet and v1.7.2 have identical normalized instruction streams. It must not be read as a claim that Mainnet matches v1.6.9's swap-rounding behavior.
