/**
 * Typed Contract Client Facades for Kovanica L1 Standard Contracts.
 *
 * Wraps the SDK's low-level Bincode call builders, storage slot readers,
 * dry-run simulator (`dryRunCall`), and fee/nonce estimator (`estimateAndBuildCall`)
 * behind ergonomic, contract-specific clients:
 * - {@link NameRegistryClient}
 * - {@link TokenClient}
 * - {@link EscrowClient}
 * - {@link HtlcClient}
 * - {@link NftClient}
 * - {@link VaultClient}
 * - {@link MultisigClient}
 */

import { encodeAddress } from "./address";
import {
  type CallTxKindInput,
  type DryRunCallClient,
  type DryRunCallOptions,
  type EstimateAndBuildCallClient,
  type EstimateAndBuildCallOptions,
  type PreparedCallTransaction,
  buildEscrowCreateCall,
  buildHtlcCreateCall,
  buildNameRegisterCall,
  buildNftMintCall,
  buildRwaBurnCall,
  buildRwaCreateCall,
  buildRwaFreezeCall,
  buildRwaMintCall,
  buildRwaTransferCall,
  buildRwaUpdateMetadataCall,
  buildTokenTransferCall,
  buildVaultCreateCall,
  type RwaAssetClass,
  bytesToHex,
  concatBytes,
  dryRunCall,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  estimateAndBuildCall,
  hexToBytes,
  parseContractAddress,
  u32le,
  u64le,
  u128le,
} from "./contracts";
import {
  type EscrowRecord,
  type HtlcRecord,
  type MultisigPendingTx,
  type MultisigState,
  type NameRecord,
  type NftMetadata,
  type ReadContractStorageClient,
  type ReadContractStorageOptions,
  type TokenMetadata,
  type VaultRecord,
  decodeNameRecord,
  readContractStorage,
} from "./decoders";
import type { KovanicaAddress } from "./types";

// --- Shared Facade Client Interface & Base Class ---

/**
 * Minimal client interface required by all typed contract client facades.
 * Satisfied by {@link KovanicaClient}.
 */
export interface ContractFacadeClient
  extends DryRunCallClient,
    EstimateAndBuildCallClient,
    ReadContractStorageClient {}

function assertFacadeClient(client: ContractFacadeClient, facadeName: string): void {
  if (!client || typeof client !== "object") {
    throw new TypeError(`${facadeName}: client must be a valid ContractFacadeClient object`);
  }
  if (
    typeof client.call !== "function" ||
    typeof client.estimateFee !== "function" ||
    typeof client.getNonce !== "function" ||
    typeof client.getStorageAt !== "function"
  ) {
    throw new TypeError(
      `${facadeName}: client must implement call, estimateFee, getNonce, and getStorageAt`,
    );
  }
}

function parseBytes32Address(input: Uint8Array | string, label: string): Uint8Array {
  if (!(input instanceof Uint8Array) && typeof input !== "string") {
    throw new TypeError(`${label}: expected a 32-byte Uint8Array, hex string, or PRO-21 address`);
  }
  try {
    return parseContractAddress(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: ${detail}`);
  }
}

function parseBytes32Hash(input: Uint8Array | string, label: string): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) {
      throw new Error(`${label}: expected 32 bytes, got ${input.length}`);
    }
    return input;
  }
  if (typeof input !== "string") {
    throw new TypeError(`${label}: expected a 32-byte Uint8Array or 64-character hex string`);
  }
  const trimmed = input.trim();
  const clean = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`${label}: expected 32-byte (64-character) hex string`);
  }
  return hexToBytes(clean);
}

/**
 * Shared base class for typed contract client facades.
 * Validates the target contract address fail-closed at construction time.
 */
export abstract class ContractFacade {
  readonly client: ContractFacadeClient;
  readonly contractBytes: Uint8Array;
  readonly contractAddress: KovanicaAddress;
  readonly contractHex: string;

  constructor(client: ContractFacadeClient, contract: Uint8Array | string, facadeName: string) {
    assertFacadeClient(client, facadeName);
    const parsed = parseBytes32Address(contract, `${facadeName} contract`);
    this.client = client;
    this.contractBytes = new Uint8Array(parsed);
    this.contractAddress = encodeAddress(this.contractBytes);
    this.contractHex = bytesToHex(this.contractBytes);
  }
}

// --- Name Registry Facade ---

export type NameResolveOptions = Omit<DryRunCallOptions<NameRecord>, "decoder">;

export interface NameRegisterParams {
  /** Human-readable name to register (e.g. `"alice"`). */
  name: string;
  /** 32-byte Ed25519 comms public key (`Uint8Array`, 64-char hex, or PRO-21 address). */
  pubkey: Uint8Array | string;
  /** Optional relay endpoint URLs (`http(s)://...`). Defaults to `[]`. */
  relayEndpoints?: string[];
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-name-registry` contract.
 */
export class NameRegistryClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "NameRegistryClient");
  }

  /**
   * Simulates `name_resolve(name)` via `kovanica_call` (`dryRunCall`) and decodes the returned
   * Bincode {@link NameRecord}.
   */
  async resolve(name: string, options?: NameResolveOptions): Promise<NameRecord> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("NameRegistryClient.resolve: name must be a non-empty string");
    }
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "name_resolve",
      args: encodeBincodeString(name.trim()),
    };
    const result = await dryRunCall(this.client, call, {
      ...options,
      decoder: decodeNameRecord,
    });
    return result.decoded;
  }

  /**
   * Reads a name entry directly from canonical contract storage (`blake3("kvnc/v1/name/" || lowercaseName)`)
   * via `readContractStorage`. Returns `null` when the storage slot is empty.
   */
  async getRecord(
    name: string,
    options?: ReadContractStorageOptions,
  ): Promise<NameRecord | null> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("NameRegistryClient.getRecord: name must be a non-empty string");
    }
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "name", key: name },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates a `name_register` contract call via `estimateAndBuildCall`.
   */
  async prepareRegister(
    params: NameRegisterParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("NameRegistryClient.prepareRegister: params must be an object");
    }
    if (typeof params.name !== "string" || params.name.trim().length === 0) {
      throw new Error("NameRegistryClient.prepareRegister: name must be a non-empty string");
    }
    const pubkeyBytes = parseBytes32Address(
      params.pubkey,
      "NameRegistryClient.prepareRegister pubkey",
    );
    const relayEndpoints = params.relayEndpoints ?? [];
    if (
      !Array.isArray(relayEndpoints) ||
      !relayEndpoints.every((ep) => typeof ep === "string")
    ) {
      throw new TypeError(
        "NameRegistryClient.prepareRegister: relayEndpoints must be an array of strings",
      );
    }

    const args = buildNameRegisterCall(params.name.trim(), pubkeyBytes, relayEndpoints);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "name_register",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- Token Facade ---

export interface TokenTransferParams {
  /** Recipient account (`Uint8Array`, 64-char hex, or PRO-21 `kvnc...dag` / `tknc...dag` address). */
  recipient: Uint8Array | string;
  /** Amount of token base units (`u128`) to transfer. */
  amount: bigint | number;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-token` contract.
 */
export class TokenClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "TokenClient");
  }

  /**
   * Reads canonical token metadata/state (`blake3("kvnc/v1/state")`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getMetadata(options?: ReadContractStorageOptions): Promise<TokenMetadata | null> {
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "token", decoder: "token_metadata" },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates a `token_transfer` contract call via `estimateAndBuildCall`.
   */
  async prepareTransfer(
    params: TokenTransferParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("TokenClient.prepareTransfer: params must be an object");
    }
    const recipientBytes = parseBytes32Address(
      params.recipient,
      "TokenClient.prepareTransfer recipient",
    );
    const built = buildTokenTransferCall(this.contractBytes, recipientBytes, params.amount);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: built.method,
      args: built.args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- Escrow Facade ---

export interface EscrowCreateParams {
  /** Participating party addresses (`Uint8Array`, 64-char hex, or PRO-21 address). */
  parties: ReadonlyArray<Uint8Array | string>;
  /** Required approval threshold (`1 <= threshold <= parties.length`, `<= 255`). */
  threshold: number;
  /** Escrow amount (`u64`). */
  amount: bigint | number;
  /** Escrow deadline (`u64`). */
  deadline: bigint | number;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-escrow` contract.
 */
export class EscrowClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "EscrowClient");
  }

  /**
   * Reads a canonical escrow record (`blake3("kvnc/v1/escrow/" || escrowId32)`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getEscrow(
    id: Uint8Array | string,
    options?: ReadContractStorageOptions,
  ): Promise<EscrowRecord | null> {
    const idBytes = parseBytes32Hash(id, "EscrowClient.getEscrow id");
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "escrow", key: idBytes },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates an `escrow_create` contract call via `estimateAndBuildCall`.
   */
  async prepareCreate(
    params: EscrowCreateParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("EscrowClient.prepareCreate: params must be an object");
    }
    if (!Array.isArray(params.parties) || params.parties.length === 0) {
      throw new Error("EscrowClient.prepareCreate: parties must be a non-empty array");
    }
    const partyBytes = params.parties.map((party, i) =>
      parseBytes32Address(party, `EscrowClient.prepareCreate parties[${i}]`),
    );
    const args = buildEscrowCreateCall(
      partyBytes,
      params.threshold,
      params.amount,
      params.deadline,
    );
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "escrow_create",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- HTLC Facade ---

export interface HtlcCreateParams {
  /** 32-byte hashlock (`Uint8Array` or 64-character hex string). */
  hashlock: Uint8Array | string;
  /** Timelock expiry (`u64`). */
  timelock: bigint | number;
  /** Recipient/claimer address (`Uint8Array`, 64-char hex, or PRO-21 address). */
  recipient: Uint8Array | string;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-htlc` contract.
 */
export class HtlcClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "HtlcClient");
  }

  /**
   * Reads a canonical HTLC record (`blake3("kvnc/v1/htlc/" || swapId32)`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getHtlc(
    id: Uint8Array | string,
    options?: ReadContractStorageOptions,
  ): Promise<HtlcRecord | null> {
    const idBytes = parseBytes32Hash(id, "HtlcClient.getHtlc id");
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "htlc", key: idBytes },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates an `htlc_create` contract call via `estimateAndBuildCall`.
   */
  async prepareCreate(
    params: HtlcCreateParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("HtlcClient.prepareCreate: params must be an object");
    }
    const hashlockBytes = parseBytes32Hash(
      params.hashlock,
      "HtlcClient.prepareCreate hashlock",
    );
    const recipientBytes = parseBytes32Address(
      params.recipient,
      "HtlcClient.prepareCreate recipient",
    );
    const args = buildHtlcCreateCall(hashlockBytes, params.timelock, recipientBytes);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "htlc_create",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- NFT Facade ---

export interface NftMintParams {
  /** Optional 32-byte collection address/ID (`Uint8Array`, 64-char hex, or PRO-21 address). Defaults to this client's contract address. */
  collection?: Uint8Array | string;
  /** Recipient account (`Uint8Array`, 64-char hex, or PRO-21 address). */
  to: Uint8Array | string;
  /** Token ID (`u128`). */
  tokenId: bigint | number;
  /** Token metadata URI (e.g. `"ipfs://..."` or `"https://..."`). */
  tokenUri: string;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-nft` contract.
 */
export class NftClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "NftClient");
  }

  /**
   * Reads canonical NFT collection metadata/state (`blake3("kvnc/v1/state")`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getMetadata(options?: ReadContractStorageOptions): Promise<NftMetadata | null> {
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "nft", decoder: "nft_metadata" },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates an `nft_mint` contract call via `buildNftMintCall` + `estimateAndBuildCall`.
   */
  async prepareMint(
    params: NftMintParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("NftClient.prepareMint: params must be an object");
    }
    const collectionBytes =
      params.collection !== undefined
        ? parseBytes32Address(params.collection, "NftClient.prepareMint collection")
        : this.contractBytes;
    const toBytes = parseBytes32Address(params.to, "NftClient.prepareMint to");
    if (typeof params.tokenUri !== "string") {
      throw new TypeError("NftClient.prepareMint: tokenUri must be a string");
    }
    const args = buildNftMintCall(collectionBytes, toBytes, params.tokenId, params.tokenUri);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "nft_mint",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- RWA (KVP-106) Facade ---

export interface RwaCreateParams {
  name: string;
  symbol: string;
  assetClass: RwaAssetClass;
  uniqueId: string;
  version: number;
  jurisdiction?: string;
  metadataHash: Uint8Array | string;
  metadataUri?: string;
  legalUri?: string;
  custodyUri?: string;
  decimals: number;
  maxSupply: bigint | number;
  initialSupply: bigint | number;
  value?: bigint | number;
  gasLimit?: bigint | number;
}

export interface RwaMintParams {
  to: Uint8Array | string;
  amount: bigint | number;
  value?: bigint | number;
  gasLimit?: bigint | number;
}

export interface RwaTransferParams {
  to: Uint8Array | string;
  amount: bigint | number;
  value?: bigint | number;
  gasLimit?: bigint | number;
}

export interface RwaFreezeParams {
  account: Uint8Array | string;
  frozen: boolean;
  value?: bigint | number;
  gasLimit?: bigint | number;
}

export interface RwaUpdateMetadataParams {
  metadataHash: Uint8Array | string;
  metadataUri?: string;
  legalUri?: string;
  custodyUri?: string;
  value?: bigint | number;
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed KVP-106 `kovanica-rwa` contract.
 */
export class RwaClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "RwaClient");
  }

  async prepareCreate(
    params: RwaCreateParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const hashBytes =
      typeof params.metadataHash === "string"
        ? hexToBytes(params.metadataHash.replace(/^0x/, ""))
        : params.metadataHash;
    const args = buildRwaCreateCall({
      ...params,
      metadataHash: hashBytes,
    });
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_create",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareMint(
    params: RwaMintParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const toBytes = parseBytes32Address(params.to, "RwaClient.prepareMint to");
    const args = buildRwaMintCall(toBytes, params.amount);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_mint",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareTransfer(
    params: RwaTransferParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const toBytes = parseBytes32Address(params.to, "RwaClient.prepareTransfer to");
    const args = buildRwaTransferCall(toBytes, params.amount);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_transfer",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareBurn(
    amount: bigint | number,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const args = buildRwaBurnCall(amount);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_burn",
      args,
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareFreeze(
    params: RwaFreezeParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const accountBytes = parseBytes32Address(params.account, "RwaClient.prepareFreeze account");
    const args = buildRwaFreezeCall(accountBytes, params.frozen);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_freeze",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareUpdateMetadata(
    params: RwaUpdateMetadataParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const hashBytes =
      typeof params.metadataHash === "string"
        ? hexToBytes(params.metadataHash.replace(/^0x/, ""))
        : params.metadataHash;
    const args = buildRwaUpdateMetadataCall({
      ...params,
      metadataHash: hashBytes,
    });
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "rwa_update_metadata",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- Vault Facade ---

export interface VaultCreateParams {
  /** Beneficiary account (`Uint8Array`, 64-char hex, or PRO-21 address). */
  beneficiary: Uint8Array | string;
  /** Total vault amount in atoms (`u128`). */
  amount: bigint | number;
  /** Absolute unlock timestamp/height (`u64`). */
  lockUntil: bigint | number;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-vault` contract.
 */
export class VaultClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "VaultClient");
  }

  /**
   * Reads a canonical vault record (`blake3("kvnc/v1/vault/" || vaultId32)`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getVault(
    id: Uint8Array | string,
    options?: ReadContractStorageOptions,
  ): Promise<VaultRecord | null> {
    const idBytes = parseBytes32Hash(id, "VaultClient.getVault id");
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "vault", key: idBytes },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates a `vault_create` contract call via `buildVaultCreateCall` + `estimateAndBuildCall`.
   */
  async prepareCreate(
    params: VaultCreateParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("VaultClient.prepareCreate: params must be an object");
    }
    const beneficiaryBytes = parseBytes32Address(
      params.beneficiary,
      "VaultClient.prepareCreate beneficiary",
    );
    const built = buildVaultCreateCall(
      this.contractBytes,
      beneficiaryBytes,
      params.amount,
      params.lockUntil,
    );
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: built.method,
      args: built.args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}

// --- Multisig Facade ---

function parseOptionalCallData(input: Uint8Array | string | undefined, label: string): Uint8Array {
  if (input === undefined) {
    return new Uint8Array(0);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof input !== "string") {
    throw new TypeError(`${label}: expected a Uint8Array or hex string`);
  }
  const trimmed = input.trim();
  const clean = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length === 0) {
    return new Uint8Array(0);
  }
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`${label}: invalid hex string`);
  }
  return hexToBytes(clean);
}

function encodeTxIdU64(txId: bigint | number, label: string): Uint8Array {
  if (typeof txId !== "bigint" && typeof txId !== "number") {
    throw new TypeError(`${label}: txId must be a bigint or non-negative integer`);
  }
  if (typeof txId === "number" && !Number.isSafeInteger(txId)) {
    throw new RangeError(`${label}: txId must be a safe integer, got ${txId}`);
  }
  return u64le(txId);
}

export interface MultisigCreateParams {
  /** Owner accounts (`Uint8Array`, 64-char hex, or PRO-21 address). */
  owners: ReadonlyArray<Uint8Array | string>;
  /** Required approval threshold (`1 <= threshold <= owners.length`). */
  threshold: number;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

export interface MultisigProposeParams {
  /** 32-byte multisig configuration fingerprint ID (`Uint8Array` or 64-character hex string). */
  multisigId: Uint8Array | string;
  /** Recipient account (`Uint8Array`, 64-char hex, or PRO-21 address). */
  to: Uint8Array | string;
  /** Transfer amount in atoms (`u128`). */
  amount: bigint | number;
  /** Optional call data (`Uint8Array` or hex string). Defaults to empty bytes. */
  data?: Uint8Array | string;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

export interface MultisigTxParams {
  /** 32-byte multisig configuration fingerprint ID (`Uint8Array` or 64-character hex string). */
  multisigId: Uint8Array | string;
  /** Pending transaction ID (`u64`). */
  txId: bigint | number;
  /** Optional call value in atoms. */
  value?: bigint | number;
  /** Optional explicit gas limit override. */
  gasLimit?: bigint | number;
}

/**
 * Typed client facade for a deployed `kovanica-multisig` contract.
 */
export class MultisigClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "MultisigClient");
  }

  /**
   * Reads canonical multisig singleton state (`blake3("kvnc/v1/state")`) via `readContractStorage`.
   * Returns `null` when the storage slot is empty.
   */
  async getState(options?: ReadContractStorageOptions): Promise<MultisigState | null> {
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "multisig", decoder: "multisig_state" },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Reads a canonical pending multisig transaction (`blake3("kvnc/v1/mtx/" || u64le(txId))`)
   * via `readContractStorage`. Returns `null` when the storage slot is empty.
   */
  async getPendingTx(
    txId: bigint | number,
    options?: ReadContractStorageOptions,
  ): Promise<MultisigPendingTx | null> {
    const txIdBytes = encodeTxIdU64(txId, "MultisigClient.getPendingTx");
    const result = await readContractStorage(
      this.client,
      this.contractBytes,
      { kind: "multisig_tx", key: txIdBytes },
      options,
    );
    return result.isEmpty ? null : (result.decoded ?? null);
  }

  /**
   * Builds and estimates a `multisig_create` contract call (`(Vec<[u8;32]>, u32)`)
   * via `estimateAndBuildCall`.
   */
  async prepareCreate(
    params: MultisigCreateParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("MultisigClient.prepareCreate: params must be an object");
    }
    if (!Array.isArray(params.owners) || params.owners.length === 0) {
      throw new Error("MultisigClient.prepareCreate: owners must be a non-empty array");
    }
    if (
      !Number.isInteger(params.threshold) ||
      params.threshold < 1 ||
      params.threshold > params.owners.length
    ) {
      throw new RangeError(
        `MultisigClient.prepareCreate: threshold must be an integer between 1 and ${params.owners.length}, got ${params.threshold}`,
      );
    }
    const ownerBytes = params.owners.map((owner, i) =>
      parseBytes32Address(owner, `MultisigClient.prepareCreate owners[${i}]`),
    );
    const args = concatBytes([encodeBincodeBytes32Vec(ownerBytes), u32le(params.threshold)]);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "multisig_create",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  /**
   * Builds and estimates a `multisig_propose` contract call (`([u8;32], [u8;32], u128, Vec<u8>)`)
   * via `estimateAndBuildCall`.
   */
  async preparePropose(
    params: MultisigProposeParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("MultisigClient.preparePropose: params must be an object");
    }
    const idBytes = parseBytes32Hash(
      params.multisigId,
      "MultisigClient.preparePropose multisigId",
    );
    const toBytes = parseBytes32Address(params.to, "MultisigClient.preparePropose to");
    const amountBytes = u128le(params.amount);
    const dataBytes = parseOptionalCallData(params.data, "MultisigClient.preparePropose data");
    const args = concatBytes([
      idBytes,
      toBytes,
      amountBytes,
      u64le(BigInt(dataBytes.length)),
      dataBytes,
    ]);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "multisig_propose",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  /**
   * Builds and estimates a `multisig_confirm` contract call (`([u8;32], u64)`)
   * via `estimateAndBuildCall`.
   */
  async prepareConfirm(
    params: MultisigTxParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("MultisigClient.prepareConfirm: params must be an object");
    }
    const idBytes = parseBytes32Hash(
      params.multisigId,
      "MultisigClient.prepareConfirm multisigId",
    );
    const txIdBytes = encodeTxIdU64(params.txId, "MultisigClient.prepareConfirm");
    const args = concatBytes([idBytes, txIdBytes]);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "multisig_confirm",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  /**
   * Ergonomic alias for {@link prepareConfirm}: builds and estimates a `multisig_confirm`
   * contract call (`([u8;32], u64)`) via `estimateAndBuildCall`.
   */
  async prepareApprove(
    params: MultisigTxParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    return this.prepareConfirm(params, options);
  }

  /**
   * Builds and estimates a `multisig_execute` contract call (`([u8;32], u64)`)
   * via `estimateAndBuildCall`.
   */
  async prepareExecute(
    params: MultisigTxParams,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    if (!params || typeof params !== "object") {
      throw new TypeError("MultisigClient.prepareExecute: params must be an object");
    }
    const idBytes = parseBytes32Hash(
      params.multisigId,
      "MultisigClient.prepareExecute multisigId",
    );
    const txIdBytes = encodeTxIdU64(params.txId, "MultisigClient.prepareExecute");
    const args = concatBytes([idBytes, txIdBytes]);
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "multisig_execute",
      args,
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }
}
