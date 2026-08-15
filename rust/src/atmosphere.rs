//! 球殻の大気の幾何 — 光路の柱密度と、地球の影。
//! src/physics/atmosphere.ts の移植。
//!
//! ## 設計の鍵: 光路長は波長に依らない
//!
//!   τ_path(λ) = τ_vertical(λ) × (鉛直の柱を 1 としたときの、その光路の柱密度)
//!
//! と分解できるので、幾何は方向ごとに 1 度解けばよく、波長ループには指数関数しか
//! 残らない。
//!
//! ## TypeScript 版との違い
//!
//! 標本を構造体の配列ではなく **4 本の平行な `Vec<f64>` (SoA)** で持つ。
//! `PathSamples` は `SkyModel` が 1 本だけ持って方向ごとに詰め直すので、
//! 定常状態では確保が起きない。TypeScript 版が 1 描画で 10 万個ほどの
//! 短命オブジェクトを作っていたのを消すのが、移植の速度上の主眼。

/// 地球の平均半径 [m]。
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;
/// 分子大気の尺度高さ [m]。
pub const RAYLEIGH_SCALE_HEIGHT_M: f64 = 8_500.0;
/// エアロゾルの尺度高さ [m]。
pub const AEROSOL_SCALE_HEIGHT_M: f64 = 1_200.0;
/// 大気の上端 [m]。
pub const ATMOSPHERE_TOP_M: f64 = 100_000.0;
/// 視線に沿った行進の刻み数。
pub const VIEW_STEPS: usize = 96;
/// 各点から太陽方向へ抜けるときの行進の刻み数。
pub const SUN_STEPS: usize = 24;

const DEG: f64 = std::f64::consts::PI / 180.0;

/// 大気の形状。テストから地球半径を大きくして平行平面の解と突き合わせるため、
/// 差し替えられるようにしてある。
#[derive(Clone, Copy, Debug)]
pub struct AtmosphereShape {
    pub earth_radius_m: f64,
    pub rayleigh_scale_height_m: f64,
    pub aerosol_scale_height_m: f64,
    pub atmosphere_top_m: f64,
}

impl Default for AtmosphereShape {
    fn default() -> Self {
        Self {
            earth_radius_m: EARTH_RADIUS_M,
            rayleigh_scale_height_m: RAYLEIGH_SCALE_HEIGHT_M,
            aerosol_scale_height_m: AEROSOL_SCALE_HEIGHT_M,
            atmosphere_top_m: ATMOSPHERE_TOP_M,
        }
    }
}

/// 光路の柱密度。鉛直の柱を 1 とした無次元量(= air mass)。
#[derive(Clone, Copy, Debug, Default)]
pub struct SlantColumns {
    pub rayleigh: f64,
    pub aerosol: f64,
}

/// 視線に沿った標本を平行な 4 本の配列で持つ(SoA)。
#[derive(Clone, Debug, Default)]
pub struct PathSamples {
    /// この区間が寄与する柱密度(散乱源の強さ)。
    pub d_rayleigh: Vec<f64>,
    pub d_aerosol: Vec<f64>,
    /// 観測者からこの点まで + この点から太陽まで を合わせた柱密度。
    /// 足してあるので、波長ごとの指数が標本ひとつに 1 回で済む。
    pub total_rayleigh: Vec<f64>,
    pub total_aerosol: Vec<f64>,
}

impl PathSamples {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            d_rayleigh: Vec::with_capacity(capacity),
            d_aerosol: Vec::with_capacity(capacity),
            total_rayleigh: Vec::with_capacity(capacity),
            total_aerosol: Vec::with_capacity(capacity),
        }
    }

    pub fn clear(&mut self) {
        self.d_rayleigh.clear();
        self.d_aerosol.clear();
        self.total_rayleigh.clear();
        self.total_aerosol.clear();
    }

    pub fn len(&self) -> usize {
        self.d_rayleigh.len()
    }

    pub fn is_empty(&self) -> bool {
        self.d_rayleigh.is_empty()
    }
}

/// 点から向き `dir` へ進んだとき、半径 `radius` の球殻に到達するまでの距離。
/// 原点が球殻の内側にあることを前提にするので、正の根が必ず 1 つある。
fn distance_to_shell(origin: (f64, f64), dir: (f64, f64), radius: f64) -> f64 {
    let b = origin.0 * dir.0 + origin.1 * dir.1;
    let c = origin.0 * origin.0 + origin.1 * origin.1 - radius * radius;
    -b + (b * b - c).max(0.0).sqrt()
}

/// 点から向き `dir` へ伸ばした半直線が固体地球に遮られるか。
///
/// 最接近点は t* = −(P·S)。後ろ向きなら遠ざかる一方なので当たらない。
pub fn is_shadowed(origin: (f64, f64), dir: (f64, f64), earth_radius_m: f64) -> bool {
    let t = -(origin.0 * dir.0 + origin.1 * dir.1);
    if t <= 0.0 {
        return false;
    }
    let perpendicular_squared = origin.0 * origin.0 + origin.1 * origin.1 - t * t;
    perpendicular_squared < earth_radius_m * earth_radius_m
}

/// 行進の刻みは始点に寄せて二次で分布させる。s(u) = L·u², u = (i + 0.5)/N。
///
/// 一様に刻むと鉛直に近い視線で破綻する(エアロゾルの尺度高さ 1.2km に対して
/// 粗すぎ、中点則の誤差が 0.8% 残る)。
fn step_position(index: usize, steps: usize, length: f64) -> f64 {
    let u = (index as f64 + 0.5) / steps as f64;
    length * u * u
}

fn step_width(index: usize, steps: usize, length: f64) -> f64 {
    (length * (2 * index + 1) as f64) / (steps * steps) as f64
}

/// 指定の光路に沿った柱密度。鉛直の柱で割って無次元化してある。
fn integrate_columns(
    origin: (f64, f64),
    dir: (f64, f64),
    length: f64,
    steps: usize,
    shape: &AtmosphereShape,
) -> SlantColumns {
    let mut rayleigh = 0.0;
    let mut aerosol = 0.0;

    for i in 0..steps {
        let s = step_position(i, steps, length);
        let width = step_width(i, steps, length);
        let x = origin.0 + dir.0 * s;
        let y = origin.1 + dir.1 * s;
        let altitude = x.hypot(y) - shape.earth_radius_m;
        if altitude < 0.0 {
            continue; // 地面を掠める光路。物理的には遮られている。
        }
        rayleigh += (-altitude / shape.rayleigh_scale_height_m).exp() * width;
        aerosol += (-altitude / shape.aerosol_scale_height_m).exp() * width;
    }

    SlantColumns {
        rayleigh: rayleigh / shape.rayleigh_scale_height_m,
        aerosol: aerosol / shape.aerosol_scale_height_m,
    }
}

/// 地上から天頂角 `zenith_deg` を見上げたときの、大気圏外までの柱密度。
///
/// 等温の指数大気では水平方向 (90°) で √(πR/2H) ≈ 34.3 になることが解析的に
/// 知られていて、テストではそこを突き合わせる。
pub fn slant_columns_from_ground(
    zenith_deg: f64,
    shape: &AtmosphereShape,
    steps: usize,
) -> SlantColumns {
    let origin = (0.0, shape.earth_radius_m);
    let dir = ((zenith_deg * DEG).sin(), (zenith_deg * DEG).cos());
    let top_radius = shape.earth_radius_m + shape.atmosphere_top_m;
    integrate_columns(
        origin,
        dir,
        distance_to_shell(origin, dir, top_radius),
        steps,
        shape,
    )
}

/// 視線に沿って行進し、**日の当たっている区間だけ**を `out` に詰める。
///
/// 影の中の区間は直達光が届かないので寄与が 0 になる。落としてしまえば波長ループも
/// 短くなるので、薄明では自然に速くなる。
///
/// `out` は呼び出し側が使い回す。ここで `clear()` してから詰め直すので、
/// 容量が足りていれば確保は起きない。
pub fn view_path_samples_into(
    out: &mut PathSamples,
    sky_angle_deg: f64,
    sun_altitude_deg: f64,
    shape: &AtmosphereShape,
    view_steps: usize,
    sun_steps: usize,
) {
    out.clear();

    let radius = shape.earth_radius_m;
    let top_radius = radius + shape.atmosphere_top_m;

    let origin = (0.0, radius);
    let view = ((sky_angle_deg * DEG).sin(), (sky_angle_deg * DEG).cos());
    // 太陽の天頂角。高度が負なら 90° を超え、cos が負になって自然に地平線下を向く。
    let sun_zenith = (90.0 - sun_altitude_deg) * DEG;
    let sun = (sun_zenith.sin(), sun_zenith.cos());

    let length = distance_to_shell(origin, view, top_radius);

    // 観測者からその点までの柱密度を、行進しながら積み上げる。
    let mut view_rayleigh = 0.0;
    let mut view_aerosol = 0.0;

    for i in 0..view_steps {
        let s = step_position(i, view_steps, length);
        let width = step_width(i, view_steps, length);
        let point = (origin.0 + view.0 * s, origin.1 + view.1 * s);
        let altitude = point.0.hypot(point.1) - radius;

        let d_rayleigh = (-altitude / shape.rayleigh_scale_height_m).exp() * width
            / shape.rayleigh_scale_height_m;
        let d_aerosol =
            (-altitude / shape.aerosol_scale_height_m).exp() * width / shape.aerosol_scale_height_m;

        // 区間の中点までの分を加えてから、抜けた分を足す(中点則と辻褄を合わせる)。
        let mid_rayleigh = view_rayleigh + d_rayleigh / 2.0;
        let mid_aerosol = view_aerosol + d_aerosol / 2.0;
        view_rayleigh += d_rayleigh;
        view_aerosol += d_aerosol;

        if is_shadowed(point, sun, radius) {
            continue;
        }

        let sun_path = integrate_columns(
            point,
            sun,
            distance_to_shell(point, sun, top_radius),
            sun_steps,
            shape,
        );

        out.d_rayleigh.push(d_rayleigh);
        out.d_aerosol.push(d_aerosol);
        out.total_rayleigh.push(mid_rayleigh + sun_path.rayleigh);
        out.total_aerosol.push(mid_aerosol + sun_path.aerosol);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn 天頂の柱密度は1になる() {
        let shape = AtmosphereShape::default();
        let columns = slant_columns_from_ground(0.0, &shape, VIEW_STEPS);
        // 既定の刻み数で残る誤差は中点則の打ち切りによるもので、分子で 1e-4、
        // 尺度高さの小さいエアロゾルで 7e-4(TypeScript 実装と同じ値)。
        // 刻み数は「色を 8bit に落としたときの差が 1 以内」を基準に選んであり、
        // 量子化幅 1/255 ≈ 4e-3 に対して十分小さい。
        assert!(
            (columns.rayleigh - 1.0).abs() < 5e-3,
            "rayleigh = {}",
            columns.rayleigh
        );
        assert!(
            (columns.aerosol - 1.0).abs() < 5e-3,
            "aerosol = {}",
            columns.aerosol
        );
    }

    /// 等温の指数大気では水平方向の柱密度が解析的に √(πR/2H) と分かっている。
    /// 行進・密度プロファイル・球殻の幾何を一度に突き合わせられる 1 点。
    #[test]
    fn 水平の柱密度が解析解と一致する() {
        let shape = AtmosphereShape::default();
        let columns = slant_columns_from_ground(90.0, &shape, VIEW_STEPS);
        let expected = (PI * shape.earth_radius_m / (2.0 * shape.rayleigh_scale_height_m)).sqrt();
        assert!((expected - 34.31).abs() < 0.01, "expected = {expected}");
        assert!(
            (columns.rayleigh - expected).abs() / expected < 0.01,
            "rayleigh = {}, expected = {expected}",
            columns.rayleigh
        );
    }

    /// 半径を大きくすると平行平面に近づき、柱密度は 1/cos z に収束する。
    #[test]
    fn 半径を大きくすると1割るcosに収束する() {
        let shape = AtmosphereShape {
            earth_radius_m: 1e13,
            ..AtmosphereShape::default()
        };
        for zenith in [0.0, 30.0, 60.0, 75.0] {
            let columns = slant_columns_from_ground(zenith, &shape, 4096);
            let expected = 1.0 / (zenith * DEG).cos();
            assert!(
                (columns.rayleigh - expected).abs() / expected < 2e-3,
                "z = {zenith}, got = {}, expected = {expected}",
                columns.rayleigh
            );
        }
    }

    #[test]
    fn 刻み幅の総和が光路長に一致する() {
        let steps = VIEW_STEPS;
        let length = 123_456.0;
        let total: f64 = (0..steps).map(|i| step_width(i, steps, length)).sum();
        assert!((total - length).abs() / length < 1e-12);
    }

    #[test]
    fn 影の判定は太陽が地平線下のときだけ真になる() {
        let radius = EARTH_RADIUS_M;
        let ground = (0.0, radius + 1000.0);
        // 真上を向く方向は決して遮られない。
        assert!(!is_shadowed(ground, (0.0, 1.0), radius));
        // 真下を向く方向は必ず遮られる。
        assert!(is_shadowed(ground, (0.0, -1.0), radius));
        // 水平からわずかに下向きは遮られる。
        let down = ((-2.0f64 * DEG).cos(), (-2.0f64 * DEG).sin());
        assert!(is_shadowed(ground, down, radius));
    }

    /// 太陽が高ければ影に入る標本はなく、全ステップが残る。
    #[test]
    fn 太陽が高いと標本が落ちない() {
        let shape = AtmosphereShape::default();
        let mut samples = PathSamples::default();
        view_path_samples_into(&mut samples, 0.0, 90.0, &shape, VIEW_STEPS, SUN_STEPS);
        assert_eq!(samples.len(), VIEW_STEPS);
    }

    /// 薄明では地球の影で標本が落ちる。落ちるからこそ薄明は速い。
    #[test]
    fn 薄明では影で標本が減る() {
        let shape = AtmosphereShape::default();
        let mut samples = PathSamples::default();
        view_path_samples_into(&mut samples, 0.0, -6.0, &shape, VIEW_STEPS, SUN_STEPS);
        assert!(samples.len() < VIEW_STEPS, "len = {}", samples.len());
        assert!(!samples.is_empty());
    }

    /// 使い回しても前の方向の標本が残らない。
    #[test]
    fn 詰め直しても前の内容が残らない() {
        let shape = AtmosphereShape::default();
        let mut samples = PathSamples::default();
        view_path_samples_into(&mut samples, 0.0, 90.0, &shape, VIEW_STEPS, SUN_STEPS);
        let first = samples.len();
        view_path_samples_into(&mut samples, 0.0, -6.0, &shape, VIEW_STEPS, SUN_STEPS);
        assert!(samples.len() < first);
        assert_eq!(samples.len(), samples.total_rayleigh.len());
        assert_eq!(samples.len(), samples.d_aerosol.len());
    }
}
