/**
 * kovanica-sdk — Official TypeScript SDK for Kovanica (KVNC) Layer-1 Blockchain
 */

// Client & Transport
export {
  KovanicaClient,
  type KovanicaClientOptions,
  isNodeSynced,
  parseSafeOptionalQuantity,
} from "./client";
export {
  HttpTransport,
  type HttpTransportOptions,
  type Transport,
  parseLosslessJson,
} from "./transport";
export {
  KovanicaWsClient,
  type KovanicaWsClientOptions,
  type WsCommittedLeaderEvent,
  type WsExecutionEvent,
  type WsLogFilter,
  type WsLogReceipt,
  type WsNewHeadEvent,
  type WsSubscriptionCallback,
  type WsSubscriptionNotification,
} from "./ws";

// Types & Schemas
export type {
  BlockResponse,
  DagTips,
  JsonRpcErrorObject,
  JsonRpcRequest,
  JsonRpcResponse,
  LeaderSlot,
  MiningInfo,
  RequestOptions,
  SyncPeerStatus,
  SyncStatus,
  TransactionKind,
  TransactionReceipt,
  TransactionResponse,
  ValidatorInfo,
} from "./types";

// Errors
export {
  KovanicaAbortError,
  KovanicaError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "./errors";

// Units & Quantities
export {
  ATOMS_PER_KVNC,
  DECIMALS,
  formatKvnc,
  parseKvnc,
  parseQuantity,
  toHexQuantity,
} from "./units";

// Chains
export {
  CHAIN_IDS,
  type ChainConfig,
  type ChainId,
  getChainConfig,
  isLegacyAddressAllowed,
  KNOWN_CHAINS,
  NETWORK_TAGS,
} from "./chains";

// Address Utilities
export {
  ADDRESS_BODY_CHARS,
  ADDRESS_CHECKSUM_BITS,
  ADDRESS_LEN,
  ADDRESS_PAYLOAD_LEN,
  ADDRESS_PREFIX,
  ADDRESS_SUFFIX,
  TESTNET_ADDRESS_PREFIX,
  checksum29,
  decodeAddress,
  encodeAddress,
  isValidAddress,
  legacyChecksum,
  parseAddressForChain,
  parseLegacyAddress,
} from "./address";

// HD Wallet & Key Derivation (BIP-39 / BIP-44 / SLIP-0010)
export {
  BIP44_PURPOSE,
  DEV_COIN_TYPE,
  HARDENED_OFFSET,
  KOVANICA_COIN_TYPE,
  LEGACY_COIN_TYPE,
  KovanicaWallet,
  type DerivedAccount,
  type Slip10Node,
  addressFromSeed,
  bip39Seed,
  deriveBip44,
  deriveHardened,
  derivePath,
  formatBip44Path,
  getPublicKey,
  masterFromSeed,
  wipe,
} from "./wallet";

// Smart Contract Argument Builders, Bincode Encoders & Transaction Signers
export {
  CALL_TX_FIXED_WIRE_OVERHEAD,
  DEFAULT_CALL_GAS_LIMIT,
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  DEFAULT_GAS_SAFETY_MARGIN_BPS,
  DOMAIN_TAG_STR,
  KEYED_HASH_TAG_STR,
  MAX_TX_GAS_LIMIT,
  TX_DOMAIN,
  TX_KEY,
  type CallTxKind,
  type CallTxKindInput,
  type EstimateAndBuildCallClient,
  type EstimateAndBuildCallOptions,
  type PreparedCallTransaction,
  type SignedTxResult,
  asciiPad,
  buildCallTxKind,
  buildEscrowCreateCall,
  buildEscrowCreateCallTx,
  buildHtlcCreateCall,
  buildHtlcCreateCallTx,
  buildNameRegisterCall,
  buildNameRegisterCallTx,
  buildNftMintCall,
  buildNftMintCallTx,
  buildTokenTransferCall,
  buildVaultCreateCall,
  bytesToHex,
  computeCallTransactionSigningHash,
  concatBytes,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  encodeBincodeStringVec,
  encodeEscrowCreateArgs,
  encodeHtlcCreateArgs,
  encodeNameRegisterArgs,
  encodeNftMintArgs,
  estimateAndBuildCall,
  estimateCallTxSize,
  hexToBytes,
  parseContractAddress,
  signCallContractTransaction,
  signEd25519,
  signingCallKindBytes,
  u32le,
  u64le,
  u128le,
  wireCallKindBytes,
} from "./contracts";

// Contract State & Record Bincode Decoders + Storage Slot Derivation
export {
  BincodeReader,
  KovanicaDecodeError,
  STORAGE_KEY_PREFIXES,
  type DecodeErrorCode,
  type EscrowRecord,
  type EscrowStatus,
  type HtlcRecord,
  type HtlcStatus,
  type MultisigPendingTx,
  type MultisigState,
  type NameRecord,
  type NftMetadata,
  type NftTokenEntry,
  type StorageSlotContract,
  type StorageSlotKey,
  type TokenAllowanceEntry,
  type TokenBalanceEntry,
  type TokenMetadata,
  type TokenPoolState,
  type VaultRecord,
  type VaultSchedule,
  decodeEscrowRecord,
  decodeHtlcRecord,
  decodeMultisigPendingTx,
  decodeMultisigState,
  decodeNameRecord,
  decodeNftMetadata,
  decodeNftState,
  decodeTokenMetadata,
  decodeTokenPool,
  decodeTokenState,
  decodeVaultRecord,
  derivePrefixedStorageSlot,
  deriveStorageSlot,
  deriveStorageSlotHex,
} from "./decoders";
