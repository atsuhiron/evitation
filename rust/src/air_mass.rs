//! air mass。src/physics/air-mass.ts の移植。
//!
//! 空の色ページの本筋(球殻の行進)では使わない。平行平面の参照実装が使うだけで、
//! それは球殻マーチャが R → ∞ でその解に収束することを確かめるために残してある。

/// 天頂角から air mass を求める(Kasten & Young 1989 の経験式)。
///
///   m = 1 / (cos z + 0.50572 (96.07995 − z)^−1.6364)
///
/// 単純な 1/cos z は地平線で発散してしまう。
pub fn air_mass_at_zenith_angle(zenith_deg: f64) -> f64 {
    let radians = zenith_deg * std::f64::consts::PI / 180.0;
    1.0 / (radians.cos() + 0.50572 * (96.07995 - zenith_deg).powf(-1.6364))
}

/// 太陽が地平線にあるときの値 ≈ 37.92。
pub fn horizon_air_mass() -> f64 {
    air_mass_at_zenith_angle(90.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 天頂では1になる() {
        assert!((air_mass_at_zenith_angle(0.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn 地平線でも有限にとどまる() {
        let m = horizon_air_mass();
        assert!((m - 37.92).abs() < 0.05, "m = {m}");
    }

    /// 天頂角が小さいうちは 1/cos z によく一致する。
    #[test]
    fn 小さい天頂角では1割るcosに一致する() {
        for zenith in [0.0, 15.0, 30.0, 45.0, 60.0] {
            let expected = 1.0 / (zenith * std::f64::consts::PI / 180.0).cos();
            let actual = air_mass_at_zenith_angle(zenith);
            assert!((actual - expected).abs() / expected < 5e-3, "z = {zenith}");
        }
    }

    #[test]
    fn 天頂角について単調増加() {
        let mut previous = 0.0;
        let mut zenith = 0.0;
        while zenith <= 90.0 {
            let m = air_mass_at_zenith_angle(zenith);
            assert!(m > previous, "z = {zenith}");
            previous = m;
            zenith += 1.0;
        }
    }
}
