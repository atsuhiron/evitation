//! 空の色シミュレータの数値核。
//!
//! src/physics/ の TypeScript 実装の移植で、**あちらが正**。ここは速さのための
//! 再実装であり、`src/physics/sky-wasm.test.ts` が両者の一致を固定している。
//!
//! 移植したのは空の色ページの重い経路だけ。他のシミュレータは数 ms で描けるので
//! TypeScript のまま。

pub mod aerosol;
pub mod air_mass;
pub mod atmosphere;
pub mod cie1931;
pub mod cie1931_data;
pub mod planck;
pub mod rayleigh;
pub mod sky;

use wasm_bindgen::prelude::*;

/// JavaScript から見える唯一のハンドル。
///
/// **これがクレート唯一の `#[wasm_bindgen] pub struct`。**ほかは `f64` と
/// `Vec<f64>` でしか渡さないので、手動で解放が要るものがこの 1 つに閉じる。
/// 呼ぶ側は描画のたびに作り直すので、**作り直す前に必ず `free()` すること**。
///
/// 返り値の `Vec<f64>` は wasm-bindgen が JavaScript 側の `Float64Array` へ
/// コピーする。線形メモリへのビューを渡さないのは、アロケータがメモリを
/// 伸ばした瞬間にビューが detach されるため。
#[wasm_bindgen]
pub struct SkyModel {
    core: sky::SkyModelCore,
}

#[wasm_bindgen]
impl SkyModel {
    #[wasm_bindgen(constructor)]
    pub fn new(
        sun_altitude_deg: f64,
        temperature_k: f64,
        multiple_scattering: bool,
        aerosol_optical_depth: f64,
    ) -> SkyModel {
        SkyModel {
            core: sky::SkyModelCore::new(sky::SkyConditions {
                sun_altitude_deg,
                temperature_k,
                multiple_scattering,
                aerosol_optical_depth,
            }),
        }
    }

    /// 角度の配列 → 3N の三刺激値。帯の全方向をこれ 1 回で解く。
    #[wasm_bindgen(js_name = xyzMany)]
    pub fn xyz_many(&mut self, angles: &[f64]) -> Vec<f64> {
        self.core.xyz_many(angles)
    }

    /// 単発の三刺激値(長さ 3)。
    #[wasm_bindgen(js_name = xyzAt)]
    pub fn xyz_at(&mut self, angle_deg: f64) -> Vec<f64> {
        self.core.xyz_at(angle_deg).to_vec()
    }

    /// 380–780nm を 1nm 刻みで並べた 401 点の分光放射輝度。
    #[wasm_bindgen(js_name = spectrumTable)]
    pub fn spectrum_table(&mut self, angle_deg: f64) -> Vec<f64> {
        self.core.spectrum_table(angle_deg)
    }

    /// 天頂で、輝度 Y のうち多重散乱が占める割合 (0..1)。
    #[wasm_bindgen(js_name = multipleScatteringShare)]
    pub fn multiple_scattering_share(&mut self) -> f64 {
        self.core.multiple_scattering_share()
    }
}
