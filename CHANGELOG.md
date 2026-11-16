# Changelog

All notable changes to `kovanica-sdk` are documented in this file.

## [Unreleased]

### Changed
- Updated the verified `KovanicaDAG/kovanica-l1` RPC reference commit in `README.md` from `feab9050b178ee6d25798c0976a7fa138e90f537` to `511af88532dceebdf0349b63c6c4c898eee7ca6e` (and confirmed `crates/kovanica-rpc` is unchanged on current `kovanica-l1` `main` at `9758ffe0d0129dd58851d916d183753618fd71de`).
- Re-confirmed all 18 read-only JSON-RPC methods (`kovanica_blockNumber`, `kovanica_getBlockByNumber`, `kovanica_getBlockByHash`, `kovanica_getBalance`, `kovanica_getNonce`, `kovanica_getCode`, `kovanica_getStorageAt`, `kovanica_getTransactionByHash`, `kovanica_getTransactionReceipt`, `kovanica_getPendingTransactions`, `kovanica_estimateFee`, `kovanica_getValidators`, `kovanica_getStake`, `kovanica_getRewards`, `kovanica_getLeaderSchedule`, `kovanica_syncStatus`, `kovanica_getMiningInfo`, `kovanica_getDagTips`) match `crates/kovanica-rpc/src/lib.rs` and `crates/kovanica-rpc/src/chain_methods.rs`.
- Confirmed `kovanica_getMiningInfo` and `kovanica_getDagTips` payloads match Hybrid PoW + GHOSTDAG (Chains 1 & 2), chain registry remains `1 / 2 / 3 / 1337` with strict PRO-21 enforcement on Chains 1 & 2, and the SDK remains strictly read-only (no private key derivation, transaction signing, or mining submit).

## [0.1.0] - 2026-11-14

- Initial read-only TypeScript developer preview for Kovanica (KVNC).
