//! Overflow-safe 256-bit unsigned integer arithmetic for constant-product AMM math.

use crate::host::{ContractError, ContractResult};

/// Minimal unsigned 256-bit integer `(lo, hi)` for exact `mul_div` and `isqrt` without overflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl U256 {
    pub const ZERO: Self = Self { hi: 0, lo: 0 };

    pub const fn from_u128(v: u128) -> Self {
        Self { hi: 0, lo: v }
    }

    pub fn is_zero(&self) -> bool {
        self.hi == 0 && self.lo == 0
    }

    /// Exact 128x128 -> 256-bit multiplication.
    pub fn mul_u128(a: u128, b: u128) -> Self {
        let a_lo = a & 0xFFFF_FFFF_FFFF_FFFF;
        let a_hi = a >> 64;
        let b_lo = b & 0xFFFF_FFFF_FFFF_FFFF;
        let b_hi = b >> 64;

        let p0 = a_lo * b_lo;
        let p1 = a_lo * b_hi;
        let p2 = a_hi * b_lo;
        let p3 = a_hi * b_hi;

        let mid = (p0 >> 64) + (p1 & 0xFFFF_FFFF_FFFF_FFFF) + (p2 & 0xFFFF_FFFF_FFFF_FFFF);
        let lo = (p0 & 0xFFFF_FFFF_FFFF_FFFF) | (mid << 64);
        let hi = p3 + (p1 >> 64) + (p2 >> 64) + (mid >> 64);
        Self { hi, lo }
    }

    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        let (lo, carry) = self.lo.overflowing_add(rhs.lo);
        let hi = self.hi.checked_add(rhs.hi)?.checked_add(u128::from(carry))?;
        Some(Self { hi, lo })
    }

    pub fn shl1(self) -> Self {
        Self {
            hi: (self.hi << 1) | (self.lo >> 127),
            lo: self.lo << 1,
        }
    }

    pub fn shr1(self) -> Self {
        Self {
            hi: self.hi >> 1,
            lo: (self.lo >> 1) | (self.hi << 127),
        }
    }

    pub fn bit(&self, idx: u32) -> bool {
        if idx < 128 {
            ((self.lo >> idx) & 1) == 1
        } else {
            ((self.hi >> (idx - 128)) & 1) == 1
        }
    }

    pub fn set_bit(&mut self, idx: u32) {
        if idx < 128 {
            self.lo |= 1u128 << idx;
        } else {
            self.hi |= 1u128 << (idx - 128);
        }
    }

    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        let (lo, borrow) = self.lo.overflowing_sub(rhs.lo);
        let hi = self.hi.checked_sub(rhs.hi)?.checked_sub(u128::from(borrow))?;
        Some(Self { hi, lo })
    }

    /// Exact binary long division `self / divisor`.
    pub fn checked_div(self, divisor: Self) -> Option<Self> {
        if divisor.is_zero() {
            return None;
        }
        let mut q = Self::ZERO;
        let mut r = Self::ZERO;
        for i in (0..256).rev() {
            r = r.shl1();
            if self.bit(i) {
                r.lo |= 1;
            }
            if r >= divisor {
                r = r.checked_sub(divisor)?;
                q.set_bit(i);
            }
        }
        Some(q)
    }

    pub fn to_u128(self) -> ContractResult<u128> {
        if self.hi != 0 {
            Err(ContractError::Overflow)
        } else {
            Ok(self.lo)
        }
    }
}

/// Computes `floor((a * b) / denom)` using full 256-bit intermediate precision.
pub fn mul_div(a: u128, b: u128, denom: u128) -> ContractResult<u128> {
    if denom == 0 {
        return Err(ContractError::InvalidInput);
    }
    let prod = U256::mul_u128(a, b);
    let q = prod
        .checked_div(U256::from_u128(denom))
        .ok_or(ContractError::Overflow)?;
    q.to_u128()
}

/// Computes `floor(sqrt(a * b))` using exact 256-bit integer square root (binary search).
pub fn isqrt_product(a: u128, b: u128) -> u128 {
    let n = U256::mul_u128(a, b);
    if n.is_zero() {
        return 0;
    }
    let mut low: u128 = 0;
    let mut high: u128 = u128::MAX;
    while low < high {
        let diff = high - low;
        let mid = low + (diff >> 1) + (diff & 1);
        let sq = U256::mul_u128(mid, mid);
        if sq <= n {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    low
}
