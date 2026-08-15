//! CIE 1931 等色関数と分光積分。src/color/cie1931.ts の該当部分の移植。
//!
//! **これを Rust 側に持ってくるのが移植の要。**分光積分を JavaScript に残すと、
//! 81 波長のコールバックが 1 描画で約 29,000 回境界を跨ぐことになり、
//! 移植の意味がなくなる。

use crate::cie1931_data::{CMF_DATA, CMF_LAMBDA_MAX, CMF_LAMBDA_MIN, CMF_SAMPLE_COUNT};

/// 等色関数 x̄(λ), ȳ(λ), z̄(λ)。1nm 刻みの表を線形補間する。
///
/// 範囲外は [0, 0, 0]。TypeScript 版と同じ扱い。
pub fn cmf_at(lambda_nm: f64) -> [f64; 3] {
    if !(lambda_nm >= CMF_LAMBDA_MIN) || lambda_nm > CMF_LAMBDA_MAX {
        return [0.0, 0.0, 0.0];
    }

    let position = lambda_nm - CMF_LAMBDA_MIN;
    let index = position.floor() as usize;
    let fraction = position - index as f64;

    let base = index * 3;
    let lower = [CMF_DATA[base], CMF_DATA[base + 1], CMF_DATA[base + 2]];
    if fraction == 0.0 || index + 1 >= CMF_SAMPLE_COUNT {
        return lower;
    }

    let next = (index + 1) * 3;
    [
        lower[0] + (CMF_DATA[next] - lower[0]) * fraction,
        lower[1] + (CMF_DATA[next + 1] - lower[1]) * fraction,
        lower[2] + (CMF_DATA[next + 2] - lower[2]) * fraction,
    ]
}

/// 分光分布を等色関数で積分した三刺激値。台形則。
///
/// TypeScript 版と刻みの数え方まで揃えてある: `steps = floor((λmax − λmin)/step)`、
/// 端点の重み 0.5、値が厳密に 0 の点は等色関数の参照ごと飛ばす、最後に `step` を掛ける。
/// ここがずれると差分テストが通らない。
pub fn spectrum_to_xyz<F>(spectrum: F, lambda_min: f64, lambda_max: f64, step_nm: f64) -> [f64; 3]
where
    F: Fn(f64) -> f64,
{
    let mut x = 0.0;
    let mut y = 0.0;
    let mut z = 0.0;

    let steps = ((lambda_max - lambda_min) / step_nm).floor() as usize;
    for i in 0..=steps {
        let lambda = lambda_min + i as f64 * step_nm;
        let weight = if i == 0 || i == steps { 0.5 } else { 1.0 };
        let s = spectrum(lambda) * weight;
        if s == 0.0 {
            continue;
        }
        let cmf = cmf_at(lambda);
        x += s * cmf[0];
        y += s * cmf[1];
        z += s * cmf[2];
    }

    [x * step_nm, y * step_nm, z * step_nm]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 範囲外では0を返す() {
        assert_eq!(cmf_at(359.0), [0.0, 0.0, 0.0]);
        assert_eq!(cmf_at(831.0), [0.0, 0.0, 0.0]);
        assert_eq!(cmf_at(f64::NAN), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn 格子点では表の値をそのまま返す() {
        let at555 = cmf_at(555.0);
        assert_eq!(at555[1], 1.0);
        let index = (555.0 - CMF_LAMBDA_MIN) as usize * 3;
        assert_eq!(at555[0], CMF_DATA[index]);
        assert_eq!(at555[2], CMF_DATA[index + 2]);
    }

    #[test]
    fn 格子の中間では線形補間になる() {
        let lower = cmf_at(500.0);
        let upper = cmf_at(501.0);
        let middle = cmf_at(500.5);
        for i in 0..3 {
            assert!((middle[i] - (lower[i] + upper[i]) / 2.0).abs() < 1e-15);
        }
    }

    /// 等エネルギー白(標準イルミナント E)の色度は x = y = 1/3。
    /// これは ∫x̄ = ∫ȳ = ∫z̄ という等色関数の正規化の定義そのものなので、
    /// テーブルのスケール違い・行の欠落・列の入れ替わりを一度に検出できる。
    #[test]
    fn 等エネルギー白の色度が3分の1になる() {
        let xyz = spectrum_to_xyz(|_| 1.0, CMF_LAMBDA_MIN, CMF_LAMBDA_MAX, 1.0);
        let sum = xyz[0] + xyz[1] + xyz[2];
        assert!((xyz[0] / sum - 1.0 / 3.0).abs() < 1e-4);
        assert!((xyz[1] / sum - 1.0 / 3.0).abs() < 1e-4);
    }

    /// 恒等的に 0 のスペクトルは 0 を返す(早期 continue の経路)。
    #[test]
    fn ゼロのスペクトルは0を返す() {
        assert_eq!(spectrum_to_xyz(|_| 0.0, 380.0, 780.0, 5.0), [0.0, 0.0, 0.0]);
    }

    /// 端点の重み 0.5 が効いていること。定数スペクトルなら台形則の総和は
    /// (点数 − 1) × step になる。
    #[test]
    fn 端点の重みが半分になっている() {
        // ȳ だけを見る。∫ȳ dλ を 380–780 の 5nm 刻みで台形則にかけた値。
        let xyz = spectrum_to_xyz(|_| 1.0, 380.0, 780.0, 5.0);
        let steps = 80; // floor((780 − 380)/5)
        let mut manual = 0.0;
        for i in 0..=steps {
            let lambda = 380.0 + i as f64 * 5.0;
            let weight = if i == 0 || i == steps { 0.5 } else { 1.0 };
            manual += cmf_at(lambda)[1] * weight;
        }
        assert!((xyz[1] - manual * 5.0).abs() < 1e-12);
    }
}
