//! 空の色 — 大気にばらまかれた光の放射伝達。src/physics/sky.ts の移植。
//!
//! TypeScript 実装が正で、こちらはその再現。`src/physics/sky-wasm.test.ts` が
//! 両者の一致を固定している。移植で気を配ったのは次の点:
//!
//! - `path_integral` は指数の**小さいほう**を括り出す(逆にすると地平線近くで NaN)
//! - `mu0` は `sin(h)` で作る(`cos(90−h)` は h = 0 で 6.1e-17 を返す)
//! - 位相関数は上下を別に持ち、それぞれ 32 点求積の上で規格化し直す
//! - `f64::mul_add` は使わない。FMA が入ると JavaScript と結果が食い違う

use std::f64::consts::PI;
use std::sync::OnceLock;

use crate::aerosol::{aerosol_optical_depth, henyey_greenstein, AEROSOL_ASYMMETRY};
use crate::air_mass::air_mass_at_zenith_angle;
use crate::atmosphere::{
    view_path_samples_into, AtmosphereShape, PathSamples, SUN_STEPS, VIEW_STEPS,
};
use crate::cie1931::spectrum_to_xyz;
use crate::planck::normalized_spectrum;
use crate::rayleigh::optical_depth;

const DEG: f64 = PI / 180.0;

/// 分光積分の範囲と刻み。可視域だけで足り、刻みは CIE が等色関数を表にしている
/// のと同じ 5nm。既定 (360–830nm を 1nm) と比べた 8bit の色差は最大 1。
pub const SPECTRUM_LAMBDA_MIN: f64 = 380.0;
pub const SPECTRUM_LAMBDA_MAX: f64 = 780.0;
pub const SPECTRUM_STEP_NM: f64 = 5.0;

/// 波長ごとの表を張る 1nm 格子。TypeScript 側の `SPECTRUM_TABLE_*` と同じ。
pub const TABLE_LAMBDA_MIN: i32 = 380;
pub const TABLE_LAMBDA_MAX: i32 = 780;
pub const TABLE_LENGTH: usize = (TABLE_LAMBDA_MAX - TABLE_LAMBDA_MIN) as usize + 1;

/// 半球のフラックス積分に使う節点数。
const QUADRATURE_NODES: usize = 32;
/// Henyey–Greenstein の方位角平均に使う刻み数。
const AZIMUTH_STEPS: usize = 64;
/// δ = m₀ − m_v がこれより小さければ極限の式に切り替える。
const DELTA_EPSILON: f64 = 1e-9;

#[derive(Clone, Copy, Debug)]
pub struct SkyConditions {
    pub sun_altitude_deg: f64,
    pub temperature_k: f64,
    pub multiple_scattering: bool,
    pub aerosol_optical_depth: f64,
}

// --- 幾何 ----------------------------------------------------------------------

/// 太陽の「空の角度」。天頂を 0、西を + とする符号つき角 [deg]。
pub fn sun_sky_angle_deg(sun_altitude_deg: f64) -> f64 {
    90.0 - sun_altitude_deg
}

/// 散乱角 Θ [deg]。球殻でも光路上で一定なので、方向ごとに 1 度求めれば足りる。
pub fn scattering_angle_deg(sky_angle_deg: f64, sun_altitude_deg: f64) -> f64 {
    let difference = (sky_angle_deg - sun_sky_angle_deg(sun_altitude_deg)).abs() % 360.0;
    if difference > 180.0 {
        360.0 - difference
    } else {
        difference
    }
}

/// レイリー位相関数 P(Θ) = (3/4)(1 + cos²Θ)。前後対称なので、これだけでは
/// 東西の非対称は生まれない。
pub fn rayleigh_phase(cos_theta: f64) -> f64 {
    0.75 * (1.0 + cos_theta * cos_theta)
}

/// 方位角について平均したレイリー位相関数。
///
///   ⟨P⟩(μ, μ₀) = (3/4)[1 + μ²μ₀² + ½(1−μ²)(1−μ₀²)]
pub fn azimuth_averaged_phase(mu: f64, mu0: f64) -> f64 {
    0.75 * (1.0 + mu * mu * mu0 * mu0 + 0.5 * (1.0 - mu * mu) * (1.0 - mu0 * mu0))
}

/// Henyey–Greenstein の方位角平均。閉じた形にならないので中点則で積分する。
fn azimuth_averaged_henyey_greenstein(mu: f64, mu0: f64) -> f64 {
    let cross = (1.0 - mu * mu).max(0.0).sqrt() * (1.0 - mu0 * mu0).max(0.0).sqrt();
    let mut total = 0.0;
    for i in 0..AZIMUTH_STEPS {
        let phi = (2.0 * PI * (i as f64 + 0.5)) / AZIMUTH_STEPS as f64;
        total += henyey_greenstein(mu * mu0 + cross * phi.cos(), AEROSOL_ASYMMETRY);
    }
    total / AZIMUTH_STEPS as f64
}

// --- 平行平面の閉じた形(参照用) ----------------------------------------------------

/// 光路積分の中身。
///
///   ∫₀^τ e^(−t·m₀) · e^(−(τ−t)·m_v) dt = [e^(−τ m_v) − e^(−τ m₀)]/(m₀ − m_v)
///
/// **括り出すのは指数の小さいほう(= 値の大きいほう)でなければならない。**
/// 逆にすると、視線が地平線に寄って m_v ≫ m₀ になったとき e^(−大) が 0 へ
/// アンダーフローする一方 expm1(+大) が inf になり、0 × inf = NaN が出る。
fn path_integral(tau: f64, m_view: f64, m_sun: f64) -> f64 {
    let spread = (m_sun - m_view).abs();
    if spread < DELTA_EPSILON {
        return tau * (-tau * m_view).exp();
    }
    let magnitude = -(-tau * m_view.min(m_sun)).exp() * (-tau * spread).exp_m1();
    magnitude / spread
}

/// 平行平面・単散乱の閉じた形。**ページからは使わない** — 球殻の行進が
/// R → ∞ でこれに収束することを確かめるための参照実装。
pub fn plane_parallel_radiance_with_air_mass(
    lambda_nm: f64,
    cos_theta: f64,
    m_view: f64,
    m_sun: f64,
    temperature_k: f64,
) -> f64 {
    let tau = optical_depth_at(lambda_nm);
    normalized_spectrum(lambda_nm, temperature_k)
        * (rayleigh_phase(cos_theta) / (4.0 * PI))
        * m_view
        * path_integral(tau, m_view, m_sun)
}

/// 上の Kasten–Young 版。
pub fn plane_parallel_radiance(
    lambda_nm: f64,
    sky_angle_deg: f64,
    sun_altitude_deg: f64,
    temperature_k: f64,
) -> f64 {
    plane_parallel_radiance_with_air_mass(
        lambda_nm,
        (scattering_angle_deg(sky_angle_deg, sun_altitude_deg) * DEG).cos(),
        air_mass_at_zenith_angle(sky_angle_deg.abs()),
        air_mass_at_zenith_angle(sun_sky_angle_deg(sun_altitude_deg)),
        temperature_k,
    )
}

// --- 球殻の単散乱 ----------------------------------------------------------------

/// 行進した標本から分光放射輝度を組み立てる。**内側の最深部。**
///
///   L₁(λ) = Σ_i exp(−[τ_R·totalR_i + τ_M·totalM_i])
///              · (τ_R·P_R·dR_i + τ_M·P_M·dM_i)
///
/// 4 本の配列を並べて舐める(SoA)。添字ではなくイテレータで回すのは、
/// LLVM に境界検査を外させるため — `get_unchecked` には手を出さない。
fn radiance_from_samples(
    samples: &PathSamples,
    phase_rayleigh: f64,
    phase_aerosol: f64,
    tau_rayleigh: f64,
    tau_aerosol: f64,
) -> f64 {
    let mut total = 0.0;
    for (((d_r, d_m), t_r), t_m) in samples
        .d_rayleigh
        .iter()
        .zip(samples.d_aerosol.iter())
        .zip(samples.total_rayleigh.iter())
        .zip(samples.total_aerosol.iter())
    {
        let transmittance = (-(tau_rayleigh * t_r + tau_aerosol * t_m)).exp();
        total += transmittance * (tau_rayleigh * phase_rayleigh * d_r + tau_aerosol * phase_aerosol * d_m);
    }
    total
}

/// 球殻・単散乱の分光放射輝度。1 点だけ知りたいとき用(毎回行進するので遅い)。
#[allow(clippy::too_many_arguments)]
pub fn spherical_radiance(
    lambda_nm: f64,
    sky_angle_deg: f64,
    sun_altitude_deg: f64,
    temperature_k: f64,
    aerosol_optical_depth_550: f64,
    shape: &AtmosphereShape,
    view_steps: usize,
    sun_steps: usize,
) -> f64 {
    let cos_theta = (scattering_angle_deg(sky_angle_deg, sun_altitude_deg) * DEG).cos();
    let mut samples = PathSamples::with_capacity(view_steps);
    view_path_samples_into(
        &mut samples,
        sky_angle_deg,
        sun_altitude_deg,
        shape,
        view_steps,
        sun_steps,
    );
    normalized_spectrum(lambda_nm, temperature_k)
        * radiance_from_samples(
            &samples,
            rayleigh_phase(cos_theta) / (4.0 * PI),
            henyey_greenstein(cos_theta, AEROSOL_ASYMMETRY) / (4.0 * PI),
            optical_depth_at(lambda_nm),
            aerosol_optical_depth(
                lambda_nm,
                aerosol_optical_depth_550,
                crate::aerosol::ANGSTROM_EXPONENT,
            ),
        )
}

// --- 多重散乱 ------------------------------------------------------------------

struct Quadrature {
    nodes: [f64; QUADRATURE_NODES],
    weights: [f64; QUADRATURE_NODES],
}

/// ガウス・ルジャンドル求積の節点と重み(区間 [0, 1])。
///
/// 節点は数表を書き写さず、ルジャンドル多項式の根をニュートン法で解いて求める
/// — 出所が追えてテストで検算できる形にしたいため。
fn gauss_legendre(n: usize) -> Quadrature {
    let mut nodes = [0.0; QUADRATURE_NODES];
    let mut weights = [0.0; QUADRATURE_NODES];

    for i in 0..n {
        // 根のよい初期値(Abramowitz & Stegun の近似)。
        let mut x = ((PI * (i as f64 + 0.75)) / (n as f64 + 0.5)).cos();

        for _ in 0..100 {
            // 漸化式 (k+1)P_{k+1} = (2k+1)x·P_k − k·P_{k−1}。
            let mut previous = 1.0;
            let mut current = x;
            for k in 1..n {
                let next = ((2 * k + 1) as f64 * x * current - k as f64 * previous) / (k + 1) as f64;
                previous = current;
                current = next;
            }
            let derivative = (n as f64 * (x * current - previous)) / (x * x - 1.0);
            let step = current / derivative;
            x -= step;
            if step.abs() < 1e-15 {
                break;
            }
        }

        let mut previous = 1.0;
        let mut current = x;
        for k in 1..n {
            let next = ((2 * k + 1) as f64 * x * current - k as f64 * previous) / (k + 1) as f64;
            previous = current;
            current = next;
        }
        let derivative = (n as f64 * (x * current - previous)) / (x * x - 1.0);

        // [-1, 1] から [0, 1] へ写す。
        nodes[i] = 0.5 * (1.0 - x);
        weights[i] = 1.0 / ((1.0 - x * x) * derivative * derivative);
    }

    Quadrature { nodes, weights }
}

fn quadrature() -> &'static Quadrature {
    static QUADRATURE: OnceLock<Quadrature> = OnceLock::new();
    QUADRATURE.get_or_init(|| gauss_legendre(QUADRATURE_NODES))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScatteringBudget {
    /// 直達光から取り去られた全エネルギー (F₀ = 1 としたときの値)。
    pub removed: f64,
    /// 1 回だけ散乱されて下向きに抜けた分。
    pub first_order_down: f64,
    /// 同じく上向きに宇宙へ抜けた分。
    pub first_order_up: f64,
    /// 残り = 2 回以上散乱された光。
    pub higher_order: f64,
}

/// 太陽高度を固定して、波長ごとの収支を繰り返し解くための器。
///
/// 方位角平均した位相関数は波長に依らないので、ここで 1 度だけ作って使い回す。
/// Henyey–Greenstein の方位角平均は数値積分が要るぶん、この巻き上げが効く
/// (32 節点 × 64 方位 = 4096 回の評価が 1 回で済む)。
pub struct BudgetSolver {
    active: bool,
    mu0: f64,
    m_sun: f64,
    phase_rayleigh_down: [f64; QUADRATURE_NODES],
    phase_rayleigh_up: [f64; QUADRATURE_NODES],
    phase_aerosol_down: [f64; QUADRATURE_NODES],
    phase_aerosol_up: [f64; QUADRATURE_NODES],
    norm_rayleigh: f64,
    norm_aerosol: f64,
}

impl BudgetSolver {
    pub fn new(sun_altitude_deg: f64) -> Self {
        // cos(90 − h) ではなく sin(h) で書く。前者は h = 0 で 6.1e-17 という
        // 「ほぼ 0 だが 0 ではない」値を返し、下駄がきっちり 0 にならない。
        let mu0 = (sun_altitude_deg * DEG).sin();
        if !(mu0 > 0.0) {
            return Self {
                active: false,
                mu0: 0.0,
                m_sun: 0.0,
                phase_rayleigh_down: [0.0; QUADRATURE_NODES],
                phase_rayleigh_up: [0.0; QUADRATURE_NODES],
                phase_aerosol_down: [0.0; QUADRATURE_NODES],
                phase_aerosol_up: [0.0; QUADRATURE_NODES],
                norm_rayleigh: 1.0,
                norm_aerosol: 1.0,
            };
        }

        let q = quadrature();
        let mut phase_rayleigh_down = [0.0; QUADRATURE_NODES];
        let mut phase_rayleigh_up = [0.0; QUADRATURE_NODES];
        let mut phase_aerosol_down = [0.0; QUADRATURE_NODES];
        let mut phase_aerosol_up = [0.0; QUADRATURE_NODES];

        // 位相関数を下向き / 上向きで別々に持つ。直達光は下へ進むので、上向きに
        // 散乱される角度は cosΘ の符号が反転する。レイリーの ⟨P⟩ は μ の偶関数
        // なので上下で同じだが、**Henyey–Greenstein は偶関数ではない**ので
        // 区別しないと上へ抜ける分を大幅に過大評価し、収支の等式が破れる。
        for i in 0..QUADRATURE_NODES {
            let mu = q.nodes[i];
            phase_rayleigh_down[i] = azimuth_averaged_phase(mu, mu0);
            phase_rayleigh_up[i] = azimuth_averaged_phase(-mu, mu0);
            phase_aerosol_down[i] = azimuth_averaged_henyey_greenstein(mu, mu0);
            phase_aerosol_up[i] = azimuth_averaged_henyey_greenstein(-mu, mu0);
        }

        // 離散化した位相関数を、**この求積の上でちょうど 1 に**規格化し直す。
        // 前方に尖った Henyey–Greenstein は 32 点では解ききれず、離散版の積分が
        // 1 からずれる。ずれたまま使うと E₂₊ が負に振れうる。
        let discrete_norm = |down: &[f64; QUADRATURE_NODES], up: &[f64; QUADRATURE_NODES]| -> f64 {
            let mut total = 0.0;
            for i in 0..QUADRATURE_NODES {
                total += q.weights[i] * (down[i] + up[i]);
            }
            total / 2.0
        };

        Self {
            active: true,
            mu0,
            m_sun: 1.0 / mu0,
            norm_rayleigh: discrete_norm(&phase_rayleigh_down, &phase_rayleigh_up),
            norm_aerosol: discrete_norm(&phase_aerosol_down, &phase_aerosol_up),
            phase_rayleigh_down,
            phase_rayleigh_up,
            phase_aerosol_down,
            phase_aerosol_up,
        }
    }

    pub fn solve(&self, tau_rayleigh: f64, tau_aerosol: f64) -> ScatteringBudget {
        if !self.active {
            return ScatteringBudget::default();
        }
        let tau = tau_rayleigh + tau_aerosol;
        if !(tau > 0.0) {
            return ScatteringBudget::default();
        }

        // 2 種の位相関数を散乱寄与で重み付けして 1 本にまとめる。どちらも
        // 規格化されているので凸結合もまた規格化されたまま — 収支の等式が
        // 厳密に成り立つ条件が保たれる。
        let weight_rayleigh = tau_rayleigh / tau;
        let weight_aerosol = tau_aerosol / tau;

        let removed = self.mu0 * -(-tau * self.m_sun).exp_m1();

        let q = quadrature();
        let mut down = 0.0;
        let mut up = 0.0;
        for i in 0..QUADRATURE_NODES {
            let mu = q.nodes[i];
            let weight = q.weights[i];
            let m_view = 1.0 / mu;
            let phase_down = (weight_rayleigh * (self.phase_rayleigh_down[i] / self.norm_rayleigh)
                + weight_aerosol * (self.phase_aerosol_down[i] / self.norm_aerosol))
                / (4.0 * PI);
            let phase_up = (weight_rayleigh * (self.phase_rayleigh_up[i] / self.norm_rayleigh)
                + weight_aerosol * (self.phase_aerosol_up[i] / self.norm_aerosol))
                / (4.0 * PI);

            // 下向き: 深さ t から地面まで (τ − t) の減衰。単散乱の式と同じ形。
            down += weight * mu * phase_down * m_view * path_integral(tau, m_view, self.m_sun);

            // 上向き: 深さ t から大気圏外まで t だけ戻るので、指数の符号が揃う。
            let sum = self.m_sun + m_view;
            up += weight * mu * phase_up * (m_view / sum) * -(-tau * sum).exp_m1();
        }

        let first_order_down = 2.0 * PI * down;
        let first_order_up = 2.0 * PI * up;
        // 求積の誤差でわずかに負へ振れることがあるので下限を置く。
        let higher_order = (removed - first_order_down - first_order_up).max(0.0);

        ScatteringBudget {
            removed,
            first_order_down,
            first_order_up,
            higher_order,
        }
    }
}

/// 光子の収支。保存散乱 (ω = 1) の平行平面大気では E = E↓₁ + E↑₁ + E₂₊ が厳密に成り立つ。
pub fn scattering_budget(
    tau_rayleigh: f64,
    tau_aerosol: f64,
    sun_altitude_deg: f64,
) -> ScatteringBudget {
    BudgetSolver::new(sun_altitude_deg).solve(tau_rayleigh, tau_aerosol)
}

// --- τ(λ) のキャッシュ ------------------------------------------------------------

/// レイリーの光学的厚さは波長だけで決まり、パラメータには依存しない。
/// 1nm 格子の上に一度だけ作っておく。
fn tau_table() -> &'static [f64; TABLE_LENGTH] {
    static TAU_TABLE: OnceLock<[f64; TABLE_LENGTH]> = OnceLock::new();
    TAU_TABLE.get_or_init(|| {
        let mut table = [0.0; TABLE_LENGTH];
        for (i, slot) in table.iter_mut().enumerate() {
            *slot = optical_depth(TABLE_LAMBDA_MIN as f64 + i as f64);
        }
        table
    })
}

/// 整数かつ範囲内なら表の添字、そうでなければ `None`。
fn table_index(lambda_nm: f64) -> Option<usize> {
    if lambda_nm.fract() != 0.0 || !lambda_nm.is_finite() {
        return None;
    }
    let index = lambda_nm - TABLE_LAMBDA_MIN as f64;
    if index >= 0.0 && index < TABLE_LENGTH as f64 {
        Some(index as usize)
    } else {
        None
    }
}

fn optical_depth_at(lambda_nm: f64) -> f64 {
    match table_index(lambda_nm) {
        Some(index) => tau_table()[index],
        None => optical_depth(lambda_nm),
    }
}

// --- 状態ごとのモデル -------------------------------------------------------------

/// 状態(太陽高度・温度・散乱の次数・エアロゾル量)ごとに 1 つ作り、全方向で使い回す。
///
/// 行進の標本 `scratch` を 1 本だけ持って方向ごとに詰め直すので、**定常状態では
/// 確保が起きない**。TypeScript 版が 1 描画で 10 万個ほどの短命オブジェクトを
/// 作っていたのを消すのが、移植の速度上の主眼。
pub struct SkyModelCore {
    conditions: SkyConditions,
    aod: f64,
    shape: AtmosphereShape,
    solar: Vec<f64>,
    tau_aerosol: Vec<f64>,
    floor: Option<Vec<f64>>,
    scratch: PathSamples,
}

impl SkyModelCore {
    pub fn new(conditions: SkyConditions) -> Self {
        let aod = conditions.aerosol_optical_depth.max(0.0);

        // 入射スペクトル F₀(λ) と エアロゾルの τ(λ) は、モデルの中で固定なので
        // 表に焼く。温度も AOD も方向には依らない。
        let mut solar = vec![0.0; TABLE_LENGTH];
        let mut tau_aerosol = vec![0.0; TABLE_LENGTH];
        for i in 0..TABLE_LENGTH {
            let lambda_nm = TABLE_LAMBDA_MIN as f64 + i as f64;
            solar[i] = normalized_spectrum(lambda_nm, conditions.temperature_k);
            tau_aerosol[i] =
                aerosol_optical_depth(lambda_nm, aod, crate::aerosol::ANGSTROM_EXPONENT);
        }

        let floor = if conditions.multiple_scattering {
            let solver = BudgetSolver::new(conditions.sun_altitude_deg);
            let tau = tau_table();
            let mut table = vec![0.0; TABLE_LENGTH];
            for i in 0..TABLE_LENGTH {
                let budget = solver.solve(tau[i], tau_aerosol[i]);
                table[i] = (solar[i] * budget.higher_order) / (2.0 * PI);
            }
            Some(table)
        } else {
            None
        };

        Self {
            conditions,
            aod,
            shape: AtmosphereShape::default(),
            solar,
            tau_aerosol,
            floor,
            scratch: PathSamples::with_capacity(VIEW_STEPS),
        }
    }

    fn floor_at(&self, lambda_nm: f64) -> f64 {
        match &self.floor {
            None => 0.0,
            Some(floor) => {
                let index = lambda_nm.round() - TABLE_LAMBDA_MIN as f64;
                if index >= 0.0 && index < floor.len() as f64 {
                    floor[index as usize]
                } else {
                    0.0
                }
            }
        }
    }

    /// 指定方向について球殻を行進し、位相関数を返す。
    /// **ここで幾何を 1 度だけ解いて閉じ込める。**以降の波長ループは指数関数だけ。
    fn march(&mut self, sky_angle_deg: f64) -> (f64, f64) {
        let cos_theta =
            (scattering_angle_deg(sky_angle_deg, self.conditions.sun_altitude_deg) * DEG).cos();
        view_path_samples_into(
            &mut self.scratch,
            sky_angle_deg,
            self.conditions.sun_altitude_deg,
            &self.shape,
            VIEW_STEPS,
            SUN_STEPS,
        );
        (
            rayleigh_phase(cos_theta) / (4.0 * PI),
            henyey_greenstein(cos_theta, AEROSOL_ASYMMETRY) / (4.0 * PI),
        )
    }

    /// 行進済みの標本から、ある波長の分光放射輝度を求める。
    fn radiance(&self, lambda_nm: f64, phase_rayleigh: f64, phase_aerosol: f64) -> f64 {
        let index = table_index(lambda_nm);
        let (tau_r, tau_m, f0) = match index {
            Some(i) => (tau_table()[i], self.tau_aerosol[i], self.solar[i]),
            None => (
                optical_depth(lambda_nm),
                aerosol_optical_depth(lambda_nm, self.aod, crate::aerosol::ANGSTROM_EXPONENT),
                normalized_spectrum(lambda_nm, self.conditions.temperature_k),
            ),
        };

        let single = f0
            * radiance_from_samples(&self.scratch, phase_rayleigh, phase_aerosol, tau_r, tau_m);

        match (&self.floor, index) {
            (Some(floor), Some(i)) => single + floor[i],
            _ => single + self.floor_at(lambda_nm),
        }
    }

    /// 380–780nm を 1nm 刻みで並べた 401 点の分光放射輝度。
    pub fn spectrum_table(&mut self, sky_angle_deg: f64) -> Vec<f64> {
        let (phase_rayleigh, phase_aerosol) = self.march(sky_angle_deg);
        (0..TABLE_LENGTH)
            .map(|i| {
                self.radiance(
                    TABLE_LAMBDA_MIN as f64 + i as f64,
                    phase_rayleigh,
                    phase_aerosol,
                )
            })
            .collect()
    }

    /// その方向の三刺激値。
    pub fn xyz_at(&mut self, sky_angle_deg: f64) -> [f64; 3] {
        let (phase_rayleigh, phase_aerosol) = self.march(sky_angle_deg);
        spectrum_to_xyz(
            |lambda_nm| self.radiance(lambda_nm, phase_rayleigh, phase_aerosol),
            SPECTRUM_LAMBDA_MIN,
            SPECTRUM_LAMBDA_MAX,
            SPECTRUM_STEP_NM,
        )
    }

    /// 角度の配列 → 3N の三刺激値。帯の全方向をこれ 1 回で解く。
    pub fn xyz_many(&mut self, angles: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; angles.len() * 3];
        for (i, &angle) in angles.iter().enumerate() {
            let xyz = self.xyz_at(angle);
            out[i * 3] = xyz[0];
            out[i * 3 + 1] = xyz[1];
            out[i * 3 + 2] = xyz[2];
        }
        out
    }

    /// 天頂で、輝度 Y のうち多重散乱が占める割合 (0..1)。
    pub fn multiple_scattering_share(&mut self) -> f64 {
        if self.floor.is_none() {
            return 0.0;
        }
        let total = self.xyz_at(0.0)[1];
        if !(total > 0.0) {
            return 0.0;
        }
        let floor_xyz = spectrum_to_xyz(
            |lambda_nm| self.floor_at(lambda_nm),
            SPECTRUM_LAMBDA_MIN,
            SPECTRUM_LAMBDA_MAX,
            SPECTRUM_STEP_NM,
        );
        floor_xyz[1] / total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conditions(sun_altitude_deg: f64) -> SkyConditions {
        SkyConditions {
            sun_altitude_deg,
            temperature_k: 5778.0,
            multiple_scattering: true,
            aerosol_optical_depth: 0.1,
        }
    }

    // --- 求積 -------------------------------------------------------------------

    /// 節点をニュートン法で解いているので、低次のモーメントで検算できる。
    #[test]
    fn ガウス求積のモーメントが正しい() {
        let q = quadrature();
        let sum_w: f64 = q.weights.iter().sum();
        let sum_wx: f64 = q.nodes.iter().zip(q.weights.iter()).map(|(x, w)| w * x).sum();
        let sum_wx2: f64 = q
            .nodes
            .iter()
            .zip(q.weights.iter())
            .map(|(x, w)| w * x * x)
            .sum();
        assert!((sum_w - 1.0).abs() < 1e-14, "Σw = {sum_w}");
        assert!((sum_wx - 0.5).abs() < 1e-14, "Σwx = {sum_wx}");
        assert!((sum_wx2 - 1.0 / 3.0).abs() < 1e-14, "Σwx² = {sum_wx2}");
    }

    #[test]
    fn 求積の節点が区間の内側に並ぶ() {
        let q = quadrature();
        for i in 0..QUADRATURE_NODES {
            assert!(q.nodes[i] > 0.0 && q.nodes[i] < 1.0);
            assert!(q.weights[i] > 0.0);
        }
    }

    // --- 位相関数 ----------------------------------------------------------------

    #[test]
    fn レイリー位相関数の値が既知の3点で正しい() {
        assert!((rayleigh_phase(1.0) - 1.5).abs() < 1e-15);
        assert!((rayleigh_phase(0.0) - 0.75).abs() < 1e-15);
        assert!((rayleigh_phase(-1.0) - 1.5).abs() < 1e-15);
    }

    /// 規格化後、離散の世界でちょうど 1 になっていること。レイリーと
    /// Henyey–Greenstein の両方、複数の太陽高度で確かめる。
    #[test]
    fn 離散化した位相関数が1に規格化されている() {
        let q = quadrature();
        for altitude in [5.0, 20.0, 45.0, 89.0] {
            let solver = BudgetSolver::new(altitude);
            assert!(solver.active);
            let mut rayleigh = 0.0;
            let mut aerosol = 0.0;
            for i in 0..QUADRATURE_NODES {
                rayleigh += q.weights[i]
                    * (solver.phase_rayleigh_down[i] + solver.phase_rayleigh_up[i])
                    / solver.norm_rayleigh;
                aerosol += q.weights[i]
                    * (solver.phase_aerosol_down[i] + solver.phase_aerosol_up[i])
                    / solver.norm_aerosol;
            }
            assert!((rayleigh / 2.0 - 1.0).abs() < 1e-14, "h = {altitude}");
            assert!((aerosol / 2.0 - 1.0).abs() < 1e-14, "h = {altitude}");
        }
    }

    /// Henyey–Greenstein は μ の偶関数ではない。上下を別に持つ理由そのもの。
    #[test]
    fn 前方散乱の位相関数は上下で違う() {
        let solver = BudgetSolver::new(30.0);
        let mut differs = false;
        for i in 0..QUADRATURE_NODES {
            // レイリーは偶関数なので上下が一致する。
            assert!(
                (solver.phase_rayleigh_down[i] - solver.phase_rayleigh_up[i]).abs() < 1e-12,
                "rayleigh differs at {i}"
            );
            if (solver.phase_aerosol_down[i] - solver.phase_aerosol_up[i]).abs() > 1e-6 {
                differs = true;
            }
        }
        assert!(differs, "エアロゾルの上下が同じになっている");
    }

    // --- 収支 -------------------------------------------------------------------

    /// 保存散乱では E = E↓₁ + E↑₁ + E₂₊ が**厳密に**成り立つ。位相関数の規格化・
    /// 上下の閉形式・求積の重みをまとめて検証する 1 本。
    #[test]
    fn 収支の等式が厳密に成り立つ() {
        for altitude in [1.0, 5.0, 20.0, 45.0, 70.0, 90.0] {
            for tau_r in [0.01, 0.097, 0.4] {
                for tau_m in [0.0, 0.05, 0.5] {
                    let budget = scattering_budget(tau_r, tau_m, altitude);
                    let sum =
                        budget.first_order_down + budget.first_order_up + budget.higher_order;
                    assert!(
                        (budget.removed - sum).abs() < 1e-12,
                        "h={altitude} τR={tau_r} τM={tau_m}: {} vs {sum}",
                        budget.removed
                    );
                    assert!(budget.higher_order >= 0.0);
                }
            }
        }
    }

    /// 太陽が地平線以下では収支が閉じないので、見積もりは 0 になる。
    /// `sin(h)` で μ₀ を作っている理由が h = 0 のここ。
    #[test]
    fn 地平線以下では収支が0になる() {
        for altitude in [0.0, -0.5, -6.0, -18.0] {
            let budget = scattering_budget(0.097, 0.05, altitude);
            assert_eq!(budget, ScatteringBudget::default(), "h = {altitude}");
        }
    }

    // --- 光路積分 ----------------------------------------------------------------

    /// m₀ ≈ m_v で分岐をまたぐところが連続で、NaN も出さないこと。
    #[test]
    fn 光路積分は縮退の近くで連続() {
        let tau = 0.097;
        let m_view = 2.0;
        let mut previous = path_integral(tau, m_view, m_view);
        assert!(previous.is_finite() && previous > 0.0);
        for delta in [1e-12, 1e-10, 1e-8, 1e-6, 1e-4] {
            let value = path_integral(tau, m_view, m_view + delta);
            assert!(value.is_finite() && value > 0.0, "δ = {delta}");
            assert!(
                (value - previous).abs() / previous < 1e-3,
                "δ = {delta}: {value} vs {previous}"
            );
            previous = value;
        }
    }

    /// 括り出す順を間違えると NaN が出る場所。地平線に寄った視線。
    #[test]
    fn 地平線に寄った視線でもNaNを出さない() {
        for m_view in [10.0, 34.0, 100.0, 1000.0] {
            for tau in [0.01, 0.5, 5.0] {
                let value = path_integral(tau, m_view, 1.0);
                assert!(value.is_finite(), "m_v = {m_view}, τ = {tau}");
                assert!(value >= 0.0);
            }
        }
    }

    // --- 球殻と平行平面 -----------------------------------------------------------

    /// 球殻の行進は R → ∞ で平行平面の閉じた形に収束する。
    /// `AtmosphereShape` を差し替え可能にしてあるのはこのため。
    #[test]
    fn 半径を大きくすると平行平面の解に収束する() {
        let shape = AtmosphereShape {
            earth_radius_m: 1e13,
            ..AtmosphereShape::default()
        };
        let temperature = 5778.0;
        for sun_altitude in [30.0, 60.0] {
            for sky_angle in [-45.0, 0.0, 45.0] {
                let spherical = spherical_radiance(
                    550.0,
                    sky_angle,
                    sun_altitude,
                    temperature,
                    0.0,
                    &shape,
                    4096,
                    512,
                );
                let cos_theta = (scattering_angle_deg(sky_angle, sun_altitude) * DEG).cos();
                let plane = plane_parallel_radiance_with_air_mass(
                    550.0,
                    cos_theta,
                    1.0 / (sky_angle.abs() * DEG).cos(),
                    1.0 / (sun_sky_angle_deg(sun_altitude) * DEG).cos(),
                    temperature,
                );
                assert!(
                    (spherical - plane).abs() / plane < 5e-3,
                    "h={sun_altitude} a={sky_angle}: {spherical} vs {plane}"
                );
            }
        }
    }

    // --- モデル -----------------------------------------------------------------

    #[test]
    fn 全域で有限かつ非負にとどまる() {
        for altitude in [-18.0, -6.0, -0.5, 0.0, 0.1, 5.0, 45.0, 90.0] {
            let mut model = SkyModelCore::new(conditions(altitude));
            let mut angle = -90.0;
            while angle <= 90.0 {
                let xyz = model.xyz_at(angle);
                for v in xyz {
                    assert!(v.is_finite(), "h={altitude} a={angle}");
                    assert!(v >= 0.0, "h={altitude} a={angle}: {v}");
                }
                angle += 7.5;
            }
        }
    }

    /// まとめて解いた結果が 1 方向ずつ解いた結果と一致する(添字のバグ取り)。
    #[test]
    fn まとめた計算と単発が一致する() {
        let mut model = SkyModelCore::new(conditions(20.0));
        let angles = [-90.0, -45.0, -1.0, 0.0, 1.0, 45.0, 90.0];
        let flat = model.xyz_many(&angles);
        for (i, &angle) in angles.iter().enumerate() {
            let single = model.xyz_at(angle);
            for k in 0..3 {
                assert_eq!(flat[i * 3 + k], single[k], "a = {angle}, k = {k}");
            }
        }
    }

    /// 分光の表と三刺激値が同じ標本器から出ていること。
    #[test]
    fn 分光の表が三刺激値と整合する() {
        let mut model = SkyModelCore::new(conditions(20.0));
        let table = model.spectrum_table(30.0);
        assert_eq!(table.len(), TABLE_LENGTH);
        // 5nm 刻みで台形則にかけると xyz_at と一致するはず。
        let manual = spectrum_to_xyz(
            |lambda| table[(lambda - TABLE_LAMBDA_MIN as f64) as usize],
            SPECTRUM_LAMBDA_MIN,
            SPECTRUM_LAMBDA_MAX,
            SPECTRUM_STEP_NM,
        );
        let direct = model.xyz_at(30.0);
        for k in 0..3 {
            assert!((manual[k] - direct[k]).abs() / direct[k] < 1e-12, "k = {k}");
        }
    }

    /// 単散乱では色度が天頂を挟んでほぼ左右対称になる。
    ///
    /// 位相関数 P(Θ) も光路長も波長に依らないスカラーなので、±a の違いは本来
    /// スペクトル全体の定数倍にしかならず、色度は動かない。**平行平面ならこれは
    /// 厳密**だが、球殻では地球の影が ±a で違う標本を落とすため、透過率
    /// exp(−τ(λ)·total) の波長依存を通してわずかに崩れる。太陽高度 45° で
    /// 残る差は 1e-5 のオーダー(TypeScript 実装でも同じ値)。
    #[test]
    fn 単散乱では色度がほぼ左右対称になる() {
        let mut model = SkyModelCore::new(SkyConditions {
            sun_altitude_deg: 45.0,
            temperature_k: 5778.0,
            multiple_scattering: false,
            aerosol_optical_depth: 0.0,
        });
        for angle in [15.0, 30.0, 60.0] {
            let west = model.xyz_at(angle);
            let east = model.xyz_at(-angle);
            let x_west = west[0] / (west[0] + west[1] + west[2]);
            let x_east = east[0] / (east[0] + east[1] + east[2]);
            let difference = (x_west - x_east).abs();
            assert!(difference < 1e-4, "a = {angle}: Δx = {difference}");
        }
    }

    /// 地球の影を入れたので、太陽が低いと東西が非対称になる。
    #[test]
    fn 太陽が低いと東西が非対称になる() {
        let luminance = |altitude: f64, angle: f64| {
            SkyModelCore::new(SkyConditions {
                sun_altitude_deg: altitude,
                temperature_k: 5778.0,
                multiple_scattering: false,
                aerosol_optical_depth: 0.0,
            })
            .xyz_at(angle)[1]
        };
        // 太陽が天頂ならほぼ対称。
        let high = luminance(90.0, 89.0) / luminance(90.0, -89.0);
        assert!((high - 1.0).abs() < 1e-3, "high = {high}");
        // 沈むにつれて西が明るくなる。
        let low = luminance(2.0, 89.0) / luminance(2.0, -89.0);
        assert!(low > 1.3, "low = {low}");
    }

    #[test]
    fn 単散乱のみなら多重散乱の寄与は0() {
        let mut model = SkyModelCore::new(SkyConditions {
            sun_altitude_deg: 45.0,
            temperature_k: 5778.0,
            multiple_scattering: false,
            aerosol_optical_depth: 0.1,
        });
        assert_eq!(model.multiple_scattering_share(), 0.0);
    }

    #[test]
    fn 多重散乱の寄与は0と1の間に収まる() {
        let mut model = SkyModelCore::new(conditions(45.0));
        let share = model.multiple_scattering_share();
        assert!((0.0..1.0).contains(&share), "share = {share}");
        assert!(share > 0.1, "share = {share}");
    }

    /// AOD = 0 はエアロゾル無しと厳密に一致する(短絡経路の確認)。
    #[test]
    fn エアロゾル量0は無効と同じ結果になる() {
        let make = |aod: f64| {
            SkyModelCore::new(SkyConditions {
                sun_altitude_deg: 30.0,
                temperature_k: 5778.0,
                multiple_scattering: true,
                aerosol_optical_depth: aod,
            })
            .xyz_at(20.0)
        };
        assert_eq!(make(0.0), make(-1.0));
    }
}
