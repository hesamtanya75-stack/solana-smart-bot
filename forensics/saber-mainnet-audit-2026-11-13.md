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
- After normalizing those two static pointer addresses, the complete 25,558-line RBPF disassemblies are identical.
- This is strong evidence that the executable instruction logic matches the v1.7.2 release after accounting for static pointer/relocation layout. It is not proof that the deployed binary is the exact v1.7.2 artifact or exact source commit.

### Saber v1.6.9

- Rebuilt upgrade-era v1.6.9 source with Anchor 0.22.0 SHA-256: `5dfdbd04e39bf2d1291596c1abbd856c2f21ad1c3371b6075a15f89842102824`.
- This differs from Mainnet SHA-256 `c1e843...`.
- Earlier disassembly comparison found 3,584 line-level differences. v1.6.9 is not a confirmed Mainnet match.

### Other published releases

- Tested v1.8.2, v1.8.1, v1.8.0 and v1.7.3 release hashes differ from the deployed Mainnet hash.
- The published Anchor.so Mainnet artifact is labelled “Unverified Binary”; it is not an independent source-verification attestation.

## Conclusion

1. The historical Upgrade transaction is identified and succeeded.
2. The complete buffer payload was reconstructed without gaps; its trimmed SHA-256 exactly matches the deployed Mainnet executable.
3. The upgrade was invoked through Goki OwnerInvokeInstructionV2 with the Goki wallet as the loader authority.
4. The closest tested public source/release match is v1.7.2 at the instruction-disassembly level, after normalizing static pointer references. Exact release-binary identity is not established.
5. v1.6.9 and the tested later release binaries are not exact Mainnet hash matches.
6. The precise source commit/fork that produced the deployed binary remains unproven. The remaining source-attribution task is to investigate the two static pointer-table layout differences and any unpublished build/source variation; do not label the source as verified until that is resolved.

## Safety boundary

All work recorded here is read-only Mainnet inspection and forensic-branch evidence. No Mainnet transaction, SOL transfer, production deployment, merge, or Saber source modification was made.
