# Changelog

All notable changes to `kovanica-sdk` are documented in this file.

## [0.5.0] - 2026-11-23

### Added
- **Multi-Endpoint Failover RPC Transport & URL Sanitization** (`transport.ts`, `client.ts`):
  - Added `FailoverHttpTransport`, `createFailoverHttpTransport`, and `createFailoverClient` for health-tracked multi-endpoint RPC failover with structured failover telemetry.
  - Added `sanitizeRpcUrl` to strip credentials and sensitive query parameters before logging or emitting endpoint diagnostics.
- **Fee-Buffer Estimation & Abortable Finality Watching** (`finality.ts`):
  - Added `applyFeeBuffer` and `estimateTxFeeWithBuffer` for basis-point fee safety buffering with optional floor/ceiling bounds.
  - Added `waitForTransactionFinality` for abortable receipt and confirmation-depth finality tracking with progress callbacks.
- **Offline Signed Call Transaction Decoder, Ed25519 Verification & RPC Node Probe** (`tx-decode.ts`, `probe.ts`):
  - Added `decodeSignedCallTransaction`, `verifyCallTransactionSignature`, and `verifyEd25519` for offline inspection and RFC 8032 Ed25519 signature verification of wire Call transactions.
  - Added `probeRpcNode` to inspect node RPC capabilities, chain metadata, and network-tag headers.
- **Offline Transfer Transaction Signer/Verifier & Address Inspector** (`transfer-tx.ts`, `address-inspect.ts`):
  - Added `signTransferTransaction`, `decodeSignedTransferTransaction`, and `verifyTransferTransactionSignature` for offline wire Transfer transaction creation, decoding, and signature verification.
  - Added `inspectAddress` and `normalizeAddressList` for address format/checksum diagnostics, chain-policy inspection, and deduplicated list normalization.
- **Universal Offline Transaction Auto-Decoder & Air-Gapped Envelopes** (`tx-auto-decode.ts`, `airgap.ts`):
  - Added `peekTransactionVariant`, `decodeSignedTransactionAuto`, and `verifySignedTransactionAuto` to inspect, decode, and verify signed wire transactions without prior variant knowledge.
  - Added `encodeAirgapTxEnvelope` and `decodeAirgapTxEnvelope` for portable, versioned air-gapped transaction signing/broadcast envelopes.
- **Mempool Fee Statistics & Fee Recommendations** (`mempool-stats.ts`, `client.ts`):
  - Added `KovanicaClient.getMempoolStats()`, `parseMempoolFeeStats`, and `computeFeeRecommendations` for typed `kovanica_getMempoolStats` parsing and priority fee tier recommendations.

## [0.4.0] - 2026-11-23

### Added
- **WebSocket Subscription Client & Heartbeat Liveness (`KovanicaWsClient`)** (`ws.ts`):
  - Typed JSON-RPC 2.0 WebSocket client for `/ws` endpoints supporting `subscribeNewHeads` (`newHeads`), `subscribeCommittedLeaders` (`newCommittedLeader`), `subscribeLogs` (`logs` with optional address/topic `WsLogFilter`), and `unsubscribe`.
  - Lifecycle management (`connect`, `close`, `isConnected`, `activeSubscriptionCount`), automatic exponential-backoff reconnection with transparent subscription re-establishment and server ID remapping, configurable request timeouts, injectable `WebSocketImpl`, `onError` hook, and periodic heartbeat liveness detection (`heartbeatIntervalMs`, `heartbeatTimeoutMs`, `heartbeatMethod`).
- **Typed Bincode Contract ABI Decoders, Storage Slot Derivation & Log Decoders** (`decoders.ts`):
  - Bounds-checked little-endian `BincodeReader` and typed `KovanicaDecodeError` (`TRUNCATED`, `TRAILING_BYTES`, `INVALID_BOOL`, `INVALID_VARIANT`, `INVALID_UTF8`, `LENGTH_OVERFLOW`, `INVALID_INPUT`).
  - Canonical state and record decoders matching `kovanica-l1` Rust layouts: `decodeHtlcRecord`, `decodeVaultRecord`, `decodeMultisigState`, `decodeMultisigPendingTx`, `decodeTokenMetadata` / `decodeTokenState`, `decodeTokenPool`, `decodeNameRecord`, `decodeNftMetadata` / `decodeNftState`, and `decodeEscrowRecord`.
  - BLAKE3 storage slot derivation helpers (`STORAGE_KEY_PREFIXES`, `derivePrefixedStorageSlot`, `deriveStorageSlot`, `deriveStorageSlotHex`) for `kovanica_getStorageAt`.
  - Typed contract event log decoders: `decodeContractLog` and `decodeTransactionReceiptLogs` (with `ContractLogKindResolver` support for multi-contract receipts).
- **Typed Contract Storage Reader (`readContractStorage`)** (`decoders.ts`, `client.ts`):
  - Added `readContractStorage` (standalone and `client.readContractStorage(...)`) combining BLAKE3 storage slot derivation, `kovanica_getStorageAt`, and canonical Bincode state decoding into a single typed call.
- **Fee/Gas Estimation, Batch Estimation & Dry-Run Simulation** (`contracts.ts`, `client.ts`):
  - Added `estimateAndBuildCall` and `estimateBatchCalls` (standalone and on `KovanicaClient`) plus `estimateCallTxSize`, computing exact wire Call transaction sizes, fetching fee rates and sequential nonces, applying configurable basis-point safety margins (`DEFAULT_FEE_SAFETY_MARGIN_BPS = 12_000`, `DEFAULT_GAS_SAFETY_MARGIN_BPS = 12_000`), and enforcing optional `minFee` / `maxFee` bounds.
  - Added `dryRunCall` and `dryRunBatchCalls` (standalone and on `KovanicaClient`) for pre-submission `kovanica_call` simulation with typed return data, gas usage, and revert/error reporting.
- **Transaction Receipt Poller (`waitForTransactionReceipt`)** (`contracts.ts`, `client.ts`):
  - Added `waitForTransactionReceipt` (standalone and `client.waitForTransactionReceipt(...)`) with configurable polling intervals (`DEFAULT_RECEIPT_POLL_INTERVAL_MS`, `MIN_RECEIPT_POLL_INTERVAL_MS`), timeout (`DEFAULT_RECEIPT_TIMEOUT_MS`), and `AbortSignal` cancellation.
- **Typed Contract Client Facades** (`facades.ts`):
  - Added high-level typed facades for all 7 Kovanica system/playground contracts built on `ContractFacade`: `NameRegistryClient`, `TokenClient`, `EscrowClient`, `HtlcClient`, `NftClient`, `VaultClient`, and `MultisigClient`.
- **Resilient Retry/Failover RPC Transport & JSON-RPC 2.0 Batching** (`client.ts`, `transport.ts`):
  - Added automatic exponential-backoff retry (`computeRetryDelayMs`, `RpcRetryConfig`) and multi-endpoint failover for read-only idempotent methods (`DEFAULT_IDEMPOTENT_RPC_METHODS`) on transient transport, timeout, or HTTP 5xx errors while keeping state-mutating RPCs non-retried.
  - Added JSON-RPC 2.0 `callBatch` support on `HttpTransport` and `KovanicaClient` with `MAX_JSONRPC_BATCH_SIZE` validation and typed `JsonRpcBatchRequestItem` / `JsonRpcBatchItemResult` handling.
- **Release Readiness & Export Surface Verification** (`tests/exports.test.ts`):
  - Added ESM (`dist/index.js`), CJS (`dist/index.cjs`), and TypeScript declaration (`dist/index.d.ts`) export surface smoke tests plus browser-bundle cleanliness assertions ensuring zero accidental Node-only (`node:fs`, `node:child_process`, `node:net`) static imports.

## [0.3.0] - 2026-11-17

### Added
- **Canonical Smart Contract Argument Builders & Bincode Encoders** (`contracts.ts`):
  - Deterministic Bincode encoders: `encodeBincodeString`, `encodeBincodeBytes32Vec`, `encodeBincodeStringVec`, and little-endian encoders `u32le`, `u64le`, `u128le`.
  - Canonical call argument encoders and builders matching L1 and playground contracts:
    - `buildNameRegisterCall` / `encodeNameRegisterArgs` (`name_register(name, pubkey, relay_endpoints)`)
    - `buildHtlcCreateCall` / `encodeHtlcCreateArgs` (`htlc_create(hashlock, timelock, recipient)`)
    - `buildNftMintCall` / `encodeNftMintArgs` (`nft_mint(collection, to, token_id, token_uri)`)
    - `buildEscrowCreateCall` / `encodeEscrowCreateArgs` (`escrow_create(parties, threshold, amount, deadline)`)
    - `buildTokenTransferCall` (`token_transfer(to, amount)`)
    - `buildVaultCreateCall` (`vault_create(owner, lock_until)`)
  - Gas limit constants: `DEFAULT_CALL_GAS_LIMIT = 100_000n`, `MAX_TX_GAS_LIMIT = 10_000_000n`.
  - Domain-tagged BLAKE3 signing hash computation under `KVNC/tx/v1` (`TX_DOMAIN`) and `KVNC-TX-v1` (`TX_KEY`).
  - Pure TypeScript RFC 8032 Ed25519 signer (`signEd25519`) and wire call contract transaction serializer (`signCallContractTransaction`).
- **High-Level Wallet & Transaction Dispatch** (`wallet.ts`, `client.ts`):
  - `KovanicaWallet`: BIP-39 mnemonic phrase / seed derivation, SLIP-0010 HD path derivation (`m/44'/3007'/0'/0/0`), address generation, message signing, and smart contract call transaction signing.
  - `KovanicaClient`: Added `sendRawTransaction`, `buildCallTransaction`, and `signCallTransaction`.
- **SLIP-0010 Key Derivation & Testnet Address Prefix Support** (`wallet.ts`, `address.ts`):
  - Hardened SLIP-0010 derivation for Ed25519 using coin type `3007'` (`KOVANICA_COIN_TYPE`).
  - Network-aware address prefixing: `kvnc...dag` on Mainnet (Chain 1) and Devnet (Chain 3), `testnet-kvnc...dag` on Testnet (Chain 2).
- **Official Network Tag Metadata**:
  - `MAINNET: "1-f35df34c92001436"`
  - `TESTNET: "2-24cdb5fadd98b207"`
- **RPC Error Classification**:
  - `KovanicaRpcError.isInvalidRequest()` to classify JSON-RPC `-32600` rejections as "method exists but is not applicable on this network".
- Deterministic tests asserting that `getValidators`, `getStake`, and `getLeaderSchedule` surface the L1 #272 hybrid-chain rejection as `KovanicaRpcError` (`-32600`) on Chains `1` and `2`, never as `[]` or `0n`, with a Devnet (`3`) pass-through control.

### Changed
- Promoted SDK from read-only developer preview to full-featured client supporting key derivation, RFC 8032 signing, smart contract call builders, and transaction submission.
- Updated the verified `KovanicaDAG/kovanica-l1` reference commit to `566da35`.
- Retired chain ID `1337` (`LOCAL`) from `CHAIN_IDS`, `KNOWN_CHAINS`, and `isLegacyAddressAllowed()`; the canonical chain registry is now `1` (Mainnet), `2` (Testnet), and `3` (Devnet, also used for local testing).
- Documented that `getValidators`, `getStake`, and `getLeaderSchedule` are legacy (Mysticeti) methods, and that hybrid PoW + GHOSTDAG Chains `1` & `2` reject them with `-32600` since L1 #272 (`4181fc6`). README compatibility matrix now lists `3` for these three methods.


## [0.1.0] - 2026-11-14

- Initial read-only TypeScript developer preview for Kovanica (KVNC).
