import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const BPF_UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAM_STATE = 2;
const PROGRAM_DATA_STATE = 3;

function requireAccount(account, name) {
  if (!account || account.owner?.toBase58?.() !== BPF_UPGRADEABLE_LOADER_ID ||
      !Buffer.isBuffer(account.data)) {
    throw new Error(name + " must be raw account data owned by the upgradeable BPF loader");
  }
}

function inspectUpgradeableProgramAccounts({ programId, programAccount, programDataAccount } = {}) {
  let key;
  try { key = new PublicKey(programId).toBase58(); }
  catch { throw new Error("Upgradeable program ID is invalid"); }
  requireAccount(programAccount, "Program account");
  if (programAccount.executable !== true || programAccount.data.length !== 36 ||
      programAccount.data.readUInt32LE(0) !== PROGRAM_STATE) {
    throw new Error("Upgradeable Program account state, executable flag, or exact length is invalid");
  }
  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36)).toBase58();
  requireAccount(programDataAccount, "ProgramData account");
  if (programDataAccount.executable === true || programDataAccount.data.length < 13 ||
      programDataAccount.data.readUInt32LE(0) !== PROGRAM_DATA_STATE) {
    throw new Error("Upgradeable ProgramData account state, executable flag, or length is invalid");
  }
  const data = programDataAccount.data;
  const deploymentSlot = data.readBigUInt64LE(4);
  const authorityTag = data[12];
  let upgradeAuthority = null;
  let executableOffset = 13;
  if (authorityTag === 1) {
    if (data.length < 46) throw new Error("Upgradeable ProgramData authority header is truncated");
    upgradeAuthority = new PublicKey(data.subarray(13, 45)).toBase58();
    executableOffset = 45;
  } else if (authorityTag !== 0) {
    throw new Error("Upgradeable ProgramData authority option tag is invalid");
  }
  const executableBytes = data.subarray(executableOffset);
  if (executableBytes.length < 4 ||
      executableBytes[0] !== 0x7f || executableBytes[1] !== 0x45 ||
      executableBytes[2] !== 0x4c || executableBytes[3] !== 0x46) {
    throw new Error("Upgradeable ProgramData does not contain an ELF executable at the expected offset");
  }
  return Object.freeze({
    programId: key,
    programDataAddress,
    deploymentSlot: deploymentSlot.toString(),
    upgradeAuthority,
    immutable: upgradeAuthority === null,
    executableOffset,
    executableLength: executableBytes.length,
    executableSha256: createHash("sha256").update(executableBytes).digest("hex")
  });
}

export { BPF_UPGRADEABLE_LOADER_ID, inspectUpgradeableProgramAccounts };
