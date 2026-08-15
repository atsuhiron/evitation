//! 大気によるレイリー散乱。src/physics/rayleigh.ts の移植。
//!
//! τ(λ) を当てはめ式でベタ書きせず、分子 1 個の散乱断面積から積み上げる
//! (Bodhaine et al. 1999)。550nm で σ = 4.51e-31 m²、τ ≈ 0.097。

use std::f64::consts::PI;

/// 標準大気圧 [Pa]。
pub const STANDARD_PRESSURE_PA: f64 = 101325.0;
/// アボガドロ定数 [mol⁻¹]。SI 定義値。
pub const AVOGADRO: f64 = 6.02214076e23;
/// 標準重力加速度 [m/s²]。SI 定義値。
pub const STANDARD_GRAVITY: f64 = 9.80665;
/// CO₂ 濃度 [ppm]。Bodhaine が基準に採った値。
pub const CO2_PPM: f64 = 360.0;
/// 標準状態での分子数密度 N_s [m⁻³] (288.15K, 1013.25hPa)。
pub const MOLECULAR_DENSITY_STD: f64 = 2.546899e25;

/// 乾燥空気の平均モル質量 [kg/mol]。CO₂ の割合から導出する。
fn mean_molar_mass_air() -> f64 {
    let co2 = CO2_PPM * 1e-4; // ppm → 体積百分率
    (28.0134 * 78.084 + 31.9988 * 20.946 + 39.948 * 0.934 + 44.00995 * co2)
        / (78.084 + 20.946 + 0.934 + co2)
        / 1000.0
}

/// 大気全体を鉛直に貫く分子数 [m⁻²]。N = P·A/(m_air·g)。
///
/// 静水圧平衡そのもので、地表の気圧は真上にある空気の重さに等しい。だから
/// 大気の温度分布も高度分布も知らずに、気圧だけから分子数が決まる。
pub fn column_density() -> f64 {
    (STANDARD_PRESSURE_PA * AVOGADRO) / (mean_molar_mass_air() * STANDARD_GRAVITY)
}

/// 標準乾燥空気の屈折率 n(λ)。Peck & Reeder (1972) + CO₂ 補正。550nm で 1.000278。
pub fn refractive_index(lambda_nm: f64) -> f64 {
    let sigma = 1000.0 / lambda_nm;
    let inverse_square = sigma * sigma; // σ² [µm⁻²]
    let excess = (8060.51 + 2480990.0 / (132.274 - inverse_square)
        + 17455.7 / (39.32957 - inverse_square))
        * 1e-8;

    // Bodhaine eq.(6)。基準組成 300ppm からのずれの分だけ屈折率が増える。
    let co2_correction = 1.0 + 0.54 * (CO2_PPM * 1e-6 - 0.0003);
    1.0 + excess * co2_correction
}

/// キング補正係数 F(λ)。550nm で ≈ 1.048。
///
/// 空気の分子が球対称でないぶんの補正で、**4% あるので無視できない**。
pub fn king_factor(lambda_nm: f64) -> f64 {
    let sigma = 1000.0 / lambda_nm;
    let inverse_square = sigma * sigma; // σ² [µm⁻²]
    let nitrogen = 1.034 + 3.17e-4 * inverse_square;
    let oxygen = 1.096 + 1.385e-3 * inverse_square + 1.448e-4 * inverse_square * inverse_square;
    let argon = 1.0;
    let carbon_dioxide = 1.15;

    let co2 = CO2_PPM * 1e-4; // ppm → 体積百分率
    (78.084 * nitrogen + 20.946 * oxygen + 0.934 * argon + co2 * carbon_dioxide)
        / (78.084 + 20.946 + 0.934 + co2)
}

/// 分子 1 個あたりのレイリー散乱断面積 σ(λ) [m²]。
///
///   σ = 24π³(n² − 1)² / (λ⁴ N²(n² + 2)²) · F(λ)
pub fn scattering_cross_section(lambda_nm: f64) -> f64 {
    if !(lambda_nm > 0.0) {
        return 0.0;
    }

    let lambda = lambda_nm * 1e-9;
    let n = refractive_index(lambda_nm);
    let n_squared = n * n;
    let density = MOLECULAR_DENSITY_STD;

    (24.0 * PI.powi(3) * (n_squared - 1.0).powi(2))
        / (lambda.powi(4) * density.powi(2) * (n_squared + 2.0).powi(2))
        * king_factor(lambda_nm)
}

/// 海面から大気圏外までのレイリー光学的厚さ τ_R(λ)。550nm で ≈ 0.097。
pub fn optical_depth(lambda_nm: f64) -> f64 {
    scattering_cross_section(lambda_nm) * column_density()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// この分野で最も広く引かれている値(Bodhaine et al. 1999)。屈折率の分散式・
    /// キング補正係数・断面積の式の 3 つを一度に検証できる 1 点。
    #[test]
    fn 断面積が550nmで文献値と一致する() {
        // 4.51e-27 cm² = 4.51e-31 m²
        let sigma = scattering_cross_section(550.0);
        assert!(
            (sigma - 4.51e-31).abs() / 4.51e-31 < 0.005,
            "sigma = {sigma:e}"
        );
    }

    #[test]
    fn 屈折率が550nmで文献値と一致する() {
        let n = refractive_index(550.0);
        assert!((n - 1.0002778).abs() < 1e-7, "n = {n}");
    }

    #[test]
    fn キング因子は4パーセントほどある() {
        let f = king_factor(550.0);
        assert!((f - 1.048).abs() < 0.002, "F = {f}");
    }

    #[test]
    fn 光学的厚さが550nmで文献値と一致する() {
        let tau = optical_depth(550.0);
        assert!((tau - 0.097).abs() / 0.097 < 0.01, "tau = {tau}");
    }

    /// カラム密度は気圧だけから決まる量。
    #[test]
    fn カラム密度が想定の桁に収まる() {
        let n = column_density();
        assert!((n - 2.148e29).abs() / 2.148e29 < 0.01, "N = {n:e}");
    }

    /// 導出すると副産物が出る。可視域の実効的なべきは 4 ちょうどではない。
    #[test]
    fn 実効的なべきは4より少し大きい() {
        let effective = |a: f64, b: f64| -> f64 {
            -(optical_depth(b) / optical_depth(a)).ln() / (b / a).ln()
        };
        let mid = effective(545.0, 555.0);
        assert!((4.0..4.2).contains(&mid), "exponent = {mid}");
        // 短波長ほど急。
        assert!(effective(375.0, 385.0) > effective(775.0, 785.0));
    }

    #[test]
    fn 波長が不正なら断面積は0() {
        assert_eq!(scattering_cross_section(0.0), 0.0);
        assert_eq!(scattering_cross_section(-1.0), 0.0);
        assert_eq!(scattering_cross_section(f64::NAN), 0.0);
    }

    #[test]
    fn 光学的厚さは波長について単調減少() {
        let mut previous = f64::INFINITY;
        let mut lambda = 380.0;
        while lambda <= 780.0 {
            let tau = optical_depth(lambda);
            assert!(tau < previous, "λ = {lambda}");
            previous = tau;
            lambda += 5.0;
        }
    }
}
