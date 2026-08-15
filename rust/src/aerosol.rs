//! エアロゾル(Mie 散乱)。src/physics/aerosol.ts の移植。
//!
//! レイリー散乱は前方と後方が等しく、波長の −4 乗で効いた。エアロゾルはどちらも違う:
//! 強く前方に偏り(g = 0.76 で前方 30.6、後方 0.078)、波長依存は弱い(α ≈ 1.3)。

/// Ångström 指数 α。大陸性エアロゾルの代表値。
pub const ANGSTROM_EXPONENT: f64 = 1.3;

/// Henyey–Greenstein の非対称因子 g = ⟨cosΘ⟩。
pub const AEROSOL_ASYMMETRY: f64 = 0.76;

/// 光学的厚さを指定する基準波長 [nm]。
pub const AEROSOL_REFERENCE_LAMBDA_NM: f64 = 550.0;

/// Ångström の式による光学的厚さ τ_a(λ) = τ_a(550)·(λ/550)^−α。
///
/// ガードを `!(x > 0.0)` と書くのは TypeScript 側と揃えるため。NaN が来たときに
/// 素通しせず 0 を返す。
pub fn aerosol_optical_depth(
    lambda_nm: f64,
    optical_depth_550: f64,
    angstrom_exponent: f64,
) -> f64 {
    if !(optical_depth_550 > 0.0) || !(lambda_nm > 0.0) {
        return 0.0;
    }
    optical_depth_550 * (lambda_nm / AEROSOL_REFERENCE_LAMBDA_NM).powf(-angstrom_exponent)
}

/// Henyey–Greenstein 位相関数 P(Θ) = (1 − g²)/(1 + g² − 2g·cosΘ)^{3/2}。
///
/// ∫P dΩ/4π = 1 に規格化されている。指数 3/2 は `powf(1.5)` ではなく
/// `d * sqrt(d)` と書く — TypeScript 側がそう書いており、丸めを揃えるため。
pub fn henyey_greenstein(cos_theta: f64, g: f64) -> f64 {
    let denominator = 1.0 + g * g - 2.0 * g * cos_theta;
    (1.0 - g * g) / (denominator * denominator.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 光学的厚さは基準波長でそのままの値になる() {
        let tau = aerosol_optical_depth(550.0, 0.1, ANGSTROM_EXPONENT);
        assert!((tau - 0.1).abs() < 1e-15);
    }

    #[test]
    fn 短波長ほど光学的厚さが大きい() {
        let blue = aerosol_optical_depth(400.0, 0.1, ANGSTROM_EXPONENT);
        let red = aerosol_optical_depth(700.0, 0.1, ANGSTROM_EXPONENT);
        assert!(blue > red);
        // (700/400)^1.3 = 2.07。レイリーの λ⁻⁴ なら (700/400)^4 = 9.4 なので、
        // 波長依存がずっと緩やかなことがここに出る。
        assert!((blue / red - 2.07).abs() < 0.01, "ratio = {}", blue / red);
    }

    #[test]
    fn 量が0か波長が不正なら0を返す() {
        assert_eq!(aerosol_optical_depth(550.0, 0.0, ANGSTROM_EXPONENT), 0.0);
        assert_eq!(aerosol_optical_depth(550.0, -1.0, ANGSTROM_EXPONENT), 0.0);
        assert_eq!(aerosol_optical_depth(0.0, 0.1, ANGSTROM_EXPONENT), 0.0);
        assert_eq!(aerosol_optical_depth(f64::NAN, 0.1, ANGSTROM_EXPONENT), 0.0);
    }

    /// 前方に強く偏ることがこの位相関数の存在理由。
    #[test]
    fn 前方散乱が後方散乱を圧倒する() {
        let forward = henyey_greenstein(1.0, AEROSOL_ASYMMETRY);
        let backward = henyey_greenstein(-1.0, AEROSOL_ASYMMETRY);
        assert!((forward - 30.6).abs() < 0.1, "forward = {forward}");
        assert!((backward - 0.078).abs() < 0.001, "backward = {backward}");
        assert!(forward / backward > 300.0);
    }

    /// ∫P dΩ/4π = 1。cosΘ について中点則で積分する(dΩ/4π = d(cosΘ)/2)。
    #[test]
    fn 位相関数が規格化されている() {
        let steps = 2_000_000;
        let mut total = 0.0;
        for i in 0..steps {
            let mu = -1.0 + 2.0 * (i as f64 + 0.5) / steps as f64;
            total += henyey_greenstein(mu, AEROSOL_ASYMMETRY);
        }
        let integral = total / steps as f64;
        assert!((integral - 1.0).abs() < 1e-4, "integral = {integral}");
    }

    /// g = 0 なら等方散乱に潰れる。
    #[test]
    fn 非対称因子が0なら等方になる() {
        for mu in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            assert!((henyey_greenstein(mu, 0.0) - 1.0).abs() < 1e-15);
        }
    }
}
