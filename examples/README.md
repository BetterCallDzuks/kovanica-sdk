# Kovanica SDK — Runnable Examples Kit

Self-contained TypeScript examples demonstrating core `kovanica-sdk` workflows: BIP-44 wallets, native KVNC transfers, KVP-102 token creation & fee schedules, Wave A 1-tx atomic AMM swaps, KVP-106 institutional RWA issuance + batch compliance allowlists, and KVP-103 dual-key Ed25519 stealth addresses.

> **Import path note:** Examples inside this repository import directly from `../src/index.js` so they run without a separate publish step. In your own application, replace `../src/index.js` with `"kovanica-sdk"`.

## Prerequisites

- Node.js **18+** (`npm install` already run in `kovanica-sdk`)
- [`tsx`](https://github.com/privatenumber/tsx) via `npx tsx` (no extra global install required)

## Examples Overview

| Script | Mode | Default RPC | Broadcasts? | What it demonstrates |
| --- | --- | --- | --- | --- |
| [`01-transfer-kvnc.ts`](./01-transfer-kvnc.ts) | Testnet RPC (offline fallback) | `https://rpc-testnet.kovanica.online/rpc` | Only if `KOVANICA_BROADCAST=1` | Derive BIP-44 wallet, query balance/nonce, sign & verify a KVNC transfer, optionally broadcast |
| [`02-deploy-kvp102-token.ts`](./02-deploy-kvp102-token.ts) | Testnet RPC (offline fallback) | `https://rpc-testnet.kovanica.online/rpc` | Only if `KOVANICA_BROADCAST=1` | Inspect `FIXED_FEE_SCHEDULE` / live fee schedule, encode & sign a KVP-102 `token_create` call |
| [`03-amm-atomic-swap.ts`](./03-amm-atomic-swap.ts) | **100% Offline** | None | No | Quote constant-product swap (`quoteAmmSwapExactIn`) and sign a Wave A 1-tx atomic `Approve → Swap` batch (`AmmClient.signApproveAndSwapBatch`) |
| [`04-rwa-issuance.ts`](./04-rwa-issuance.ts) | **100% Offline** (optional live RPC) | Optional | No | Build & sign a KVP-106 `rwa_create` call (`RwaClient` / `buildRwaCreateCall`), check mint cap, and sign a Wave A batch compliance allowlist update (`signRwaBatchAllowlistUpdate`) |
| [`05-stealth-send-scan.ts`](./05-stealth-send-scan.ts) | **100% Offline** | None | No | End-to-end KVP-103 dual-key Ed25519 stealth flow: generate meta-address → sender derives one-time address + view tag → watch-only scan → recover spend scalar → sign & verify sighash |

## Quick Start

Run from the `kovanica-sdk` directory:

```bash
# 1. Derive BIP-44 wallet, check testnet balance, build & sign KVNC transfer (dry-run)
npx tsx examples/01-transfer-kvnc.ts

# Force offline dry-run (no network calls)
KOVANICA_OFFLINE=1 npx tsx examples/01-transfer-kvnc.ts

# Broadcast to testnet (requires a funded testnet account via KOVANICA_MNEMONIC)
KOVANICA_MNEMONIC="your twelve word ..." KOVANICA_BROADCAST=1 npx tsx examples/01-transfer-kvnc.ts

# 2. Build & sign a KVP-102 token_create call with fee schedule inspection
npx tsx examples/02-deploy-kvp102-token.ts

# 3. Quote an AMM swap & sign a Wave A 1-tx atomic Approve -> Swap batch (100% offline)
npx tsx examples/03-amm-atomic-swap.ts

# 4. Build KVP-106 RWA creation + Wave A compliance batch allowlist call (100% offline)
npx tsx examples/04-rwa-issuance.ts

# 5. End-to-end KVP-103 dual-key Ed25519 stealth send, scan & spend demo (100% offline)
npx tsx examples/05-stealth-send-scan.ts
```

## Environment Variables

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `KOVANICA_RPC_URL` | `https://rpc-testnet.kovanica.online/rpc` | `01`, `02`, `04` | Override the JSON-RPC endpoint |
| `KOVANICA_OFFLINE` | unset (`0`) | `01`, `02` | Set to `1` to skip all RPC calls and run purely offline |
| `KOVANICA_BROADCAST` | unset (`0`) | `01`, `02` | Set to `1` to broadcast the signed transaction via `sendRawTransaction` |
| `KOVANICA_MNEMONIC` | Standard BIP-39 test phrase | `01`, `02`, `03`, `04` | **Never** commit real mnemonics; supply via env var for funded testnet runs |
