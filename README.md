# kovanica-sdk

Typed, lightweight TypeScript client and developer toolkit for the **Kovanica (KVNC)** Layer-1 blockchain, suitable for modern browsers and Node.js (18+).

> [!NOTE]
> **Full Ecosystem Client (v0.10.0):** Includes **KVP-103 Dual-Key Ed25519 Stealth Addresses** (`src/stealth.ts` — meta-address codec, deterministic mnemonic derivation, sender one-time derivation, watch-only 2-byte BLAKE3 view-tag scanner, one-time spend key recovery & RFC 8032 scalar signing, Node 18/20/22 + browser-safe), **Native AMM / DEX** (`AmmClient`, `contracts/kovanica-amm` WASM + `Cargo.lock`, Wave A atomic `Approve → Swap` batches), **Institutional KVP-106 RWA Compliance** (`src/rwa-compliance.ts` batch allowlist, pause/clawback, pro-rata dividend scheduler), **runnable TypeScript `examples/` kit** (`examples/01-transfer-kvnc.ts` through `examples/05-stealth-send-scan.ts`), plus Balanced Fixed Fee Schedule (`FIXED_FEE_SCHEDULE`, `getFeeSchedule`), Wave B & C RPC methods (`getBaseFee`, `getStorageDeposit`, `getSessionKey`), Wave A Atomic Batch & Sponsored (Gasless) transactions, Waves B–D helpers, and Multi-Chain Bridge Registry (`BRIDGE_CHAINS`).
>
> **v0.7.0 Baseline:** Features lossless `bigint` priority fee tier presets & RBF fee bump calculation (`estimatePriorityFeeTiers`, `computeRbfFeeBump`), browser-safe air-gapped multisig proposal bundles & quorum verification (`checkMultisigQuorum`, `encodeMultisigProposalBundle`, `decodeMultisigProposalBundle`), max-span chunked + cursor-paginated contract log streaming (`queryContractLogsPaginated`), SLIP-0010 HD wallet derivation, browser-safe BIP-44 coin type `3007` path validation & watch-only PRO-21 accounts (`parseBip44Path`, `validateBip44Path`, `createWatchOnlyAccount`), cursor-paginated account transaction history (`getAccountTxHistory`, `parseAccountTxHistoryEntry`), real-time WebSocket block-with-receipt streams with backpressure queue capping (`subscribeNewBlocksWithReceipts`), canonical Wasmi smart contract call builders, 7 typed contract facades (`NameRegistryClient`, `TokenClient`, `EscrowClient`, `HtlcClient`, `NftClient`, `VaultClient`, `MultisigClient`), chunked log history & typed WS event streams (`getContractLogHistory`, `subscribeContractEvents`), multi-endpoint `FailoverHttpTransport` with circuit-breaker & `createFailoverClient`, fee-buffer estimation & abortable finality watcher (`applyFeeBuffer`, `estimateTxFeeWithBuffer`, `waitForTransactionFinality`), mempool fee-tier recommendations (`KovanicaClient.getMempoolStats()`, `computeFeeRecommendations`), offline Transfer/Call/Auto wire decoders & RFC 8032 Ed25519 verifiers (`signTransferTransaction`, `decodeSignedTransferTransaction`, `decodeSignedCallTransaction`, `decodeSignedTransactionAuto`, `verifySignedTransactionAuto`), header-aware `probeRpcNode`, PRO-21 `inspectAddress`, and BLAKE3-checksummed air-gapped transaction envelopes (`encodeAirgapTxEnvelope` / `decodeAirgapTxEnvelope`).

---

## Features

- **Standard JSON-RPC 2.0 Transport:** Configurable endpoint URL, automatic request IDs, configurable timeouts, caller-controlled cancellation (`AbortSignal`), and typed error classes.
- **Real-Time WebSocket Subscriptions (`KovanicaWsClient`):** Typed JSON-RPC 2.0 WebSocket client (`GET /ws`) supporting `newHeads`, `newCommittedLeader`, and filtered `logs` subscriptions with automatic exponential-backoff reconnection, transparent re-subscription, and optional heartbeat / idle liveness detection (`heartbeatIntervalMs`, `heartbeatTimeoutMs`, `heartbeatMethod`).
- **Transaction Construction, Estimation, Dry-Run Simulation, Broadcasting & Receipt Polling:** High-level `KovanicaWallet` and `KovanicaClient` support for estimating fees/gas for single calls (`estimateAndBuildCall`) and sequential-nonce batches (`estimateBatchCalls`), single and batch read-only contract dry-run simulation with typed Bincode decoding (`dryRunCall`, `dryRunBatchCalls`), constructing, signing, and broadcasting smart contract call transactions via `sendRawTransaction`, and polling until execution finality (`waitForTransactionReceipt`).
- **HD Wallet & Key Derivation (BIP-39 / SLIP-0010):** Standard BIP-44 path derivation with hardened Ed25519 (`m/44'/3007'/0'/0/0`), seed derivation, message signing, and network-aware address formatting.
- **Canonical Smart Contract Argument Builders:** Deterministic Bincode encoders for core Wasmi contracts (`name_register`, `htlc_create`, `nft_mint`, `escrow_create`, `token_transfer`, `vault_create`) matching L1 node and playground specifications.
- **Typed Bincode Contract ABI & Log Decoders + Storage Slot Derivation & Reader:** Bounds-checked `BincodeReader`, typed `KovanicaDecodeError`, canonical state/record decoders, single-event log dispatcher (`decodeContractLog`), batch receipt log decoder (`decodeTransactionReceiptLogs`), and typed storage slot reader (`readContractStorage`) for HTLC, Vault, Multisig, Token/Pool, Name Registry, NFT, and Escrow contracts, plus BLAKE3 storage slot derivation (`deriveStorageSlot`, `deriveStorageSlotHex`) for `kovanica_getStorageAt`.
- **Domain-Tagged Ed25519 Signing:** Pure TypeScript RFC 8032 Ed25519 signature computation with BLAKE3 domain hashing (`KVNC/tx/v1`).
- **Read-Only Verified Methods:** Full set of query methods verified against actual `crates/kovanica-rpc` Rust handlers at commit [`566da35`](https://github.com/KovanicaDAG/kovanica-l1/commit/566da35).
- **Lossless Precision (Large Integers):** Kovanica balances, heights, stakes, nonces, and gas rates are represented losslessly as native JavaScript `bigint`. Never coerced into IEEE-754 `Number`. Plain JSON integers up to `u64::MAX` are preserved losslessly.
- **PRO-21 Address Support:** Canonical 64-character `kvnc...dag` base32 addresses (256-bit Ed25519 public key + 29-bit `blake3` checksum) and chain-aware validation.
- **Chain Registry:** Verified chain ID metadata for the canonical chains: Mainnet (`1`, Hybrid PoW + GHOSTDAG, official network tag `1-f35df34c92001436`, strict PRO-21), Testnet (`2`, Hybrid PoW + GHOSTDAG, official network tag `2-24cdb5fadd98b207`, strict PRO-21, alias `HYBRID_TESTNET = 2`), and Devnet (`3`, Mysticeti, legacy hex allowed, also used for local testing).
- **Hybrid PoW & DAG Queries:** First-class typed support for `kovanica_getMiningInfo` and `kovanica_getDagTips` on Mainnet (Chain 1) and Testnet (Chain 2) (Hybrid PoW + GHOSTDAG).
- **Multi-Endpoint Failover & Node Capability Probe (v0.5.0):** `FailoverHttpTransport` / `createFailoverClient` with per-endpoint circuit-breaker cooldowns, bounded exponential backoff, credential redaction (`sanitizeRpcUrl`), and single-POST `probeRpcNode` validating `X-Kovanica-Network-Tag` / `X-Kovanica-Rpc-Version` / `X-Kovanica-Chain-Id` headers.
- **Mempool Fee-Tier Recommendations & Abortable Finality (v0.5.0):** `KovanicaClient.getMempoolStats()` (`kovanica_mempoolStats`), `computeFeeRecommendations` (`economy` / `standard` / `priority`), `applyFeeBuffer` / `estimateTxFeeWithBuffer`, and `waitForTransactionFinality` with multi-confirmation progress callbacks and `AbortSignal`.
- **Offline Tx Sign/Decode/Verify & Air-Gap Envelopes (v0.5.0):** Byte-identical L1 Transfer & Call signers/decoders (`signTransferTransaction`, `decodeSignedTransferTransaction`, `decodeSignedCallTransaction`, `decodeSignedTransactionAuto`, `verifySignedTransactionAuto`), PRO-21 `inspectAddress` / `normalizeAddressList`, and BLAKE3-checksummed `kvnc-tx:v1:...` air-gap envelopes (`encodeAirgapTxEnvelope`, `decodeAirgapTxEnvelope`).
- **Account Tx History, Watch-Only Accounts & WS Backpressure (v0.6.0):** Cursor-paginated account transaction history (`getAccountTxHistory`, `parseAccountTxHistoryEntry`) with lossless `bigint` amounts/fees and cyclic cursor protection, browser-safe BIP-44 (`3007'`) path validation & PRO-21 watch-only accounts (`parseBip44Path`, `validateBip44Path`, `createWatchOnlyAccount`), and `subscribeNewBlocksWithReceipts` with bounded WebSocket backpressure queuing.
- **Priority Fee Tiers, RBF Bump, Air-Gap Multisig Bundles & Paginated Contract Logs (v0.7.0):** Lossless `bigint` priority fee tier presets & Replace-By-Fee bump helper (`estimatePriorityFeeTiers`, `computeRbfFeeBump`), browser-safe BLAKE3-checksummed air-gapped multisig proposal bundles & quorum verification (`checkMultisigQuorum`, `encodeMultisigProposalBundle`, `decodeMultisigProposalBundle`), and max-span chunked + cursor-paginated contract log streaming (`queryContractLogsPaginated`).

---

## Installation

```bash
# Direct local dependency or npm tarball
npm install kovanica-sdk
```

---

## Quick Start

### 1. Connecting and Querying State

```typescript
import { KovanicaClient, formatKvnc, isNodeSynced } from "kovanica-sdk";

// Connect to a local node (Chain 2 Hybrid Testnet or Chain 3 Devnet)
const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

// Get latest committed leader block height (returns bigint)
const height = await client.blockNumber();
console.log(`Current committed height: ${height}`);

// Query account balance (returns bigint in atoms: 1 KVNC = 10^9 atoms)
const balanceAtoms = await client.getBalance("kvnc123...dag");
console.log(`Balance: ${formatKvnc(balanceAtoms)} KVNC (${balanceAtoms} atoms)`);

// Query node synchronization and peer health (L1 camelCase contract with snake_case aliases)
const sync = await client.syncStatus();
console.log(`Node peers: ${sync.peerCount}, Catching up: ${sync.catchingUp}`);
console.log(`Is confirmed in-sync: ${isNodeSynced(sync)}`);
```

### 2. Querying Hybrid PoW Mining Info & DAG Tips (Chains 1 & 2)

> **Important:** Mainnet (Chain 1) and Testnet (Chain 2, alias `HYBRID_TESTNET = 2`) operate on Hybrid PoW + GHOSTDAG (ADR 0003, KovanicaHash, target block 4 s, GHOSTDAG K=5). No public endpoints are invented; queries are performed against a node running with `--chain-id 1` or `--chain-id 2`.

```typescript
// Query PoW mining parameters and difficulty
const mining = await client.getMiningInfo();
console.log(`Chain ID: ${mining.chain_id}`);
console.log(`Difficulty: ${mining.difficulty}`);
console.log(`Target Bits: ${mining.target_bits}`);
console.log(`Estimated Hashrate: ${mining.network_hashrate_estimate} H/s`);

// Query active DAG tips
const tips = await client.getDagTips();
console.log(`Active DAG tips count: ${tips.count}`);
for (const tipHash of tips.tips) {
  console.log(`  - Tip: ${tipHash}`);
}
```

### 3. PRO-21 Address Verification

```typescript
import {
  CHAIN_IDS,
  encodeAddress,
  decodeAddress,
  isValidAddress,
} from "kovanica-sdk";

const publicKey = new Uint8Array(32); // 32-byte Ed25519 public key

// Encode to canonical 64-character PRO-21 address
const address = encodeAddress(publicKey);
console.log(`Address: ${address}`); // "kvnc...dag"

// Strict validation on Mainnet (Chain 1) and Testnet (Chain 2)
console.log(isValidAddress(address, CHAIN_IDS.MAINNET)); // true
console.log(isValidAddress("0x1234...", CHAIN_IDS.MAINNET)); // false (legacy hex forbidden on Mainnet)
console.log(isValidAddress("0x1234...", CHAIN_IDS.TESTNET)); // false (legacy hex forbidden on Testnet)

// Devnet (3) allows legacy hex
console.log(isValidAddress("0x1234...", CHAIN_IDS.DEVNET)); // true (if valid 32-byte hex)
```

### 4. Timeout, Cancellation (`AbortSignal`), Retry Backoff & Multi-Endpoint Failover

```typescript
const controller = new AbortController();

// Automatically cancel after 3 seconds
const timeout = setTimeout(() => controller.abort(), 3000);

try {
  const block = await client.getBlockByNumber(100n, false, {
    signal: controller.signal,
    timeoutMs: 5000,
  });
  console.log(block);
} catch (err) {
  if (err instanceof KovanicaAbortError) {
    console.warn("Request was cancelled");
  } else if (err instanceof KovanicaTimeoutError) {
    console.error(`Request timed out after ${err.timeoutMs}ms`);
  }
} finally {
  clearTimeout(timeout);
}
```

#### Opt-In Retry Backoff & Multi-Endpoint Failover

`KovanicaClient` supports ordered fallback endpoints (`rpcUrls`) and opt-in jittered exponential backoff (`retry`) for transient transport, timeout, and HTTP 5xx errors:

```typescript
import { KovanicaClient } from "kovanica-sdk";

const resilientClient = new KovanicaClient({
  rpcUrl: "http://127.0.0.1:8545/rpc",
  rpcUrls: [
    "http://127.0.0.1:8546/rpc",
    "http://127.0.0.1:8547/rpc",
  ],
  retry: {
    maxRetries: 3,
    initialDelayMs: 100,
    maxDelayMs: 2_000,
    jitterRatio: 0.2,
  },
});
```

- **Idempotent-only by default:** Only read-only methods in `DEFAULT_IDEMPOTENT_RPC_METHODS` (such as `kovanica_call`, `kovanica_getStorageAt`, `kovanica_estimateFee`, `kovanica_blockNumber`, `kovanica_getBalance`, `kovanica_getTransactionReceipt`, etc.) are retried. State-mutating `kovanica_sendRawTransaction` is **never** retried unless explicitly added to `retry.retryableMethods`.
- **Failover rotation:** When multiple `rpcUrls` are configured (primary `url`/`rpcUrl` first, deduplicated), transient errors rotate to the next endpoint. If `retry` is omitted on a single-endpoint client, `maxRetries` defaults to `0`.
- **No retry on JSON-RPC errors or abort:** Application-level `KovanicaRpcError` responses (e.g., `-32000` revert, `-32602` invalid params) and `AbortSignal` cancellations fail immediately without retrying.

#### Bounded JSON-RPC 2.0 Batch Requests (`callBatch`)

Execute up to `MAX_JSONRPC_BATCH_SIZE` (`32`) JSON-RPC 2.0 calls in a single HTTP round-trip with out-of-order response ID correlation and per-item error isolation:

```typescript
import { KovanicaClient, MAX_JSONRPC_BATCH_SIZE } from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

const results = await client.callBatch([
  { method: "kovanica_blockNumber", params: [] },
  { method: "kovanica_getBalance", params: ["kvnc123...dag"] },
  { method: "kovanica_estimateFee", params: [] },
]);

for (const item of results) {
  if (item.ok) {
    console.log("Result:", item.result);
  } else {
    console.warn(`RPC error (${item.error.code}): ${item.error.message}`);
  }
}
```

- Batches must contain `1..=32` (`MAX_JSONRPC_BATCH_SIZE`) requests; empty or oversized batches fail closed before any network I/O.
- Automatic retry/failover is only enabled when **every** method in the batch is allowlisted in `retryableMethods` (batches containing `kovanica_sendRawTransaction` are never auto-retried).

### 5. HD Wallet Key Derivation (BIP-39 / SLIP-0010)

```typescript
import { KovanicaWallet, CHAIN_IDS } from "kovanica-sdk";

// Create a new wallet from a BIP-39 mnemonic phrase
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = KovanicaWallet.fromMnemonic(mnemonic);

// Derives account index 0 under m/44'/3007'/0'/0/0
const account = wallet.deriveAccount(0, CHAIN_IDS.TESTNET);
console.log(`Address: ${account.address}`);
console.log(`Public Key: ${account.publicKey}`);

// Sign an arbitrary payload
const signature = wallet.signMessage(new TextEncoder().encode("hello world"), 0);
console.log(`Signature length: ${signature.length} bytes`);
```

### 6. Smart Contract Argument Builders & Call Dispatch

```typescript
import {
  KovanicaClient,
  KovanicaWallet,
  buildNameRegisterCall,
  buildHtlcCreateCall,
  CHAIN_IDS,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const wallet = KovanicaWallet.fromMnemonic("your seed phrase ...");

// 1. Build canonical Name Register call payload
const call = buildNameRegisterCall("alice", wallet.deriveAccount(0).publicKey, [
  "127.0.0.1:8000",
]);

// 2. Sign transaction with domain-tagged BLAKE3 hash under KVNC/tx/v1
const nonce = await client.getNonce(wallet.deriveAccount(0).address);
const signedTx = wallet.signCallTransaction(
  {
    contract: call.contract,
    method: call.method,
    args: call.args,
    gasLimit: call.gasLimit,
    nonce,
  },
  0
);

// 3. Broadcast to node via JSON-RPC
const txHash = await client.sendRawTransaction(signedTx.wireHex);
console.log(`Broadcasted transaction hash: ${txHash}`);
```

### 7. Estimating Fees/Gas & Building Calls (`estimateAndBuildCall`)

`estimateAndBuildCall` (available both as a standalone helper and as `client.estimateAndBuildCall(...)`) validates a contract call, computes its exact serialized wire size (`estimateCallTxSize`), fetches `kovanica_estimateFee` and (optionally) the sender's nonce via `kovanica_getNonce` in parallel, applies configurable basis-point safety margins (`DEFAULT_FEE_SAFETY_MARGIN_BPS = 12_000`, `DEFAULT_GAS_SAFETY_MARGIN_BPS = 12_000`), and returns a ready-to-sign `PreparedCallTransaction`:

```typescript
import {
  KovanicaClient,
  KovanicaWallet,
  CHAIN_IDS,
  buildNameRegisterCall,
  estimateAndBuildCall,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const wallet = KovanicaWallet.fromMnemonic("your seed phrase ...", "", 0, 0, 0, undefined, {
  chainId: CHAIN_IDS.TESTNET,
  client,
});

// 1. Estimate fee & fetch nonce with +25% fee margin and a safety cap
const prepared = await estimateAndBuildCall(
  client,
  {
    contract: "0x" + "11".repeat(32),
    method: "name_register",
    args: buildNameRegisterCall("alice", wallet.publicKey, ["127.0.0.1:8000"]),
  },
  {
    sender: wallet.address,
    chainId: CHAIN_IDS.TESTNET,
    feeMarginBps: 12_500, // +25% over feeRatePerByte * estimatedTxSize
    minFee: 10_000n,      // floor in atoms
    maxFee: 5_000_000n,   // fail closed if estimated fee exceeds cap
  },
);

// 2. Sign using the prepared call, nonce, fee, and chainId
const signed = wallet.signCallTransaction(prepared.call, {
  nonce: prepared.nonce!,
  fee: prepared.fee,
  chainId: prepared.chainId,
});

// 3. Broadcast to node
const txHash = await client.sendRawTransaction(`0x${signed.rawTxHex}`);
console.log(`Tx ${txHash} (${prepared.estimatedTxSize} bytes, fee ${prepared.fee} atoms)`);
```

**Options (`EstimateAndBuildCallOptions`):**
- `sender`: When provided without `nonce`, fetches the account nonce via `client.getNonce(sender)` in parallel with `client.estimateFee()`.
- `nonce` / `fee`: Explicit overrides that skip the corresponding RPC calls.
- `feeMarginBps`: Basis-point multiplier (`>= 10_000`, default `12_000` = `+20%`) applied with ceiling division to `feeRatePerByte * estimatedTxSize`.
- `gasMarginBps`: Basis-point multiplier (`>= 10_000`, clamped to `MAX_TX_GAS_LIMIT`). Defaults to `12_000` when `gasLimit`/`gas_limit` is omitted on the call input, or `10_000` (preserves caller value) when gas is explicitly specified.
- `minFee` / `maxFee`: Optional fee floor and fail-closed upper cap in atoms.
- `chainId`: Chain ID attached to the returned `PreparedCallTransaction` (default: `CHAIN_IDS.MAINNET`).
- `requestOptions`: Optional `{ timeoutMs, signal }` forwarded to `estimateFee` and `getNonce`.

#### Multi-Call Batch Estimation (`estimateBatchCalls`)

`estimateBatchCalls` (available both as a standalone helper and as `client.estimateBatchCalls(calls, options?)`) validates a non-empty array of contract calls fail-closed before any RPC I/O, fetches `kovanica_estimateFee` and `kovanica_getNonce(sender)` in a single parallel RPC round-trip, assigns sequential nonces (`startNonce + BigInt(i)`), enforces `minFeePerCall` and an optional batch-wide `maxTotalFee` cap, and returns `PreparedBatchCallTransactions`:

```typescript
import {
  KovanicaClient,
  KovanicaWallet,
  CHAIN_IDS,
  buildNameRegisterCall,
  buildTokenTransferCall,
  estimateBatchCalls,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const wallet = KovanicaWallet.fromMnemonic("your seed phrase ...", "", 0, 0, 0, undefined, {
  chainId: CHAIN_IDS.TESTNET,
  client,
});

const batch = await client.estimateBatchCalls(
  [
    {
      contract: "0x" + "11".repeat(32),
      method: "name_register",
      args: buildNameRegisterCall("alice", wallet.publicKey, ["127.0.0.1:8000"]),
    },
    buildTokenTransferCall("0x" + "22".repeat(32), wallet.publicKey, 500_000n),
  ],
  {
    sender: wallet.address,
    chainId: CHAIN_IDS.TESTNET,
    minFeePerCall: 10_000n,
    maxTotalFee: 10_000_000n,
  },
);

console.log(`Batch totalFee=${batch.totalFee} atoms, totalGas=${batch.totalGasLimit}, startNonce=${batch.startNonce}`);
for (const item of batch.calls) {
  const signed = wallet.signCallTransaction(item.call, {
    nonce: item.nonce!,
    fee: item.fee,
    chainId: item.chainId,
  });
  await client.sendRawTransaction(`0x${signed.rawTxHex}`);
}
```

#### Read-Only Contract Dry-Run Simulation (`dryRunCall`)

`dryRunCall` (available both as a standalone helper and as `client.dryRunCall(call, options?)`) simulates a read-only contract call against current node state via `kovanica_call` and optionally decodes the returned bytes with a typed Bincode decoder:

```typescript
import {
  KovanicaClient,
  decodeNameRecord,
  dryRunCall,
  encodeBincodeString,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

// Simulate a read-only contract call and decode the Bincode response
const simulation = await client.dryRunCall(
  {
    contract: "0x" + "11".repeat(32),
    method: "name_lookup",
    args: encodeBincodeString("alice"),
  },
  {
    from: "0x" + "22".repeat(32),
    gasLimit: 150_000n,
    decoder: decodeNameRecord,
  },
);

console.log(`Raw hex: ${simulation.rawHex} (${simulation.rawBytes.length} bytes)`);
console.log(`Decoded owner: ${simulation.decoded.ownerHex}`);
```

#### Batch Read-Only Contract Dry-Run Simulation (`dryRunBatchCalls`)

`dryRunBatchCalls` (available both as a standalone helper and as `client.dryRunBatchCalls(calls, options?)`) validates all calls fail-closed before any RPC I/O, executes `dryRunCall` for each item sequentially by default (or concurrently when `options?.parallel === true`), captures individual `{ ok: true, result }` or `{ ok: false, error }` outcomes when `options?.continueOnError !== false` (or throws on first error when `continueOnError === false`), and returns `BatchDryRunResult` (`{ results, totalCalls, passedCount, failedCount }`):

```typescript
import {
  KovanicaClient,
  decodeNameRecord,
  dryRunBatchCalls,
  encodeBincodeString,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

const batchSim = await client.dryRunBatchCalls(
  [
    {
      call: {
        contract: "0x" + "11".repeat(32),
        method: "name_lookup",
        args: encodeBincodeString("alice"),
      },
      options: { decoder: decodeNameRecord },
    },
    {
      call: {
        contract: "0x" + "11".repeat(32),
        method: "name_lookup",
        args: encodeBincodeString("bob"),
      },
      options: { decoder: decodeNameRecord },
    },
  ],
  {
    parallel: true,
    continueOnError: true,
    gasLimit: 150_000n,
  },
);

console.log(`Batch dry-run: ${batchSim.passedCount}/${batchSim.totalCalls} succeeded`);
for (const item of batchSim.results) {
  if (item.ok) {
    console.log("Decoded owner:", item.result.decoded?.ownerHex);
  } else {
    console.warn("Call failed:", item.error.message);
  }
}
```

#### Polling for Transaction Receipts (`waitForTransactionReceipt`)

`waitForTransactionReceipt` (available both as a standalone helper and as `client.waitForTransactionReceipt(txHash, options?)`) validates `txHash` as a 32-byte hex string, polls `client.getTransactionReceipt(txHash)` at `pollIntervalMs` (default `1_000` ms, minimum `10` ms) until a non-null `TransactionReceipt` is returned or `timeoutMs` (default `30_000` ms) elapses, honors `AbortSignal` cancellation during both RPC calls and poll wait sleep, and optionally throws `KovanicaRpcError` (`RpcErrorCode.ExecutionError`) when `throwOnRevert: true`:

```typescript
import { KovanicaClient, waitForTransactionReceipt } from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const controller = new AbortController();

const receipt = await client.waitForTransactionReceipt(txHash, {
  pollIntervalMs: 1_000,
  timeoutMs: 30_000,
  signal: controller.signal,
  throwOnRevert: true,
});

console.log(`Mined in block ${receipt.blockNumber} (gasUsed: ${receipt.gasUsed})`);
```

### 8. Real-Time WebSocket Subscriptions (`KovanicaWsClient`)

`KovanicaWsClient` connects to a node's JSON-RPC WebSocket endpoint (`GET /ws`) and implements `kovanica_subscribe` / `kovanica_unsubscribe` and `kovanica_subscription` push notifications:

```typescript
import { KovanicaWsClient } from "kovanica-sdk";

const ws = new KovanicaWsClient({
  url: "ws://127.0.0.1:8545/ws",
  reconnect: true,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 30_000,
  requestTimeoutMs: 10_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 5_000,
  heartbeatMethod: "kovanica_chainId",
  onError: (err) => console.error("WS error:", err),
});

await ws.connect();

// 1. Subscribe to newly produced/accepted DAG blocks
const headsSubId = await ws.subscribeNewHeads((head) => {
  console.log(`New head: ${head.hash} (round ${head.round})`);
});

// 2. Subscribe to committed leader sub-DAGs
const leaderSubId = await ws.subscribeCommittedLeaders((event) => {
  console.log(`Committed leader round=${event.leaderRound}, blocks=${event.blocks.length}`);
});

// 3. Subscribe to contract execution logs (optional address/topic filter)
const logsSubId = await ws.subscribeLogs(
  {
    address: "kvnc...dag",
    topics: ["0x" + "aa".repeat(32)],
  },
  (receipts) => {
    for (const receipt of receipts) {
      console.log(`Tx ${receipt.tx_hash}: success=${receipt.success}, events=${receipt.events.length}`);
    }
  },
);

// Unsubscribe individually when no longer needed
await ws.unsubscribe(headsSubId);
await ws.unsubscribe(leaderSubId);
await ws.unsubscribe(logsSubId);

// Cleanly close socket, cancel reconnect timers, and clear state
ws.close();
```

**Lifecycle & Reconnection:**
- `connect()` deduplicates concurrent connection attempts and resolves when the socket enters `OPEN`.
- `isConnected` and `activeSubscriptionCount` expose live connection and subscription state.
- When `reconnect: true`, unexpected disconnects schedule exponential backoff (`reconnectDelayMs` doubling up to `maxReconnectDelayMs`). On reconnect, all active subscriptions are automatically re-subscribed and incoming server subscription IDs are transparently remapped to the original client subscription IDs.
- When `heartbeatIntervalMs` is set to a positive number (disabled by default), the client periodically sends a lightweight JSON-RPC liveness probe (`heartbeatMethod`, default `"kovanica_chainId"`). If no message or response arrives within `heartbeatTimeoutMs` (default `5000` ms), the half-open socket is force-closed and reconnection is triggered automatically.
- Calling `close()` stops reconnection, clears heartbeat timers, rejects any in-flight RPC requests with `KovanicaTransportError`, and clears local subscriptions.
- In Node.js environments without a global `WebSocket` (or in tests), pass a custom constructor via `WebSocketImpl`.

### 9. Typed Bincode Contract ABI Decoders & Storage Slot Derivation

The SDK provides bounds-checked Bincode 1.x decoders matching canonical `kovanica-l1` Rust contract state layouts, along with BLAKE3 storage slot derivation for `kovanica_getStorageAt`:

```typescript
import {
  KovanicaClient,
  KovanicaDecodeError,
  decodeNameRecord,
  decodeHtlcRecord,
  deriveStorageSlotHex,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const registryContract = "0x" + "11".repeat(32);

// 1. Derive canonical BLAKE3 storage slot: blake3("kvnc/v1/name/" || "alice")
const slotHex = deriveStorageSlotHex("name", "alice");

// 2. Fetch raw bincode bytes from contract storage and decode into a typed record
const rawHex = await client.getStorageAt(registryContract, slotHex);
try {
  const record = decodeNameRecord(rawHex);
  console.log(`Owner: ${record.ownerHex}, endpoints: ${record.relayEndpoints.join(", ")}`);
} catch (err) {
  if (err instanceof KovanicaDecodeError) {
    console.error(`Decode failed [${err.code}] at offset ${err.offset}: ${err.message}`);
  }
}
```

**Supported Contract Decoders & Storage Slot Keys:**

| Contract | Decoder Function(s) | Return Type | Storage Slot Helper (`deriveStorageSlot` / `deriveStorageSlotHex`) |
| :--- | :--- | :--- | :--- |
| **HTLC** | `decodeHtlcRecord` | `HtlcRecord` (`status`: `"open" \| "claimed" \| "refunded"`) | `("htlc", swapId32)` — `blake3("kvnc/v1/htlc/" \|\| swapId32)` |
| **Vault** | `decodeVaultRecord` | `VaultRecord` (`schedule`: `VaultSchedule`) | `("vault", vaultId32)` — `blake3("kvnc/v1/vault/" \|\| vaultId32)` |
| **Multisig** | `decodeMultisigState`, `decodeMultisigPendingTx` | `MultisigState`, `MultisigPendingTx` | `("multisig")` (`kvnc/v1/state`), `("multisig_tx", txId)` (`kvnc/v1/mtx/` \|\| `u64le(txId)`) |
| **Token / AMM Pool** | `decodeTokenMetadata` (alias `decodeTokenState`), `decodeTokenPool` | `TokenMetadata`, `TokenPoolState` | `("token")` (`kvnc/v1/state`), `("token_pool")` (`kvnc/v1/pool`), `("token_lp", addr32)` (`kvnc/v1/lp/`) |
| **Name Registry** | `decodeNameRecord` | `NameRecord` | `("name", name)` — `blake3("kvnc/v1/name/" \|\| lowercaseName)` |
| **NFT** | `decodeNftMetadata` (alias `decodeNftState`) | `NftMetadata` (`tokens: NftTokenEntry[]`) | `("nft")` — `blake3("kvnc/v1/state")` |
| **Escrow** | `decodeEscrowRecord` | `EscrowRecord` (`status`: `"open" \| "released" \| "refunded"`) | `("escrow", escrowId32)` — `blake3("kvnc/v1/escrow/" \|\| escrowId32)` |

For custom contract state layouts, use `BincodeReader` directly (`readU8`, `readU16`, `readU32`, `readU64`, `readU128`, `readBool`, `readFixedBytes`, `readBytes`, `readString`, `readOption`, `readVec`, `assertEof`) and `derivePrefixedStorageSlot(prefix, key)`. All decoders fail closed with `KovanicaDecodeError` (`TRUNCATED`, `TRAILING_BYTES`, `INVALID_BOOL`, `INVALID_VARIANT`, `INVALID_UTF8`, `LENGTH_OVERFLOW`, `INVALID_INPUT`).

#### Typed Contract Storage Reader (`readContractStorage`)

`readContractStorage` (available both as a standalone helper and as `client.readContractStorage(contract, target, options?)`) validates the contract address (`encodeAddress`), derives or validates the 32-byte storage `slotHex`, queries `client.getStorageAt`, detects empty/zero storage slots (`null`, `"0x"`, `"0x0"`, or 32 zero bytes -> `isEmpty: true, rawHex: "0x", rawBytes: new Uint8Array(0)`), and automatically decodes non-empty Bincode payloads into `decoded?: T`:

```typescript
import {
  BincodeReader,
  KovanicaClient,
  STORAGE_KEY_PREFIXES,
  readContractStorage,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");
const registryContract = "0x" + "11".repeat(32);

// 1. Canonical { kind, key } target with automatic Bincode decoding (NameRecord)
const nameStorage = await client.readContractStorage(registryContract, {
  kind: "name",
  key: "alice",
});
if (!nameStorage.isEmpty && nameStorage.decoded) {
  console.log(`Alice owner: ${nameStorage.decoded.ownerHex}`);
}

// 2. Custom { prefix, key } target with custom decoder function
const lpStorage = await client.readContractStorage(registryContract, {
  prefix: STORAGE_KEY_PREFIXES.LP,
  key: new Uint8Array(32),
  decoder: (bytes) => new BincodeReader(bytes).readU128(),
});

// 3. Explicit 32-byte { slotHex } target
const rawSlot = await readContractStorage(client, registryContract, {
  slotHex: "0x" + "aa".repeat(32),
});
```

#### Typed Contract Event / Log Dispatcher (`decodeContractLog`)

`decodeContractLog(logDataHexOrBytes, kind)` dispatches across all canonical Bincode contract record/event payloads (such as `WsExecutionEvent.data` from `KovanicaWsClient.subscribeLogs` or raw storage hex) and returns a discriminated union `{ kind, record }`:

```typescript
import { decodeContractLog, type ContractLogKind } from "kovanica-sdk";

// Decode a specific known log kind (narrows return type to { kind: "htlc", record: HtlcRecord })
const htlcEvent = decodeContractLog(event.data, "htlc");
console.log(`HTLC status: ${htlcEvent.record.status}, amount: ${htlcEvent.record.amount}`);

// Or switch over the discriminated union when dispatching dynamically
function handleDecodedLog(rawHex: string, kind: ContractLogKind) {
  const decoded = decodeContractLog(rawHex, kind);
  switch (decoded.kind) {
    case "htlc":
      return decoded.record.hashLockHex;
    case "vault":
      return decoded.record.schedule.kind;
    case "name":
      return decoded.record.relayEndpoints;
    case "escrow":
      return decoded.record.status;
    default:
      return decoded.record;
  }
}
```

Supported `ContractLogKind` values: `"htlc"`, `"vault"`, `"multisig_state"`, `"multisig_tx"`, `"token_metadata"`, `"token_pool"`, `"name"`, `"nft_metadata"`, `"escrow"`.

#### Batch Transaction Receipt Log Decoder (`decodeTransactionReceiptLogs`)

`decodeTransactionReceiptLogs(receipt, kindOrResolver)` decodes all matching logs in a transaction receipt (either using a single `ContractLogKind` or a resolver callback `(log, index) => ContractLogKind | null | undefined`) and returns an array of `{ index, address?, topics?, kind, record }`:

```typescript
import { decodeTransactionReceiptLogs } from "kovanica-sdk";

// 1. Decode all logs in a receipt with a single known ContractLogKind
const htlcLogs = decodeTransactionReceiptLogs(receipt, "htlc");
for (const entry of htlcLogs) {
  console.log(`Log #${entry.index} (${entry.address}): status=${entry.record.status}`);
}

// 2. Filter and decode heterogeneous logs across multiple contracts via a resolver
const decodedLogs = decodeTransactionReceiptLogs(receipt, (log, index) => {
  if (log.address === htlcContractAddress) return "htlc";
  if (log.address === nameRegistryAddress) return "name";
  return null; // skip unrelated logs while preserving original log indices
});
```

---

## v0.5.0 Production Toolkit Examples

All `v0.5.0` helpers are browser-safe (zero Node-only dependencies) and exported directly from `"kovanica-sdk"`.

### 1. Multi-Endpoint Failover & Credential Sanitization

Use `createFailoverClient` (or `FailoverHttpTransport` directly) for ordered endpoint failover with per-endpoint circuit-breaker cooldowns and automatic URL redaction via `sanitizeRpcUrl`:

```typescript
import {
  FailoverHttpTransport,
  KovanicaClient,
  createFailoverClient,
  sanitizeRpcUrl,
} from "kovanica-sdk";

// Sanitize URLs before logging (strips user:pass@, fragments, and token/api_key query params)
console.log(sanitizeRpcUrl("https://user:secret@rpc.example.com/rpc?api_key=abc#frag"));
// => "https://rpc.example.com/rpc"

// Option A: High-level helper creating a KovanicaClient backed by FailoverHttpTransport
const failoverClient = createFailoverClient(
  [
    "http://127.0.0.1:8545/rpc",
    "http://127.0.0.1:8546/rpc",
  ],
  {
    timeoutMs: 5_000,
    maxRetriesPerEndpoint: 1,
    baseBackoffMs: 150,
    maxBackoffMs: 2_000,
    cooldownMs: 15_000,
    onFailover: (event) => {
      console.warn(
        `Failover ${event.fromUrl} -> ${event.toUrl ?? "none"} (${event.method}): ${event.reason}`,
      );
    },
  },
);

const height = await failoverClient.blockNumber();
console.log(`Committed height: ${height}`);

// Option B: Direct FailoverHttpTransport when you also want endpoint health snapshots
const transport = new FailoverHttpTransport({
  urls: ["http://127.0.0.1:8545/rpc", "http://127.0.0.1:8546/rpc"],
  cooldownMs: 15_000,
});
const client = new KovanicaClient({ transport });
await client.blockNumber();
for (const ep of transport.getEndpointHealth()) {
  console.log(`${ep.url}: state=${ep.state}, healthy=${ep.healthy}, ok=${ep.totalSuccesses}`);
}
```

### 2. Single-POST Header-Aware Node Capability Probe (`probeRpcNode`)

`probeRpcNode` executes a single JSON-RPC 2.0 batch POST (`kovanica_chainId`, `kovanica_blockNumber`, `kovanica_estimateFee`) and validates the `X-Kovanica-Network-Tag`, `X-Kovanica-Rpc-Version`, and `X-Kovanica-Chain-Id` response headers:

```typescript
import { CHAIN_IDS, probeRpcNode } from "kovanica-sdk";

const probe = await probeRpcNode("http://127.0.0.1:8545/rpc", {
  expectedChainId: CHAIN_IDS.TESTNET,
  timeoutMs: 5_000,
});

if (!probe.ok) {
  throw new Error(`Node probe failed (${probe.url}): ${probe.error}`);
}

console.log({
  url: probe.url,
  chainId: probe.chainId,
  headerChainId: probe.headerChainId, // from X-Kovanica-Chain-Id
  networkTag: probe.networkTag,       // from X-Kovanica-Network-Tag
  rpcVersion: probe.rpcVersion,       // from X-Kovanica-Rpc-Version
  canonicalTagMatch: probe.canonicalTagMatch,
  batchSupported: probe.batchSupported,
  blockHeight: probe.blockHeight,
  feeRate: probe.feeRate,
  latencyMs: probe.latencyMs,
});
```

### 3. Mempool Fee-Tier Recommendations & Abortable Finality

Combine `client.getMempoolStats()`, `computeFeeRecommendations`, `applyFeeBuffer`, and `waitForTransactionFinality` for live fee-tier selection and multi-confirmation finality tracking:

```typescript
import {
  KovanicaClient,
  applyFeeBuffer,
  computeFeeRecommendations,
  waitForTransactionFinality,
} from "kovanica-sdk";

const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

// 1. Fetch mempool fee distribution and compute monotonic economy/standard/priority tiers
const stats = await client.getMempoolStats();
const tiers = computeFeeRecommendations(stats, {
  fallbackBaseFeePerByte: 10n,
  safetyMultiplierBps: 12_000, // 1.2x safety buffer
});
console.log(`Fee tiers (${tiers.source}):`, {
  economy: tiers.economy,
  standard: tiers.standard,
  priority: tiers.priority,
});

// 2. Apply a ceiling-rounded fee buffer with optional floor and cap
const buffered = applyFeeBuffer(tiers.standard * 196n, {
  safetyMultiplierBps: 11_500, // +15%
  minFeePerByte: 1_000n,
  maxFeeCap: 5_000_000n,
});
console.log(`Buffered total fee: ${buffered.bufferedFee} atoms (capped=${buffered.capped})`);

// 3. Watch a transaction until it reaches target confirmations (with AbortSignal support)
const controller = new AbortController();
const finality = await waitForTransactionFinality(client, "0x" + "ab".repeat(32), {
  confirmations: 3,
  pollIntervalMs: 2_000,
  timeoutMs: 60_000,
  signal: controller.signal,
  onProgress: (update) => {
    console.log(
      `[${update.status}] ${update.confirmations}/${update.targetConfirmations} confs (${update.elapsedMs}ms)`,
    );
  },
});
console.log(`Finalized at height ${finality.blockHeight} (tip ${finality.currentHeight})`);
```

### 4. Offline Transfer Signing, Auto-Decoding & RFC 8032 Ed25519 Verification

Sign native transfers completely offline with `signTransferTransaction`, auto-detect and decode Transfer (variant `0`) or Call (variant `6`) payloads with `decodeSignedTransactionAuto`, and verify the Ed25519 signature with `verifySignedTransactionAuto`:

```typescript
import {
  CHAIN_IDS,
  decodeSignedTransactionAuto,
  signTransferTransaction,
  verifySignedTransactionAuto,
} from "kovanica-sdk";

const senderPrivateKey = new Uint8Array(32).fill(7);
const recipientPubkey = new Uint8Array(32).fill(9);

// 1. Sign a canonical 196-byte native Transfer transaction offline
const signed = signTransferTransaction({
  privateKey: senderPrivateKey,
  to: recipientPubkey, // accepts 32-byte Uint8Array, PRO-21 address, or 0x hex
  amount: 1_000_000_000n, // 1 KVNC in atoms
  nonce: 0n,
  fee: 10_000n,
  chainId: CHAIN_IDS.TESTNET,
});

// 2. Auto-decode Transfer or Call wire bytes/hex and verify RFC 8032 Ed25519 signature
const decoded = decodeSignedTransactionAuto(signed.rawTxHex, {
  chainId: CHAIN_IDS.TESTNET,
});
const signatureValid = verifySignedTransactionAuto(decoded);

if (decoded.kind === "transfer") {
  console.log({
    sender: decoded.tx.senderAddress,
    recipient: decoded.tx.recipientAddress,
    amount: decoded.tx.amount,
    fee: decoded.tx.fee,
    wireSizeBytes: decoded.tx.wireSizeBytes, // 196
    signatureValid, // true
  });
}
```

### 5. PRO-21 Address Inspection & Batch Normalization

Inspect arbitrary address inputs without throwing via `inspectAddress` and canonicalize/deduplicate recipient lists with `normalizeAddressList`:

```typescript
import {
  CHAIN_IDS,
  encodeAddress,
  inspectAddress,
  normalizeAddressList,
} from "kovanica-sdk";

const sampleAddr = encodeAddress(new Uint8Array(32).fill(1));

// Inspect format, BLAKE3 checksum, canonical forms, and chain policy
const info = inspectAddress(sampleAddr, CHAIN_IDS.MAINNET);
console.log({
  valid: info.valid,
  format: info.format, // "pro21-mainnet"
  checksumValid: info.checksumValid,
  chainAllowed: info.chainAllowed,
  canonicalMainnet: info.canonicalMainnet,
  canonicalTestnet: info.canonicalTestnet,
});

// Validate, deduplicate, and canonicalize a batch of addresses
const normalized = normalizeAddressList(
  [sampleAddr, sampleAddr, "0x" + "11".repeat(32), "not-an-address"],
  { expectedChainId: CHAIN_IDS.MAINNET },
);
console.log(`Valid (${normalized.valid.length}):`, normalized.valid);
console.log(`Invalid (${normalized.invalid.length}):`, normalized.invalid);
```

### 6. Air-Gapped BLAKE3-Checksummed Transaction Envelopes

Wrap signed transactions in compact, QR-friendly `kvnc-tx:v1:<base64url>` envelopes with an 8-byte BLAKE3 integrity checksum and canonical network-tag pinning for Mainnet (`1`) and Testnet (`2`):

```typescript
import {
  CHAIN_IDS,
  decodeAirgapTxEnvelope,
  encodeAirgapTxEnvelope,
} from "kovanica-sdk";

// 1. Offline signer encodes the signed transaction into a checksummed envelope
const { encoded, envelope } = encodeAirgapTxEnvelope({
  chainId: CHAIN_IDS.TESTNET,
  kind: "transfer",
  rawTxHex: signed.rawTxHex,
  signingHashHex: signed.signingHashHex,
});
console.log(`Air-gap payload (${encoded.length} chars):`, encoded);
console.log(`Checksum: ${envelope.checksumHex}, Network Tag: ${envelope.networkTag}`);

// 2. Online broadcaster decodes, verifies checksum + network tag + expected chain ID
const verified = decodeAirgapTxEnvelope(encoded, {
  expectedChainId: CHAIN_IDS.TESTNET,
});
console.log(`Ready to broadcast ${verified.kind} tx on chain ${verified.chainId}: ${verified.rawTxHex}`);
```

---

## Large Integer Representation & Lossless Quantities

Kovanica JSON-RPC uses `0x`-prefixed minimal hex strings for integers (e.g. `"0x0"`, `"0x2540be400"` for 10 KVNC).

In JavaScript, standard `Number` is an IEEE-754 64-bit float with a safe integer limit of $2^{53} - 1$ (`9,007,199,254,740,991`). While the total KVNC supply of $90,200,000 \times 10^9 = 90,200,000,000,000,000$ atoms exceeds this limit, 64-bit and 128-bit blockchain quantities will suffer silent bit truncation if coerced to `Number`.

To prevent precision corruption:
1. All integer quantities returned from the node (`blockNumber`, `balance`, `nonce`, `fee`, `stake`, `rewards`, `difficulty`, `target_round`) are deserialized directly into native JavaScript `bigint`.
2. Formatting and parsing helpers (`toHexQuantity`, `parseQuantity`, `formatKvnc`, `parseKvnc`) operate purely on `bigint` and string representations without floating point conversion.

---

## RPC Compatibility Matrix

All methods are mapped directly to handlers in `crates/kovanica-rpc` verified at node commit [`d2239fd8314a0c6edb08d54724738d662d406a32`](https://github.com/KovanicaDAG/kovanica-l1/commit/d2239fd8314a0c6edb08d54724738d662d406a32):

| JSON-RPC Method | SDK Client Method | Handler in `kovanica-rpc` | Supported Chains | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `kovanica_blockNumber` | `client.blockNumber()` | `handle_block_number` | 1, 2, 3 | Returns committed leader height |
| `kovanica_getBlockByNumber` | `client.getBlockByNumber(n, full)` | `handle_get_block_by_number` | 1, 2, 3 | Takes hex quantity or bigint |
| `kovanica_getBlockByHash` | `client.getBlockByHash(h, full)` | `handle_get_block_by_hash` | 1, 2, 3 | 32-byte block digest |
| `kovanica_getBalance` | `client.getBalance(addr)` | `handle_get_balance` | 1, 2, 3 | Returns atomic balance in atoms |
| `kovanica_getNonce` | `client.getNonce(addr)` | `handle_get_nonce` | 1, 2, 3 | Account sequence number |
| `kovanica_getCode` | `client.getCode(addr)` | `handle_get_code` | 1, 2, 3 | Contract bytecode hex |
| `kovanica_getStorageAt` | `client.getStorageAt(addr, slot)` | `handle_get_storage_at` | 1, 2, 3 | Contract storage slot hex |
| `kovanica_getTransactionByHash` | `client.getTransactionByHash(h)` | `handle_get_transaction_by_hash` | 1, 2, 3 | Returns transaction details |
| `kovanica_getTransactionReceipt` | `client.getTransactionReceipt(h)` | `handle_get_transaction_receipt` | 1, 2, 3 | Status, block execution receipt & gasUsed |
| `kovanica_getPendingTransactions`| `client.getPendingTransactions()` | `handle_get_pending_transactions`| 1, 2, 3 | Mempool pending tx hashes |
| `kovanica_estimateFee` | `client.estimateFee()` | `handle_estimate_fee` | 1, 2, 3 | Gas fee rate in atoms per byte |
| `kovanica_getValidators` | `client.getValidators()` | `handle_get_validators` | 3 | Active validator set and stakes. Rejected with `-32600` on hybrid chains 1 & 2 (L1 #272) |
| `kovanica_getStake` | `client.getStake(addr)` | `handle_get_stake` | 3 | Bonded stake amount. Rejected with `-32600` on hybrid chains 1 & 2 (L1 #272) |
| `kovanica_getRewards` | `client.getRewards(addr)` | `handle_get_rewards` | 1, 2, 3 | Cumulative earned rewards |
| `kovanica_getLeaderSchedule` | `client.getLeaderSchedule(count)` | `handle_get_leader_schedule` | 3 | Leader rounds schedule. Rejected with `-32600` on hybrid chains 1 & 2 (L1 #272) |
| `kovanica_syncStatus` | `client.syncStatus()` | `handle_sync_status` | 1, 2, 3 | camelCase wire contract with peerId & reportedTipRound |
| `kovanica_getMiningInfo` | `client.getMiningInfo()` | `handle_get_mining_info` | 1, 2 (Hybrid PoW) | Mining difficulty, DAA target |
| `kovanica_getDagTips` | `client.getDagTips()` | `handle_get_dag_tips` | 1, 2 (Hybrid PoW) | Current DAG tip block hashes |

---

## Node Synchronization Contract (`kovanica_syncStatus`)

The L1 RPC returns `SyncStatus` with `#[serde(rename_all = "camelCase")]`:
- `localTipRound`: `u64` (omitted if storage unread)
- `committedHeight`: `u64` (omitted if storage unread)
- `localHeight`: `u64` (alias for `committedHeight`)
- `catchingUp`: `bool`
- `catchUpTarget`: `u64` (omitted if not catching up)
- `behindBy`: `u64` (omitted if not catching up)
- `peerCount`: `usize` (plain integer)
- `peers`: array of `SyncPeerStatus` (`peerId`: string, `reportedTipRound`: optional `u64`)
- `networkTag`: `<chain_id>-<16 hex chars>` (official frozen tags: Mainnet `1-f35df34c92001436`, Testnet `2-24cdb5fadd98b207`)

### Synchronization State Semantics
In Kovanica L1, **`catchingUp === false` alone is insufficient** to conclude a node is in sync:
- When a node is in the initial probing state or has zero connected peers, `catchingUp` is reported as `false`, yet the node is not in consensus sync.
- Unknown fields (missing `localTipRound`, `committedHeight`, `peerCount`, or `catchingUp`) remain `undefined` and are **never converted to `0` or false claims**.
- Explicit zeros (`localTipRound: 0`, `committedHeight: 0`, `peerCount: 0`, `reportedTipRound: 0`) are strictly preserved.
- The SDK exports `isNodeSynced(status)`: returns `true` only if `catchingUp === false`, `localTipRound !== undefined`, and `peerCount > 0`. Returns `false` if `catchingUp === true`. Returns `undefined` if status is indeterminate.

---

## Chain ID Registry

| Chain ID | Name | Network Tag | Consensus | Target Block | Address Rule |
| :---: | :--- | :---: | :--- | :---: | :--- |
| `1` | **Mainnet** | `1-f35df34c92001436` | Hybrid PoW + GHOSTDAG (`K = 5`) | 4 s | Strict PRO-21 base32 (`kvnc...dag`, 64 chars) |
| `2` | **Testnet** (`HYBRID_TESTNET` alias) | `2-24cdb5fadd98b207` | Hybrid PoW + GHOSTDAG (`K = 5`) | 4 s | Strict PRO-21 base32 (`kvnc...dag`, 64 chars) |
| `3` | **Devnet** | `3-<16 hex chars>` (ephemeral) | Mysticeti | 4 s | PRO-21 base32 and legacy hex allowed |

> [!NOTE]
> Per `crates/kovanica-params/src/lib.rs` and `crates/kovanica-types/src/signing.rs`, both Mainnet (`1`) and Testnet (`2`, alias `HYBRID_TESTNET = 2`) execute Hybrid PoW + GHOSTDAG mining (`is_hybrid(chain_id) == true`, `K = 5`, target 4 s, KovanicaHash) and enforce strict PRO-21 base32 addresses (`isLegacyAddressAllowed(chainId) == false`). Devnet (`3`) uses a development parameter profile (also for local testing) and allows legacy hex addresses.

---

## Testing & Live RPC Verification

The test suite separates deterministic offline fixture tests from live node interoperability:

### 1. Offline / Default Mode
```bash
npm test
```
Runs all unit tests, address encoders/decoders, chain registry checks, and source-backed JSON fixture regressions. If no live node is running, live network queries are cleanly skipped with an informative notice while offline verification passes.

### 2. Required-Live Interoperability Mode
```bash
# Target an explicitly configured, isolated local node
KOVANICA_RPC_URL=http://127.0.0.1:18545/rpc npm run test:live
# or
KOVANICA_REQUIRE_LIVE=1 KOVANICA_RPC_URL=http://127.0.0.1:18545/rpc npm test
```
In required-live mode:
- The suite **fails immediately** if the configured node is unreachable or fails strict JSON-RPC readiness validation.
- **HTTP 200 alone is rejected as a readiness check:** the probe verifies that the response is valid JSON-RPC 2.0 without an error object, and conforms to the `kovanica_syncStatus` schema (`catchingUp` boolean, `peerCount` integer).
- Verifies live `syncStatus`, `blockNumber`, network identity tag (`<chain_id>-<16_hex_genesis>`), and Hybrid PoW (Chains 1 & 2) mining/DAG endpoints (`kovanica_getMiningInfo`, `kovanica_getDagTips`).
- Distinguishes basic genesis readiness from stronger nonzero executed state (`[BLOCKED]` when height remains 0).

### 3. Automated Isolated Cluster Runner
```bash
npm run test:live:isolated
```
Orchestrates L1's documented isolated topology (Observer + Producer on loopback `127.0.0.1` with disposable directories) using the approved `kovanica-node` binary, verifies peering, and executes required-live verification against the Observer RPC. Tears down all processes and temporary state on exit.

### 4. Deterministic RPC Failure-Path & Recovery Regressions
```bash
npm test
```
The deterministic test suite (`tests/transport-contracts.test.ts`) verifies client behavior against local mock HTTP servers without requiring an active node or network:
- **Abrupt Connection Loss:** Socket termination mid-flight produces a `KovanicaTransportError` with sanitized credentials and without hanging.
- **Client Recovery Across Failure Modes:** Verifies that after connection drops, timeouts, cancellation (`AbortSignal`), HTTP 500 responses, malformed JSON, or JSON-RPC errors, the same `KovanicaClient` instance cleanly recovers and processes subsequent requests with incrementing request IDs.
- **Error Non-Conversion Contracts:** Failures, RPC errors, and absent results are **never converted** into `0n`, `0`, `[]`, or healthy node claims across `getBalance`, `getRewards`, `getStake`, `blockNumber`, `syncStatus`, `getValidators`, `getMiningInfo`, and `getDagTips`. Explicit zero values (`"0x0"`, `"0"`) remain distinct from missing data and are preserved as `0n`.
- **Hybrid Rejection Contracts (L1 #272):** On hybrid PoW + GHOSTDAG chains `1` and `2`, `getValidators`, `getStake`, and `getLeaderSchedule` are rejected by the node with JSON-RPC code `-32600`. The deterministic suite asserts the SDK surfaces a `KovanicaRpcError` (with `isInvalidRequest() === true` and the method plus `chain_id` in the message) and never converts the rejection into `[]` or `0n`; devnet (`3`) responses are asserted to pass through unchanged.
- **Synthetic Fixture Verification of Execution Assertions:** Tests the live execution assertion logic (`assertNonzeroExecutedState`) against synthetic fixtures (`SYNTHETIC_FIXTURE_*`), proving that a fixture reporting nonzero committed height but lacking executed author rewards (balance at unrewarded genesis liquid baseline `450_000_000_000_000n`) fails the execution assertion. Synthetic mock tests verify assertion logic offline and do not claim live DAA or node acceptance.

### 5. Test Modes and Outcome Meanings

| Mode | Command | Live Node Needed | Outcome if Node Unavailable | Outcome if Height is 0 |
| :--- | :--- | :---: | :--- | :--- |
| **Default / Offline** | `npm test` | No | Skips live tests cleanly (`PASS`); offline regressions pass | Skips nonzero execution as `[BLOCKED]` |
| **Required-Live** | `npm run test:live` | Yes | Fails immediately (`exit 1`, `[REQUIRED-LIVE FAILURE]`) | Skips nonzero execution as `[BLOCKED]` |
| **Isolated Cluster** | `npm run test:live:isolated` | Auto-spawned | Fails if node binary missing (`[BLOCKED]`) | Waits for mined blocks; asserts nonzero execution |

---

## Compatibility Limits

1. **Transaction Signing Surface:** This SDK implements standard SLIP-0010 key derivation, canonical smart contract call building, RFC 8032 Ed25519 signing under `KVNC/tx/v1`, and JSON-RPC transaction broadcasting via `sendRawTransaction`. Consensus block authoring and PoW hash mining remain node/miner level responsibilities.
2. **Hybrid PoW Chains (1 & 2) for Mining:** `client.getMiningInfo()` and `client.getDagTips()` are supported on Mainnet (Chain ID 1) and Testnet (Chain ID 2, Hybrid PoW + GHOSTDAG). On non-hybrid chains, the node rejects these methods with code `-32600` or `-32601`.
3. **Hybrid PoW Chains (1 & 2) Have No Staking:** `client.getValidators()`, `client.getStake()`, and `client.getLeaderSchedule()` are legacy (Mysticeti) methods. Since L1 #272 the node rejects them with code `-32600` (`InvalidRequest`) on Chains 1 & 2, and the SDK propagates a `KovanicaRpcError` (`err.isInvalidRequest() === true`) instead of returning `[]` or `0n`. They remain available on Devnet (`3`).
4. **Lossless Precision Range:** Integers on the wire up to `u64::MAX` (`18446744073709551615`) and 128-bit balances are parsed losslessly into `bigint`. Direct JavaScript `number` literals exceeding `Number.MAX_SAFE_INTEGER` will throw `TypeError` to guard against precision corruption.

---

## Publishing to npm

Automated publishing with npm OIDC provenance attestation is configured in [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. Configure an npm granular access token with publish permission for `kovanica-sdk` as the `NPM_TOKEN` repository secret in GitHub Actions.
2. Bump `"version"` in `package.json` (and `package-lock.json`) on `main` via PR.
3. Push a matching semantic version tag (`v<version>`, e.g., `git tag v0.10.0 && git push origin v0.10.0`).

The workflow verifies that the pushed `v*` tag matches `package.json`, runs `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `npm pack --dry-run`, and then publishes with `npm publish --provenance --access public`. You can also trigger the workflow manually via **Actions -> Publish to npm -> Run workflow** (`dry_run` defaults to `true` for safe pre-release verification).

---

## Ecosystem Repositories

| Repository | Role |
| :--- | :--- |
| **[BetterCallDzuks/kovanica-l1](https://github.com/BetterCallDzuks/kovanica-l1)** | Rust Layer-1 node, Hybrid PoW + GHOSTDAG consensus, Wasmi runtime, RPC, Stratum, Faucet, Indexer, Lightnode & CLI |
| **[BetterCallDzuks/kovanica-sdk](https://github.com/BetterCallDzuks/kovanica-sdk)** | Official TypeScript SDK (`v0.7.0`) — browser & Node.js client, failover transport, facades, priority fees/RBF, air-gap multisig bundles, paginated contract logs, watch-only accounts, tx history & offline codecs |
| **[BetterCallDzuks/kovanica-web](https://github.com/BetterCallDzuks/kovanica-web)** | Public site, BlockDAG Explorer, Faucet, Pool portal & API Reference (`kovanica.online`) |
| **[BetterCallDzuks/kovanica-apps](https://github.com/BetterCallDzuks/kovanica-apps)** | Client apps — `wallet-web`, `console-desktop`, `node-desktop`, `desktop`, Android & iOS |
| **[BetterCallDzuks/kovanica-playground](https://github.com/BetterCallDzuks/kovanica-playground)** | Interactive developer RPC console & 7 `kovanica-sdk v0.5.0` studios |

---

## License Basis

- **License:** MIT License (`LICENSE`).
- **Basis:** Developed from scratch as a clean TypeScript client based on public protocol constants (`kovanica-params`) and the JSON-RPC interface specification (`kovanica-rpc`) verified at node commit [`566da35`](https://github.com/KovanicaDAG/kovanica-l1/commit/566da35). Contains no copied code from GPL-3.0 licensed consensus internals.
