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
  DEFAULT_CALL_GAS_LIMIT,
  DOMAIN_TAG_STR,
  KEYED_HASH_TAG_STR,
  MAX_TX_GAS_LIMIT,
  TX_DOMAIN,
  TX_KEY,
  type CallTxKind,
  type CallTxKindInput,
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
