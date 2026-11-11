import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BPF_UPGRADEABLE_LOADER_ID,
  inspectUpgradeableProgramAccounts
} from "../solana-upgradeable-program.mjs";

function fixture({ authority = Keypair.generate().publicKey, tag = 1 } = {}) {
  const programId = Keypair.generate().publicKey.toBase58();
  const programDataAddress = Keypair.generate().publicKey;
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5]);
  const executableOffset = tag === 1 ? 45 : 13;
  const programData = Buffer.alloc(executableOffset + elf.length);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(119721738n, 4);
  programData[12] = tag;
  if (tag === 1) authority.toBuffer().copy(programData, 13);
  elf.copy(programData, executableOffset);
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  programDataAddress.toBuffer().copy(program, 4);
  return {
    programId,
    programAccount: {
      owner: new PublicKey(BPF_UPGRADEABLE_LOADER_ID),
      executable: true,
      data: program
    },
    programDataAccount: {
      owner: new PublicKey(BPF_UPGRADEABLE_LOADER_ID),
      executable: false,
      data: programData
    },
    programDataAddress: programDataAddress.toBase58(),
    elf,
    authority
  };
}

test("Upgradeable Program and ProgramData parser extracts slot, authority and ELF hash", () => {
  const f = fixture();
  const result = inspectUpgradeableProgramAccounts(f);
  assert.equal(result.programId, f.programId);
  assert.equal(result.programDataAddress, f.programDataAddress);
  assert.equal(result.deploymentSlot, "119721738");
  assert.equal(result.upgradeAuthority, f.authority.toBase58());
  assert.equal(result.immutable, false);
  assert.equal(result.executableOffset, 45);
  assert.equal(result.executableLength, f.elf.length);
  assert.equal(result.executableSha256, createHash("sha256").update(f.elf).digest("hex"));
});

test("Upgradeable ProgramData parser handles immutable programs and 13-byte header", () => {
  const f = fixture({ authority: null, tag: 0 });
  const result = inspectUpgradeableProgramAccounts(f);
  assert.equal(result.upgradeAuthority, null);
  assert.equal(result.immutable, true);
  assert.equal(result.executableOffset, 13);
  assert.equal(result.executableLength, f.elf.length);
});

test("Upgradeable Program parser rejects wrong loader, executable flags, state and data lengths", () => {
  const wrongOwner = fixture();
  wrongOwner.programAccount.owner = Keypair.generate().publicKey;
  assert.throws(() => inspectUpgradeableProgramAccounts(wrongOwner), /owned by the upgradeable BPF loader/);

  const notExecutable = fixture();
  notExecutable.programAccount.executable = false;
  assert.throws(() => inspectUpgradeableProgramAccounts(notExecutable), /Program account state/);

  const wrongState = fixture();
  wrongState.programAccount.data.writeUInt32LE(1, 0);
  assert.throws(() => inspectUpgradeableProgramAccounts(wrongState), /Program account state/);

  const wrongLength = fixture();
  wrongLength.programAccount.data = Buffer.alloc(37);
  assert.throws(() => inspectUpgradeableProgramAccounts(wrongLength), /Program account state/);
});

test("Upgradeable ProgramData parser rejects bad authority tag, short header and non-ELF bytes", () => {
  const badTag = fixture();
  badTag.programDataAccount.data[12] = 2;
  assert.throws(() => inspectUpgradeableProgramAccounts(badTag), /authority option tag/);

  const short = fixture();
  short.programDataAccount.data = short.programDataAccount.data.subarray(0, 20);
  assert.throws(() => inspectUpgradeableProgramAccounts(short), /authority header is truncated/);

  const badElf = fixture();
  badElf.programDataAccount.data.fill(0, 45, 49);
  assert.throws(() => inspectUpgradeableProgramAccounts(badElf), /ELF executable/);

  const wrongProgramDataOwner = fixture();
  wrongProgramDataOwner.programDataAccount.owner = Keypair.generate().publicKey;
  assert.throws(() => inspectUpgradeableProgramAccounts(wrongProgramDataOwner), /owned by the upgradeable BPF loader/);
});
