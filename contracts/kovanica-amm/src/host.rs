//! Kovanica Wasmi Host ABI and in-memory test host for `kovanica-amm`.
//!
//! Mirrors the canonical `env`-module imports of `kovanica-common` without
//! depending on `kovanica-l1` workspace crates, keeping `kovanica-amm`
//! completely standalone.

use std::collections::BTreeMap;

pub type Address = [u8; 32];
pub type Amount = u128;
pub type ContractResult<T> = Result<T, ContractError>;

/// Maximum Wave A Cross-Program Invocation (CPI) nesting depth.
pub const MAX_CPI_DEPTH: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    Unauthorized,
    InsufficientBalance,
    InvalidInput,
    AlreadyExists,
    NotFound,
    SlippageExceeded,
    ZeroLiquidity,
    Reentrancy,
    CpiDepthExceeded,
    Overflow,
    Custom(u32),
}

impl ContractError {
    pub fn code(&self) -> i32 {
        match self {
            Self::Unauthorized => 0,
            Self::InsufficientBalance => 1,
            Self::InvalidInput => 2,
            Self::AlreadyExists => 3,
            Self::NotFound => 4,
            Self::Overflow => 10,
            Self::SlippageExceeded => 11,
            Self::ZeroLiquidity => 11,
            Self::Reentrancy => 11,
            Self::CpiDepthExceeded => 11,
            Self::Custom(_) => 11,
        }
    }

    pub fn packed_rc(&self) -> i32 {
        -1 - self.code()
    }
}

/// Host abstraction implemented by `WasmHost` on `wasm32` and `MockAmmHost` in tests.
pub trait Host {
    fn caller(&self) -> Address;
    fn contract_address(&self) -> Address;
    fn call_value(&self) -> Amount;
    fn cpi_depth(&self) -> u8 {
        0
    }
    fn transfer(&mut self, from: &Address, to: &Address, amount: Amount) -> ContractResult<()>;
    fn storage_get(&self, key: &[u8]) -> Option<Vec<u8>>;
    fn storage_set(&mut self, key: &[u8], value: &[u8]);
    fn emit_event(&mut self, topic: &[u8], data: &[u8]);
    fn call_contract(
        &mut self,
        target: &Address,
        method: &str,
        args: &[u8],
        value: Amount,
    ) -> ContractResult<Vec<u8>>;
}

/// Canonical BLAKE3-256 hash.
pub fn blake3_hash(data: &[u8]) -> [u8; 32] {
    *blake3::hash(data).as_bytes()
}

#[cfg(target_arch = "wasm32")]
pub mod wasm_host {
    use super::*;

    mod imports {
        #[link(wasm_import_module = "env")]
        extern "C" {
            pub fn kovanica_caller(out_ptr: i32);
            pub fn kovanica_contract_address(out_ptr: i32);
            pub fn kovanica_call_value() -> i64;
            pub fn kovanica_transfer(fp: i32, fl: i32, tp: i32, tl: i32, amount: i64) -> i32;
            pub fn kovanica_storage_get(kp: i32, kl: i32, out_ptr: i32, out_cap: i32) -> i32;
            pub fn kovanica_storage_set(kp: i32, kl: i32, vp: i32, vl: i32) -> i32;
            pub fn kovanica_emit_event(tp: i32, tl: i32, dp: i32, dl: i32);
            pub fn kovanica_call_contract(
                target_ptr: i32,
                method_ptr: i32,
                method_len: i32,
                args_ptr: i32,
                args_len: i32,
                value: i64,
            ) -> i32;
        }
    }

    pub struct WasmHost;

    impl Host for WasmHost {
        fn caller(&self) -> Address {
            let mut out = [0u8; 32];
            unsafe { imports::kovanica_caller(out.as_mut_ptr() as i32) };
            out
        }

        fn contract_address(&self) -> Address {
            let mut out = [0u8; 32];
            unsafe { imports::kovanica_contract_address(out.as_mut_ptr() as i32) };
            out
        }

        fn call_value(&self) -> Amount {
            match u64::try_from(unsafe { imports::kovanica_call_value() }) {
                Ok(v) => Amount::from(v),
                Err(_) => 0,
            }
        }

        fn transfer(&mut self, from: &Address, to: &Address, amount: Amount) -> ContractResult<()> {
            if amount > i64::MAX as u128 {
                return Err(ContractError::Overflow);
            }
            let rc = unsafe {
                imports::kovanica_transfer(
                    from.as_ptr() as i32,
                    from.len() as i32,
                    to.as_ptr() as i32,
                    to.len() as i32,
                    amount as i64,
                )
            };
            if rc == 0 {
                Ok(())
            } else {
                Err(ContractError::InsufficientBalance)
            }
        }

        fn storage_get(&self, key: &[u8]) -> Option<Vec<u8>> {
            let needed = unsafe {
                imports::kovanica_storage_get(key.as_ptr() as i32, key.len() as i32, 0, 0)
            };
            if needed <= 0 {
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            let got = unsafe {
                imports::kovanica_storage_get(
                    key.as_ptr() as i32,
                    key.len() as i32,
                    buf.as_mut_ptr() as i32,
                    needed,
                )
            };
            if got < 0 {
                return None;
            }
            buf.truncate(got as usize);
            Some(buf)
        }

        fn storage_set(&mut self, key: &[u8], value: &[u8]) {
            let _ = unsafe {
                imports::kovanica_storage_set(
                    key.as_ptr() as i32,
                    key.len() as i32,
                    value.as_ptr() as i32,
                    value.len() as i32,
                )
            };
        }

        fn emit_event(&mut self, topic: &[u8], data: &[u8]) {
            unsafe {
                imports::kovanica_emit_event(
                    topic.as_ptr() as i32,
                    topic.len() as i32,
                    data.as_ptr() as i32,
                    data.len() as i32,
                );
            }
        }

        fn call_contract(
            &mut self,
            target: &Address,
            method: &str,
            args: &[u8],
            value: Amount,
        ) -> ContractResult<Vec<u8>> {
            if value > i64::MAX as u128 {
                return Err(ContractError::Overflow);
            }
            let rc = unsafe {
                imports::kovanica_call_contract(
                    target.as_ptr() as i32,
                    method.as_ptr() as i32,
                    method.len() as i32,
                    args.as_ptr() as i32,
                    args.len() as i32,
                    value as i64,
                )
            };
            if rc >= 0 {
                Ok(Vec::new())
            } else {
                Err(ContractError::Custom(rc.unsigned_abs()))
            }
        }
    }
}

/// Recorded CPI call for unit-test verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCpi {
    pub target: Address,
    pub method: String,
    pub args: Vec<u8>,
    pub value: Amount,
}

/// In-memory host for native Rust unit tests.
pub struct MockAmmHost {
    pub caller: Address,
    pub contract: Address,
    pub value: Amount,
    pub depth: u8,
    pub native_balances: BTreeMap<Address, Amount>,
    pub storage: BTreeMap<Vec<u8>, Vec<u8>>,
    pub events: Vec<(Vec<u8>, Vec<u8>)>,
    pub cpi_calls: Vec<RecordedCpi>,
    pub fail_next_cpi: bool,
    pub reentrant_hook: Option<Box<dyn FnMut(&mut MockAmmHost) -> ContractResult<()>>>,
}

impl MockAmmHost {
    pub fn new(caller: Address, contract: Address) -> Self {
        Self {
            caller,
            contract,
            value: 0,
            depth: 0,
            native_balances: BTreeMap::new(),
            storage: BTreeMap::new(),
            events: Vec::new(),
            cpi_calls: Vec::new(),
            fail_next_cpi: false,
            reentrant_hook: None,
        }
    }
}

impl Host for MockAmmHost {
    fn caller(&self) -> Address {
        self.caller
    }

    fn contract_address(&self) -> Address {
        self.contract
    }

    fn call_value(&self) -> Amount {
        self.value
    }

    fn cpi_depth(&self) -> u8 {
        self.depth
    }

    fn transfer(&mut self, from: &Address, to: &Address, amount: Amount) -> ContractResult<()> {
        let from_bal = self.native_balances.get(from).copied().unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }
        self.native_balances.insert(*from, from_bal - amount);
        let to_bal = self.native_balances.get(to).copied().unwrap_or(0);
        let next = to_bal.checked_add(amount).ok_or(ContractError::Overflow)?;
        self.native_balances.insert(*to, next);
        Ok(())
    }

    fn storage_get(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.storage.get(key).cloned()
    }

    fn storage_set(&mut self, key: &[u8], value: &[u8]) {
        self.storage.insert(key.to_vec(), value.to_vec());
    }

    fn emit_event(&mut self, topic: &[u8], data: &[u8]) {
        self.events.push((topic.to_vec(), data.to_vec()));
    }

    fn call_contract(
        &mut self,
        target: &Address,
        method: &str,
        args: &[u8],
        value: Amount,
    ) -> ContractResult<Vec<u8>> {
        if self.depth >= MAX_CPI_DEPTH {
            return Err(ContractError::CpiDepthExceeded);
        }
        if self.fail_next_cpi {
            self.fail_next_cpi = false;
            return Err(ContractError::InsufficientBalance);
        }
        self.cpi_calls.push(RecordedCpi {
            target: *target,
            method: method.to_string(),
            args: args.to_vec(),
            value,
        });
        if let Some(mut hook) = self.reentrant_hook.take() {
            self.depth += 1;
            let res = hook(self);
            self.depth -= 1;
            res?;
        }
        Ok(Vec::new())
    }
}
