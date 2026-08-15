//! プランクの法則。src/physics/planck.ts の移植。
//!
//! 空の色ページが使うのは `normalized_spectrum` だけ(入射スペクトル F₀(λ))。
//! 三刺激値まわり (blackbody_xyz / luminous_efficacy) は黒体放射ページ専用なので
//! 移植していない。

use std::f64::consts::PI;

/// プランク定数 h [J·s]。SI 定義値。
pub const PLANCK_CONSTANT: f64 = 6.62607015e-34;
/// 真空中の光速 c [m/s]。SI 定義値。
pub const SPEED_OF_LIGHT: f64 = 299792458.0;
/// ボルツマン定数 k [J/K]。SI 定義値。
pub const BOLTZMANN_CONSTANT: f64 = 1.380649e-23;

/// 第一放射定数(分光放射輝度用) c₁L = 2hc² [W·m²·sr⁻¹]。
fn c1l() -> f64 {
    2.0 * PLANCK_CONSTANT * SPEED_OF_LIGHT.powi(2)
}

/// 第二放射定数 c₂ = hc/k [m·K]。
fn c2() -> f64 {
    (PLANCK_CONSTANT * SPEED_OF_LIGHT) / BOLTZMANN_CONSTANT
}

/// シュテファン・ボルツマン定数 σ = 2π⁵k⁴/(15h³c²) [W·m⁻²·K⁻⁴]。
pub fn stefan_boltzmann() -> f64 {
    (2.0 * PI.powi(5) * BOLTZMANN_CONSTANT.powi(4))
        / (15.0 * PLANCK_CONSTANT.powi(3) * SPEED_OF_LIGHT.powi(2))
}

/// 分光放射輝度 B_λ(λ, T) [W·sr⁻¹·m⁻²·nm⁻¹]。
///
/// `exp_m1` を使うのは長波長側のため。x が小さいとき exp(x) − 1 は桁落ちして
/// レイリー・ジーンズ極限が出なくなる。短波長・低温では x が数万に達して
/// `exp_m1` が inf を返すが、有限値 / inf は 0 になるので NaN にはならない。
pub fn spectral_radiance(lambda_nm: f64, temperature_k: f64) -> f64 {
    if !(lambda_nm > 0.0) || !(temperature_k > 0.0) {
        return 0.0;
    }

    let lambda = lambda_nm * 1e-9;
    let x = c2() / (lambda * temperature_k);

    c1l() / (lambda.powi(5) * x.exp_m1()) / 1e9
}

/// 放射発散度 M = σT⁴ [W/m²]。
pub fn radiant_exitance(temperature_k: f64) -> f64 {
    stefan_boltzmann() * temperature_k.powi(4)
}

/// 全波長にわたる放射輝度 ∫B_λ dλ = σT⁴/π [W·sr⁻¹·m⁻²]。
pub fn total_radiance(temperature_k: f64) -> f64 {
    radiant_exitance(temperature_k) / PI
}

/// 全波長の積分が 1 になるよう正規化した分光分布 [nm⁻¹]。
///
/// 総量は解析的に分かっている (σT⁴/π) ので数値積分は要らない。
pub fn normalized_spectrum(lambda_nm: f64, temperature_k: f64) -> f64 {
    spectral_radiance(lambda_nm, temperature_k) / total_radiance(temperature_k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn シュテファンボルツマン定数が文献値と一致する() {
        let sigma = stefan_boltzmann();
        assert!((sigma - 5.670374419e-8).abs() / 5.670374419e-8 < 1e-9);
    }

    /// 正規化の定義そのもの。∫B̂ dλ = 1 を数値積分で確かめる。
    /// 可視域だけでは足りないので、赤外まで含めた広い範囲を細かく刻む。
    #[test]
    fn 正規化した分布の全積分が1になる() {
        for temperature in [2000.0, 5778.0, 20000.0] {
            let step = 1.0;
            let mut total = 0.0;
            let mut lambda = 1.0;
            while lambda <= 60_000.0 {
                total += normalized_spectrum(lambda, temperature) * step;
                lambda += step;
            }
            assert!(
                (total - 1.0).abs() < 2e-3,
                "T = {temperature}, ∫ = {total}"
            );
        }
    }

    /// ウィーンの変位則 λmax ≈ 2.898e6 / T [nm] の位置にピークが来る。
    #[test]
    fn ピーク波長がウィーンの変位則に従う() {
        for temperature in [3000.0, 5778.0, 10000.0] {
            let expected = 2.897771955e6 / temperature;
            let mut peak_lambda = 1.0;
            let mut peak_value = 0.0;
            let mut lambda = 1.0;
            while lambda <= 10_000.0 {
                let value = spectral_radiance(lambda, temperature);
                if value > peak_value {
                    peak_value = value;
                    peak_lambda = lambda;
                }
                lambda += 0.5;
            }
            assert!(
                (peak_lambda - expected).abs() / expected < 1e-3,
                "T = {temperature}, peak = {peak_lambda}, expected = {expected}"
            );
        }
    }

    /// 長波長側でレイリー・ジーンズ極限 2ckT/λ⁴ に漸近する(expm1 を使う理由)。
    ///
    /// レイリー・ジーンズは展開の最低次でしかなく、残差は x/2 = hc/(2λkT) の
    /// オーダーで残る。そこで「ある波長で十分近い」ことではなく「波長を 10 倍
    /// すれば残差が 1/10 になる」ことを見る — 極限であることの主張としては
    /// こちらが強い(TypeScript 側の同じテストと揃えてある)。
    #[test]
    fn 長波長でレイリージーンズ極限に漸近する() {
        let temperature: f64 = 5778.0;
        let rayleigh_jeans = |lambda_nm: f64| -> f64 {
            let lambda = lambda_nm * 1e-9;
            2.0 * SPEED_OF_LIGHT * BOLTZMANN_CONSTANT * temperature / lambda.powi(4) * 1e-9
        };

        let deviations: Vec<f64> = [1e6, 1e7, 1e8]
            .iter()
            .map(|&nm| (spectral_radiance(nm, temperature) / rayleigh_jeans(nm) - 1.0).abs())
            .collect();

        for i in 1..deviations.len() {
            let ratio = deviations[i - 1] / deviations[i];
            assert!((ratio - 10.0).abs() < 0.5, "{i} 段目: ratio = {ratio}");
        }
        assert!(*deviations.last().unwrap() < 1e-4);
    }

    #[test]
    fn 不正な入力では0を返す() {
        assert_eq!(spectral_radiance(0.0, 5778.0), 0.0);
        assert_eq!(spectral_radiance(-1.0, 5778.0), 0.0);
        assert_eq!(spectral_radiance(550.0, 0.0), 0.0);
        assert_eq!(spectral_radiance(f64::NAN, 5778.0), 0.0);
    }

    /// 短波長・低温で x が巨大になっても NaN を出さない。
    #[test]
    fn 極端な条件でも有限にとどまる() {
        for temperature in [10.0, 100.0, 1000.0] {
            let value = spectral_radiance(380.0, temperature);
            assert!(value.is_finite(), "T = {temperature}");
            assert!(value >= 0.0);
        }
    }
}
