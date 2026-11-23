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
  buildTokenTransferCall,
  bytesToHex,
  dryRunCall,
  encodeBincodeString,
  estimateAndBuildCall,
  hexToBytes,
  parseContractAddress,
} from "./contracts";
import {
  type EscrowRecord,
  type HtlcRecord,
  type NameRecord,
  type ReadContractStorageClient,
  type ReadContractStorageOptions,
  type TokenMetadata,
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
