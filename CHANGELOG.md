# Changelog

All notable changes to `kovanica-sdk` are documented in this file.

## [Unreleased]

### Added
- Official frozen `networkTag` metadata on `ChainConfig` and `NETWORK_TAGS` (`MAINNET: "1-4d827d40dd9655db"`, `TESTNET: "2-acfdf6a6c80fd28a"`) following the L1 #290 (`P4-3`) mainnet genesis ceremony.
- `KovanicaRpcError.isInvalidRequest()` to classify JSON-RPC `-32600` rejections as "method exists but is not applicable on this network".
- Deterministic tests asserting that `getValidators`, `getStake`, and `getLeaderSchedule` surface the L1 #272 hybrid-chain rejection as `KovanicaRpcError` (`-32600`) on Chains `1` and `2`, never as `[]` or `0n`, with a Devnet (`3`) pass-through control.

### Changed
- Updated the verified `KovanicaDAG/kovanica-l1` reference commit to `d2239fd8314a0c6edb08d54724738d662d406a32` (post-#290/#291; previous: `de641f6f305287de56a42ee559d8f490afc8b7bd`).
- Retired chain ID `1337` (`LOCAL`) from `CHAIN_IDS`, `KNOWN_CHAINS`, and `isLegacyAddressAllowed()`; the canonical chain registry is now `1` (Mainnet), `2` (Testnet), and `3` (Devnet, also used for local testing).
- Documented that `getValidators`, `getStake`, and `getLeaderSchedule` are legacy (Mysticeti) methods, and that hybrid PoW + GHOSTDAG Chains `1` & `2` reject them with `-32600` since L1 #272 (`4181fc6`). README compatibility matrix now lists `3` for these three methods.
- Updated the verified `KovanicaDAG/kovanica-l1` RPC reference commit in `README.md` to `de641f6f305287de56a42ee559d8f490afc8b7bd` (previous: `511af88532dceebdf0349b63c6c4c898eee7ca6e`), which includes L1 #272 (`4181fc6`) rejecting legacy staking RPCs on hybrid Chains `1` & `2`.
- Re-confirmed all 18 read-only JSON-RPC methods (`kovanica_blockNumber`, `kovanica_getBlockByNumber`, `kovanica_getBlockByHash`, `kovanica_getBalance`, `kovanica_getNonce`, `kovanica_getCode`, `kovanica_getStorageAt`, `kovanica_getTransactionByHash`, `kovanica_getTransactionReceipt`, `kovanica_getPendingTransactions`, `kovanica_estimateFee`, `kovanica_getValidators`, `kovanica_getStake`, `kovanica_getRewards`, `kovanica_getLeaderSchedule`, `kovanica_syncStatus`, `kovanica_getMiningInfo`, `kovanica_getDagTips`) match `crates/kovanica-rpc/src/lib.rs` and `crates/kovanica-rpc/src/chain_methods.rs`.
- Confirmed `kovanica_getMiningInfo` and `kovanica_getDagTips` payloads match Hybrid PoW + GHOSTDAG (Chains 1 & 2), chain registry remains `1 / 2 / 3 / 1337` with strict PRO-21 enforcement on Chains 1 & 2, and the SDK remains strictly read-only (no private key derivation, transaction signing, or mining submit).

## [0.1.0] - 2026-11-14

- Initial read-only TypeScript developer preview for Kovanica (KVNC).
