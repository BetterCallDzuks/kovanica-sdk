//! Constant-Product (`x * y = k`) Native AMM / DEX Contract for Kovanica Protocol.
//!
//! Features:
//! - Supports both `KVNC / KVP-20` (`NATIVE_KVNC_TOKEN = [0u8; 32]`) and `KVP-20 / KVP-20` pairs
//! - Canonical token sorting (`token0 < token1`) and deterministic BLAKE3 `pool_id`
//! - 0.30% LP fee (`FEE_BPS = 30`, `997 / 1000`) accrued directly to pool reserves
//! - `MINIMUM_LIQUIDITY = 1_000` locked on first mint to mitigate share inflation attacks
//! - Strict slippage guards (`min_lp_out`, `min_amount0`, `min_amount1`, `min_out`)
//! - Checks-Effects-Interactions + persistent reentrancy lock + Wave A CPI depth <= 4 guard
//! - Overflow-safe 256-bit intermediate arithmetic for all reserve & fee calculations

pub mod host;
pub mod math;

use host::{blake3_hash, Address, Amount, ContractError, ContractResult, Host, MAX_CPI_DEPTH};
use math::{isqrt_product, mul_div, U256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Sentinel 32-byte token address representing native KVNC.
pub const NATIVE_KVNC_TOKEN: Address = [0u8; 32];

/// LP fee in basis points (0.30% = 30 bps).
pub const LP_FEE_BPS: u128 = 30;
pub const FEE_DENOMINATOR: u128 = 1_000;
pub const FEE_NUMERATOR: u128 = 997;

/// Minimum LP shares permanently burned to the zero address on initial liquidity provision.
pub const MINIMUM_LIQUIDITY: Amount = 1_000;

pub const STATE_KEY: &[u8] = b"kvnc/v1/amm/state";
pub const LOCK_KEY: &[u8] = b"kvnc/v1/amm/lock";

pub const EVENT_POOL_CREATED: &[u8] = b"amm/pool_created";
pub const EVENT_LIQUIDITY_ADDED: &[u8] = b"amm/liquidity_added";
pub const EVENT_LIQUIDITY_REMOVED: &[u8] = b"amm/liquidity_removed";
pub const EVENT_SWAP: &[u8] = b"amm/swap";

pub type PoolId = [u8; 32];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoolState {
    pub pool_id: PoolId,
    pub token0: Address,
    pub token1: Address,
    pub reserve0: Amount,
    pub reserve1: Amount,
    pub total_lp_supply: Amount,
    pub fee_bps: u16,
    pub lp_balances: BTreeMap<Address, Amount>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AmmState {
    pub pools: BTreeMap<PoolId, PoolState>,
}

impl AmmState {
    pub fn load(host: &impl Host) -> ContractResult<Self> {
        match host.storage_get(STATE_KEY) {
            Some(bytes) => bincode::deserialize(&bytes).map_err(|_| ContractError::Custom(2)),
            None => Ok(Self::default()),
        }
    }

    fn store(&self, host: &mut impl Host) -> ContractResult<()> {
        let bytes = bincode::serialize(self).map_err(|_| ContractError::Custom(1))?;
        host.storage_set(STATE_KEY, &bytes);
        Ok(())
    }
}

/// Canonical token ordering (`token0 < token1`). Rejects identical tokens.
pub fn sort_tokens(token_a: Address, token_b: Address) -> ContractResult<(Address, Address)> {
    if token_a == token_b {
        return Err(ContractError::InvalidInput);
    }
    if token_a < token_b {
        Ok((token_a, token_b))
    } else {
        Ok((token_b, token_a))
    }
}

/// Deterministic 32-byte pool ID: `blake3("kvnc/v1/amm/pool" || token0 || token1)`.
pub fn derive_pool_id(token_a: Address, token_b: Address) -> ContractResult<PoolId> {
    let (token0, token1) = sort_tokens(token_a, token_b)?;
    let mut buf = Vec::with_capacity(16 + 32 + 32);
    buf.extend_from_slice(b"kvnc/v1/amm/pool");
    buf.extend_from_slice(&token0);
    buf.extend_from_slice(&token1);
    Ok(blake3_hash(&buf))
}

/// Pure constant-product quote with 0.30% LP fee:
/// `amount_out = floor((amount_in * 997 * reserve_out) / (reserve_in * 1000 + amount_in * 997))`.
pub fn quote_swap_exact_in(
    amount_in: Amount,
    reserve_in: Amount,
    reserve_out: Amount,
) -> ContractResult<Amount> {
    if amount_in == 0 {
        return Err(ContractError::InvalidInput);
    }
    if reserve_in == 0 || reserve_out == 0 {
        return Err(ContractError::ZeroLiquidity);
    }
    let amount_in_with_fee = U256::mul_u128(amount_in, FEE_NUMERATOR);
    // Multiply amount_in_with_fee by reserve_out safely:
    // Since amount_in_with_fee = amount_in * 997, compute numerator in U256 if amount_in_with_fee fits u128.
    let amount_in_fee_u128 = amount_in_with_fee.to_u128()?;
    let numerator = U256::mul_u128(amount_in_fee_u128, reserve_out);
    let denom_base = U256::mul_u128(reserve_in, FEE_DENOMINATOR);
    let denominator = denom_base
        .checked_add(amount_in_with_fee)
        .ok_or(ContractError::Overflow)?;
    let out = numerator
        .checked_div(denominator)
        .ok_or(ContractError::Overflow)?
        .to_u128()?;
    if out == 0 || out >= reserve_out {
        return Err(ContractError::ZeroLiquidity);
    }
    Ok(out)
}

fn acquire_lock(host: &mut impl Host) -> ContractResult<()> {
    if host.cpi_depth() >= MAX_CPI_DEPTH {
        return Err(ContractError::CpiDepthExceeded);
    }
    if let Some(flag) = host.storage_get(LOCK_KEY) {
        if flag.first().copied() == Some(1) {
            return Err(ContractError::Reentrancy);
        }
    }
    host.storage_set(LOCK_KEY, &[1u8]);
    Ok(())
}

fn release_lock(host: &mut impl Host) {
    host.storage_set(LOCK_KEY, &[0u8]);
}

/// Pulls `amount` of `token` from `from` into this AMM contract.
/// For `NATIVE_KVNC_TOKEN`, verifies `host.call_value() >= amount`.
/// For KVP-20 tokens, performs a CPI `token_transfer_from(from, contract, amount)`.
fn pull_token(
    host: &mut impl Host,
    token: &Address,
    from: &Address,
    amount: Amount,
) -> ContractResult<()> {
    if amount == 0 {
        return Ok(());
    }
    if *token == NATIVE_KVNC_TOKEN {
        if host.call_value() < amount {
            return Err(ContractError::InsufficientBalance);
        }
        return Ok(());
    }
    let contract_self = host.contract_address();
    let args = bincode::serialize(&(*from, contract_self, amount))
        .map_err(|_| ContractError::Custom(1))?;
    host.call_contract(token, "token_transfer_from", &args, 0)?;
    Ok(())
}

/// Pushes `amount` of `token` from this AMM contract to `to`.
/// For `NATIVE_KVNC_TOKEN`, invokes `host.transfer(contract, to, amount)`.
/// For KVP-20 tokens, performs a CPI `token_transfer(to, amount)`.
fn push_token(
    host: &mut impl Host,
    token: &Address,
    to: &Address,
    amount: Amount,
) -> ContractResult<()> {
    if amount == 0 {
        return Ok(());
    }
    if *token == NATIVE_KVNC_TOKEN {
        let contract_self = host.contract_address();
        return host.transfer(&contract_self, to, amount);
    }
    let args = bincode::serialize(&(*to, amount)).map_err(|_| ContractError::Custom(1))?;
    host.call_contract(token, "token_transfer", &args, 0)?;
    Ok(())
}

pub struct Amm;

impl Amm {
    /// Create a new constant-product pool for `(token_a, token_b)`.
    pub fn create_pool(
        host: &mut impl Host,
        token_a: Address,
        token_b: Address,
    ) -> ContractResult<PoolId> {
        acquire_lock(host)?;
        let res = Self::create_pool_inner(host, token_a, token_b);
        release_lock(host);
        res
    }

    fn create_pool_inner(
        host: &mut impl Host,
        token_a: Address,
        token_b: Address,
    ) -> ContractResult<PoolId> {
        let (token0, token1) = sort_tokens(token_a, token_b)?;
        let pool_id = derive_pool_id(token0, token1)?;
        let mut state = AmmState::load(host)?;
        if state.pools.contains_key(&pool_id) {
            return Err(ContractError::AlreadyExists);
        }
        let pool = PoolState {
            pool_id,
            token0,
            token1,
            reserve0: 0,
            reserve1: 0,
            total_lp_supply: 0,
            fee_bps: LP_FEE_BPS as u16,
            lp_balances: BTreeMap::new(),
        };
        state.pools.insert(pool_id, pool);
        state.store(host)?;
        host.emit_event(EVENT_POOL_CREATED, &pool_id);
        Ok(pool_id)
    }

    /// Add liquidity to an existing pool and mint LP shares to `host.caller()`.
    /// Returns `(amount0_used, amount1_used, lp_minted)`.
    pub fn add_liquidity(
        host: &mut impl Host,
        pool_id: PoolId,
        amount0_desired: Amount,
        amount1_desired: Amount,
        min_lp_out: Amount,
    ) -> ContractResult<(Amount, Amount, Amount)> {
        acquire_lock(host)?;
        let res = Self::add_liquidity_inner(
            host,
            pool_id,
            amount0_desired,
            amount1_desired,
            min_lp_out,
        );
        release_lock(host);
        res
    }

    fn add_liquidity_inner(
        host: &mut impl Host,
        pool_id: PoolId,
        amount0_desired: Amount,
        amount1_desired: Amount,
        min_lp_out: Amount,
    ) -> ContractResult<(Amount, Amount, Amount)> {
        if amount0_desired == 0 || amount1_desired == 0 {
            return Err(ContractError::InvalidInput);
        }
        let caller = host.caller();
        let mut state = AmmState::load(host)?;
        let pool = state
            .pools
            .get_mut(&pool_id)
            .ok_or(ContractError::NotFound)?;

        let (amount0, amount1, lp_minted, total_lp_delta) = if pool.total_lp_supply == 0 {
            let root = isqrt_product(amount0_desired, amount1_desired);
            if root <= MINIMUM_LIQUIDITY {
                return Err(ContractError::InsufficientBalance);
            }
            let minted = root - MINIMUM_LIQUIDITY;
            (amount0_desired, amount1_desired, minted, root)
        } else {
            let amount1_optimal = mul_div(amount0_desired, pool.reserve1, pool.reserve0)?;
            let (used0, used1) = if amount1_optimal <= amount1_desired {
                (amount0_desired, amount1_optimal)
            } else {
                let amount0_optimal = mul_div(amount1_desired, pool.reserve0, pool.reserve1)?;
                (amount0_optimal, amount1_desired)
            };
            if used0 == 0 || used1 == 0 {
                return Err(ContractError::InvalidInput);
            }
            let lp0 = mul_div(used0, pool.total_lp_supply, pool.reserve0)?;
            let lp1 = mul_div(used1, pool.total_lp_supply, pool.reserve1)?;
            let minted = lp0.min(lp1);
            (used0, used1, minted, minted)
        };

        if lp_minted == 0 || lp_minted < min_lp_out {
            return Err(ContractError::SlippageExceeded);
        }

        let token0 = pool.token0;
        let token1 = pool.token1;

        // Effects BEFORE external interactions (CEI)
        pool.reserve0 = pool
            .reserve0
            .checked_add(amount0)
            .ok_or(ContractError::Overflow)?;
        pool.reserve1 = pool
            .reserve1
            .checked_add(amount1)
            .ok_or(ContractError::Overflow)?;
        if pool.total_lp_supply == 0 {
            pool.lp_balances.insert([0u8; 32], MINIMUM_LIQUIDITY);
        }
        pool.total_lp_supply = pool
            .total_lp_supply
            .checked_add(total_lp_delta)
            .ok_or(ContractError::Overflow)?;
        let prev_lp = pool.lp_balances.get(&caller).copied().unwrap_or(0);
        let next_lp = prev_lp
            .checked_add(lp_minted)
            .ok_or(ContractError::Overflow)?;
        pool.lp_balances.insert(caller, next_lp);
        state.store(host)?;

        // Interactions
        pull_token(host, &token0, &caller, amount0)?;
        pull_token(host, &token1, &caller, amount1)?;

        host.emit_event(EVENT_LIQUIDITY_ADDED, &pool_id);
        Ok((amount0, amount1, lp_minted))
    }

    /// Burn `lp_amount` LP shares from `host.caller()` and return `(amount0, amount1)`.
    pub fn remove_liquidity(
        host: &mut impl Host,
        pool_id: PoolId,
        lp_amount: Amount,
        min_amount0: Amount,
        min_amount1: Amount,
    ) -> ContractResult<(Amount, Amount)> {
        acquire_lock(host)?;
        let res = Self::remove_liquidity_inner(host, pool_id, lp_amount, min_amount0, min_amount1);
        release_lock(host);
        res
    }

    fn remove_liquidity_inner(
        host: &mut impl Host,
        pool_id: PoolId,
        lp_amount: Amount,
        min_amount0: Amount,
        min_amount1: Amount,
    ) -> ContractResult<(Amount, Amount)> {
        if lp_amount == 0 {
            return Err(ContractError::InvalidInput);
        }
        let caller = host.caller();
        let mut state = AmmState::load(host)?;
        let pool = state
            .pools
            .get_mut(&pool_id)
            .ok_or(ContractError::NotFound)?;

        if pool.total_lp_supply == 0 {
            return Err(ContractError::ZeroLiquidity);
        }
        let caller_lp = pool.lp_balances.get(&caller).copied().unwrap_or(0);
        if caller_lp < lp_amount {
            return Err(ContractError::InsufficientBalance);
        }

        let amount0 = mul_div(lp_amount, pool.reserve0, pool.total_lp_supply)?;
        let amount1 = mul_div(lp_amount, pool.reserve1, pool.total_lp_supply)?;
        if amount0 < min_amount0 || amount1 < min_amount1 {
            return Err(ContractError::SlippageExceeded);
        }
        if amount0 == 0 && amount1 == 0 {
            return Err(ContractError::ZeroLiquidity);
        }

        let token0 = pool.token0;
        let token1 = pool.token1;

        // Effects BEFORE external interactions (CEI)
        let rem_lp = caller_lp - lp_amount;
        if rem_lp == 0 {
            pool.lp_balances.remove(&caller);
        } else {
            pool.lp_balances.insert(caller, rem_lp);
        }
        pool.total_lp_supply -= lp_amount;
        pool.reserve0 -= amount0;
        pool.reserve1 -= amount1;
        state.store(host)?;

        // Interactions
        push_token(host, &token0, &caller, amount0)?;
        push_token(host, &token1, &caller, amount1)?;

        host.emit_event(EVENT_LIQUIDITY_REMOVED, &pool_id);
        Ok((amount0, amount1))
    }

    /// Swap exact `amount_in` of `token_in` for the paired token, enforcing `amount_out >= min_out`.
    pub fn swap_exact_in(
        host: &mut impl Host,
        pool_id: PoolId,
        token_in: Address,
        amount_in: Amount,
        min_out: Amount,
    ) -> ContractResult<Amount> {
        acquire_lock(host)?;
        let res = Self::swap_exact_in_inner(host, pool_id, token_in, amount_in, min_out);
        release_lock(host);
        res
    }

    fn swap_exact_in_inner(
        host: &mut impl Host,
        pool_id: PoolId,
        token_in: Address,
        amount_in: Amount,
        min_out: Amount,
    ) -> ContractResult<Amount> {
        if amount_in == 0 {
            return Err(ContractError::InvalidInput);
        }
        let caller = host.caller();
        let mut state = AmmState::load(host)?;
        let pool = state
            .pools
            .get_mut(&pool_id)
            .ok_or(ContractError::NotFound)?;

        let (zero_for_one, reserve_in, reserve_out, token_out) = if token_in == pool.token0 {
            (true, pool.reserve0, pool.reserve1, pool.token1)
        } else if token_in == pool.token1 {
            (false, pool.reserve1, pool.reserve0, pool.token0)
        } else {
            return Err(ContractError::InvalidInput);
        };

        let amount_out = quote_swap_exact_in(amount_in, reserve_in, reserve_out)?;
        if amount_out < min_out {
            return Err(ContractError::SlippageExceeded);
        }

        let new_reserve_in = reserve_in
            .checked_add(amount_in)
            .ok_or(ContractError::Overflow)?;
        let new_reserve_out = reserve_out
            .checked_sub(amount_out)
            .ok_or(ContractError::Overflow)?;

        // Constant-product invariant check: new_k >= old_k
        let old_k = U256::mul_u128(reserve_in, reserve_out);
        let new_k = U256::mul_u128(new_reserve_in, new_reserve_out);
        if new_k < old_k {
            return Err(ContractError::Overflow);
        }

        // Effects BEFORE external interactions (CEI)
        if zero_for_one {
            pool.reserve0 = new_reserve_in;
            pool.reserve1 = new_reserve_out;
        } else {
            pool.reserve1 = new_reserve_in;
            pool.reserve0 = new_reserve_out;
        }
        state.store(host)?;

        // Interactions
        pull_token(host, &token_in, &caller, amount_in)?;
        push_token(host, &token_out, &caller, amount_out)?;

        host.emit_event(EVENT_SWAP, &pool_id);
        Ok(amount_out)
    }

    pub fn get_pool(host: &impl Host, pool_id: PoolId) -> ContractResult<PoolState> {
        let state = AmmState::load(host)?;
        state
            .pools
            .get(&pool_id)
            .cloned()
            .ok_or(ContractError::NotFound)
    }

    pub fn lp_balance_of(host: &impl Host, pool_id: PoolId, account: Address) -> ContractResult<Amount> {
        let pool = Self::get_pool(host, pool_id)?;
        Ok(pool.lp_balances.get(&account).copied().unwrap_or(0))
    }
}

// ============================================================================
// Deterministic WASM32 Entry Points (Kovanica Wasmi Fixed ABI)
// ============================================================================

#[cfg(target_arch = "wasm32")]
mod wasm_exports {
    use super::*;
    use crate::host::wasm_host::WasmHost;

    fn read_args(ptr: i32, len: i32) -> &'static [u8] {
        if ptr <= 0 || len <= 0 {
            return &[];
        }
        unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) }
    }

    #[no_mangle]
    pub extern "C" fn amm_create_pool(args_ptr: i32, args_len: i32) -> i32 {
        let mut host = WasmHost;
        let args = read_args(args_ptr, args_len);
        let Ok((token_a, token_b)) = bincode::deserialize::<(Address, Address)>(args) else {
            return ContractError::InvalidInput.packed_rc();
        };
        match Amm::create_pool(&mut host, token_a, token_b) {
            Ok(_) => 0,
            Err(e) => e.packed_rc(),
        }
    }

    #[no_mangle]
    pub extern "C" fn amm_add_liquidity(args_ptr: i32, args_len: i32) -> i32 {
        let mut host = WasmHost;
        let args = read_args(args_ptr, args_len);
        let Ok((pool_id, a0, a1, min_lp)) =
            bincode::deserialize::<(PoolId, Amount, Amount, Amount)>(args)
        else {
            return ContractError::InvalidInput.packed_rc();
        };
        match Amm::add_liquidity(&mut host, pool_id, a0, a1, min_lp) {
            Ok(_) => 0,
            Err(e) => e.packed_rc(),
        }
    }

    #[no_mangle]
    pub extern "C" fn amm_remove_liquidity(args_ptr: i32, args_len: i32) -> i32 {
        let mut host = WasmHost;
        let args = read_args(args_ptr, args_len);
        let Ok((pool_id, lp, min0, min1)) =
            bincode::deserialize::<(PoolId, Amount, Amount, Amount)>(args)
        else {
            return ContractError::InvalidInput.packed_rc();
        };
        match Amm::remove_liquidity(&mut host, pool_id, lp, min0, min1) {
            Ok(_) => 0,
            Err(e) => e.packed_rc(),
        }
    }

    #[no_mangle]
    pub extern "C" fn amm_swap_exact_in(args_ptr: i32, args_len: i32) -> i32 {
        let mut host = WasmHost;
        let args = read_args(args_ptr, args_len);
        let Ok((pool_id, token_in, amount_in, min_out)) =
            bincode::deserialize::<(PoolId, Address, Amount, Amount)>(args)
        else {
            return ContractError::InvalidInput.packed_rc();
        };
        match Amm::swap_exact_in(&mut host, pool_id, token_in, amount_in, min_out) {
            Ok(_) => 0,
            Err(e) => e.packed_rc(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::MockAmmHost;

    fn addr(b: u8) -> Address {
        [b; 32]
    }

    #[test]
    fn test_create_pool_canonical_ordering_and_duplicates() {
        let mut host = MockAmmHost::new(addr(1), addr(99));
        let kvp_a = addr(0xAA);
        let kvp_b = addr(0xBB);

        // Identical tokens rejected
        assert_eq!(
            Amm::create_pool(&mut host, kvp_a, kvp_a),
            Err(ContractError::InvalidInput)
        );

        // Create KVP-20 / KVP-20 pool (unsorted args still yield canonical pool_id)
        let pid = Amm::create_pool(&mut host, kvp_b, kvp_a).expect("create pool");
        assert_eq!(pid, derive_pool_id(kvp_a, kvp_b).unwrap());

        let pool = Amm::get_pool(&host, pid).unwrap();
        assert_eq!(pool.token0, kvp_a);
        assert_eq!(pool.token1, kvp_b);
        assert_eq!(pool.fee_bps, 30);

        // Duplicate pool rejected
        assert_eq!(
            Amm::create_pool(&mut host, kvp_a, kvp_b),
            Err(ContractError::AlreadyExists)
        );

        // KVNC / KVP-20 pair works with NATIVE_KVNC_TOKEN as token0
        let native_pid = Amm::create_pool(&mut host, kvp_a, NATIVE_KVNC_TOKEN).unwrap();
        let native_pool = Amm::get_pool(&host, native_pid).unwrap();
        assert_eq!(native_pool.token0, NATIVE_KVNC_TOKEN);
        assert_eq!(native_pool.token1, kvp_a);
    }

    #[test]
    fn test_add_remove_liquidity_and_lp_mint_burn() {
        let alice = addr(1);
        let amm_addr = addr(99);
        let mut host = MockAmmHost::new(alice, amm_addr);
        let token_a = addr(0x10);
        let token_b = addr(0x20);
        let pid = Amm::create_pool(&mut host, token_a, token_b).unwrap();

        // First deposit: 1_000_000 x 4_000_000 -> sqrt = 2_000_000 -> lp = 2_000_000 - 1_000
        let (u0, u1, lp) = Amm::add_liquidity(&mut host, pid, 1_000_000, 4_000_000, 1_999_000).unwrap();
        assert_eq!(u0, 1_000_000);
        assert_eq!(u1, 4_000_000);
        assert_eq!(lp, 1_999_000);
        assert_eq!(Amm::lp_balance_of(&host, pid, alice).unwrap(), 1_999_000);
        assert_eq!(Amm::lp_balance_of(&host, pid, [0u8; 32]).unwrap(), MINIMUM_LIQUIDITY);

        // Subsequent deposit with non-optimal ratio gets clamped to pool ratio (1:4)
        let (u0_b, u1_b, lp_b) = Amm::add_liquidity(&mut host, pid, 500_000, 3_000_000, 1_000_000).unwrap();
        assert_eq!(u0_b, 500_000);
        assert_eq!(u1_b, 2_000_000);
        assert_eq!(lp_b, 1_000_000);

        // Slippage guard on add_liquidity
        assert_eq!(
            Amm::add_liquidity(&mut host, pid, 100_000, 400_000, 500_000),
            Err(ContractError::SlippageExceeded)
        );

        // Remove half of Alice's LP
        let alice_lp = Amm::lp_balance_of(&host, pid, alice).unwrap();
        let burn_lp = alice_lp / 2;
        let (out0, out1) = Amm::remove_liquidity(&mut host, pid, burn_lp, 1, 1).unwrap();
        assert!(out0 > 0 && out1 > 0);
        assert_eq!(Amm::lp_balance_of(&host, pid, alice).unwrap(), alice_lp - burn_lp);

        // Slippage guard on remove_liquidity
        assert_eq!(
            Amm::remove_liquidity(&mut host, pid, 100, u128::MAX, 0),
            Err(ContractError::SlippageExceeded)
        );
    }

    #[test]
    fn test_swap_exact_in_fee_math_slippage_and_zero_liquidity() {
        let alice = addr(1);
        let amm_addr = addr(99);
        let mut host = MockAmmHost::new(alice, amm_addr);
        let token_b = addr(0x22);
        let pid = Amm::create_pool(&mut host, NATIVE_KVNC_TOKEN, token_b).unwrap();

        // Zero liquidity reverts
        assert_eq!(
            Amm::swap_exact_in(&mut host, pid, NATIVE_KVNC_TOKEN, 1_000, 1),
            Err(ContractError::ZeroLiquidity)
        );

        // Seed 1_000_000_000 KVNC + 1_000_000_000 KVP-20
        host.value = 1_000_000_000;
        host.native_balances.insert(amm_addr, 1_000_000_000);
        Amm::add_liquidity(&mut host, pid, 1_000_000_000, 1_000_000_000, 1).unwrap();

        // Exact 0.30% fee math:
        // amount_in = 10_000_000 -> in_with_fee = 9_970_000_000
        // out = floor(9_970_000_000 * 1_000_000_000 / (1_000_000_000 * 1000 + 9_970_000_000))
        //     = floor(9_970_000_000_000_000_000 / 1_009_970_000_000) = 9_871_580
        let quoted = quote_swap_exact_in(10_000_000, 1_000_000_000, 1_000_000_000).unwrap();
        assert_eq!(quoted, 9_871_580);

        // Slippage min_out revert
        host.value = 10_000_000;
        assert_eq!(
            Amm::swap_exact_in(&mut host, pid, NATIVE_KVNC_TOKEN, 10_000_000, quoted + 1),
            Err(ContractError::SlippageExceeded)
        );

        // Successful swap
        let out = Amm::swap_exact_in(&mut host, pid, NATIVE_KVNC_TOKEN, 10_000_000, quoted).unwrap();
        assert_eq!(out, 9_871_580);

        // Verify k strictly increased due to 0.30% LP fee
        let pool = Amm::get_pool(&host, pid).unwrap();
        let old_k = U256::mul_u128(1_000_000_000, 1_000_000_000);
        let new_k = U256::mul_u128(pool.reserve0, pool.reserve1);
        assert!(new_k > old_k);
    }

    #[test]
    fn test_overflow_protection_large_reserves() {
        // Reserves near 10^30 (well beyond u64::MAX, would overflow naive u128*u128)
        let r_in: u128 = 10u128.pow(30);
        let r_out: u128 = 10u128.pow(30);
        let a_in: u128 = 10u128.pow(27);
        let out = quote_swap_exact_in(a_in, r_in, r_out).expect("256-bit math handles 10^30");
        assert!(out > 0 && out < a_in);

        // Overflow when amount_in * 997 exceeds u128::MAX
        assert_eq!(
            quote_swap_exact_in(u128::MAX, r_in, r_out),
            Err(ContractError::Overflow)
        );
    }

    #[test]
    fn test_reentrancy_guard_and_cpi_depth_limit() {
        let alice = addr(1);
        let amm_addr = addr(99);
        let mut host = MockAmmHost::new(alice, amm_addr);
        let token_a = addr(0x30);
        let token_b = addr(0x40);
        let pid = Amm::create_pool(&mut host, token_a, token_b).unwrap();
        Amm::add_liquidity(&mut host, pid, 1_000_000, 1_000_000, 1).unwrap();

        // Malicious KVP-20 token attempts reentrant swap during CPI
        host.reentrant_hook = Some(Box::new(move |h| {
            let reenter = Amm::swap_exact_in(h, pid, token_a, 1_000, 1);
            assert_eq!(reenter, Err(ContractError::Reentrancy));
            reenter.map(|_| ())
        }));
        assert_eq!(
            Amm::swap_exact_in(&mut host, pid, token_a, 10_000, 1),
            Err(ContractError::Reentrancy)
        );

        // Lock must be released cleanly after error
        assert_eq!(host.storage_get(LOCK_KEY), Some(vec![0u8]));

        // CPI depth >= 4 rejected
        host.depth = MAX_CPI_DEPTH;
        assert_eq!(
            Amm::swap_exact_in(&mut host, pid, token_a, 10_000, 1),
            Err(ContractError::CpiDepthExceeded)
        );
    }
}
