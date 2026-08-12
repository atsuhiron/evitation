/**
 * 球殻の大気の幾何 — 光路の柱密度と、地球の影。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * 平行平面の大気には **地球の影が存在しない**。太陽が地平線より上にある限り
 * 大気のあらゆる点が照らされてしまうので、日没時でも東の空が西と同じ明るさに
 * なってしまう。実際には東の低空はすでに地球の影の中にあり、東から昇る地球影と
 * その上のビーナスベルトがそれにあたる。ここはその影を出すための幾何。
 *
 * ## 設計の鍵: 光路長は波長に依らない
 *
 * 密度プロファイルは全波長で共通で、消散係数は β(λ)·ρ(z)/ρ₀ と書けるので
 *
 *   τ_path(λ) = τ_vertical(λ) × (鉛直の柱を 1 としたときの、その光路の柱密度)
 *
 * と分解できる。したがって **幾何は方向ごとに 1 度解けばよく、波長ループには
 * 指数関数しか残らない**。柱密度は要するに air mass そのもので、
 * Kasten–Young の経験式が与えていた量を幾何から求め直していることになる。
 *
 * 鉛直の総量 τ_vertical は rayleigh.ts が断面積から導出した値をそのまま使い、
 * ここが決めるのは **分布の形だけ**(等温の指数大気)。
 */

const DEG = Math.PI / 180;

/** 地球の平均半径 [m]。 */
export const EARTH_RADIUS_M = 6_371_000;

/** 分子大気の尺度高さ [m]。等温近似での代表値。 */
export const RAYLEIGH_SCALE_HEIGHT_M = 8_500;

/** エアロゾルの尺度高さ [m]。分子よりずっと薄い層に溜まっている。 */
export const AEROSOL_SCALE_HEIGHT_M = 1_200;

/**
 * 大気の上端 [m]。
 *
 * ここで打ち切ることによる取りこぼしは exp(−100/8.5) ≈ 8e-6 で、
 * 鉛直の柱密度が 1 になることを 5 桁で確かめられる程度には小さい。
 */
export const ATMOSPHERE_TOP_M = 100_000;

/**
 * 視線に沿った行進の刻み数。
 *
 * 幾何の計算量は 視線 × 太陽 で効くので、ここが速さを直接決める。
 * 十分細かい基準(1536 × 256)と突き合わせて選んだ値で、輝度の誤差は 0.7%、
 * **8bit に落とした色の差は 1 以内**。刻みを倍にしても見た目は変わらない。
 */
export const VIEW_STEPS = 96;

/** 各点から太陽方向へ抜けるときの行進の刻み数。 */
export const SUN_STEPS = 24;

/** 主平面の 2 次元ベクトル。地球中心を原点、観測者の真上を +y、西を +x に取る。 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** 光路の柱密度。鉛直の柱を 1 とした無次元量(= air mass)。 */
export interface SlantColumns {
  readonly rayleigh: number;
  readonly aerosol: number;
}

/**
 * 大気の形状を差し替えられるようにしておく。
 *
 * 球殻マーチャが R → ∞ で平行平面の解に一致することを確かめるために、
 * テストから地球半径を大きくしたいことがある。
 */
export interface AtmosphereShape {
  readonly earthRadiusM: number;
  readonly rayleighScaleHeightM: number;
  readonly aerosolScaleHeightM: number;
  readonly atmosphereTopM: number;
}

export const DEFAULT_SHAPE: AtmosphereShape = {
  earthRadiusM: EARTH_RADIUS_M,
  rayleighScaleHeightM: RAYLEIGH_SCALE_HEIGHT_M,
  aerosolScaleHeightM: AEROSOL_SCALE_HEIGHT_M,
  atmosphereTopM: ATMOSPHERE_TOP_M,
};

// --- 光線と球殻の交わり ---------------------------------------------------------

/**
 * 点 `origin` から向き `dir`(単位ベクトル)へ進んだとき、半径 `radius` の球殻に
 * 到達するまでの距離。原点が球殻の内側にあることを前提にするので、正の根が必ず 1 つある。
 */
function distanceToShell(origin: Vec2, dir: Vec2, radius: number): number {
  const b = origin.x * dir.x + origin.y * dir.y;
  const c = origin.x * origin.x + origin.y * origin.y - radius * radius;
  return -b + Math.sqrt(Math.max(0, b * b - c));
}

/**
 * 点 `origin` から向き `dir` へ伸ばした半直線が固体地球に遮られるか。
 *
 * 最接近点は t* = −(P·S)。それが後ろ向き(t* ≤ 0)なら地球から遠ざかる一方なので
 * 当たらない。前方にあるなら、そのときの原点からの距離が地球半径を下回るかで決まる。
 */
export function isShadowed(origin: Vec2, dir: Vec2, earthRadiusM: number): boolean {
  const t = -(origin.x * dir.x + origin.y * dir.y);
  if (t <= 0) return false;
  const perpendicularSquared = origin.x * origin.x + origin.y * origin.y - t * t;
  return perpendicularSquared < earthRadiusM * earthRadiusM;
}

// --- 柱密度 --------------------------------------------------------------------

/**
 * 行進の刻みは **始点に寄せて二次で分布させる**。
 *
 *   s(u) = L·u²,  u = (i + 0.5)/N,  Δs_i = L·(2i + 1)/N²
 *
 * 一様に刻むと、鉛直に近い視線で破綻する。上端まで 100km を等分すると 1 刻みが
 * 520m になり、エアロゾルの尺度高さ 1.2km に対して粗すぎて中点則の誤差が
 * 0.8% 残る(実測)。一方その視線の密度は最初の数 km にほぼ全部あるので、
 * 上のほうを細かく刻んでも無駄。
 *
 * 二次分布なら、鉛直視線で始点付近の刻みが 5m まで細かくなり、水平視線では
 * 終端でも 12km — 水平方向の密度変化の尺度 √(2RH) = 329km を十分下回る。
 */
function stepPosition(index: number, steps: number, length: number): number {
  const u = (index + 0.5) / steps;
  return length * u * u;
}

function stepWidth(index: number, steps: number, length: number): number {
  return (length * (2 * index + 1)) / (steps * steps);
}

/**
 * 指定の光路に沿った柱密度。鉛直の柱で割って無次元化してある。
 *
 * 鉛直の柱は ∫₀^∞ exp(−z/H) dz = H なので、H で割れば「何本分か」になる。
 */
function integrateColumns(
  origin: Vec2,
  dir: Vec2,
  length: number,
  steps: number,
  shape: AtmosphereShape,
): SlantColumns {
  let rayleigh = 0;
  let aerosol = 0;

  for (let i = 0; i < steps; i += 1) {
    const s = stepPosition(i, steps, length);
    const width = stepWidth(i, steps, length);
    const x = origin.x + dir.x * s;
    const y = origin.y + dir.y * s;
    const altitude = Math.hypot(x, y) - shape.earthRadiusM;
    if (altitude < 0) continue; // 地面を掠める光路。物理的には遮られている。
    rayleigh += Math.exp(-altitude / shape.rayleighScaleHeightM) * width;
    aerosol += Math.exp(-altitude / shape.aerosolScaleHeightM) * width;
  }

  return {
    rayleigh: rayleigh / shape.rayleighScaleHeightM,
    aerosol: aerosol / shape.aerosolScaleHeightM,
  };
}

/**
 * 地上の観測者から天頂角 `zenithDeg` の方向に見上げたときの、大気圏外までの柱密度。
 *
 * これが Kasten–Young の air mass に相当する量。等温の指数大気では水平方向 (90°) で
 * √(πR/2H) ≈ 34.3 になることが解析的に知られていて、テストではそこを突き合わせる。
 */
export function slantColumnsFromGround(
  zenithDeg: number,
  shape: AtmosphereShape = DEFAULT_SHAPE,
  steps: number = VIEW_STEPS,
): SlantColumns {
  const origin: Vec2 = { x: 0, y: shape.earthRadiusM };
  const dir: Vec2 = { x: Math.sin(zenithDeg * DEG), y: Math.cos(zenithDeg * DEG) };
  const topRadius = shape.earthRadiusM + shape.atmosphereTopM;
  return integrateColumns(origin, dir, distanceToShell(origin, dir, topRadius), steps, shape);
}

// --- 視線に沿った標本 -----------------------------------------------------------

export interface PathSample {
  /** この区間が寄与する柱密度(散乱源の強さ)。 */
  readonly dRayleigh: number;
  readonly dAerosol: number;
  /**
   * 観測者からこの点まで + この点から太陽まで を合わせた柱密度。
   *
   * 透過率は exp(−[τ_R·totalRayleigh + τ_M·totalAerosol]) の 1 本で済む。
   * 視線側と太陽側を別々に持つ必要はないので、**波長ごとの指数が 1 回に減る**。
   */
  readonly totalRayleigh: number;
  readonly totalAerosol: number;
}

/**
 * 視線に沿って行進し、**日の当たっている区間だけ**を標本として返す。
 *
 * 影の中の区間は直達光が届かないので単散乱の寄与が 0 になる。落としてしまえば
 * 波長ループも短くなるので、薄明では自然に速くなる。
 *
 * @param skyAngleDeg 天頂からの符号つき角。−90 が東の地平線、+90 が西の地平線。
 * @param sunAltitudeDeg 太陽高度。負なら地平線下(薄明)。
 */
export function viewPathSamples(
  skyAngleDeg: number,
  sunAltitudeDeg: number,
  shape: AtmosphereShape = DEFAULT_SHAPE,
  viewSteps: number = VIEW_STEPS,
  sunSteps: number = SUN_STEPS,
): readonly PathSample[] {
  const radius = shape.earthRadiusM;
  const topRadius = radius + shape.atmosphereTopM;

  const origin: Vec2 = { x: 0, y: radius };
  const view: Vec2 = { x: Math.sin(skyAngleDeg * DEG), y: Math.cos(skyAngleDeg * DEG) };
  // 太陽の天頂角。高度が負なら 90° を超え、cos が負になって自然に地平線下を向く。
  const sunZenith = (90 - sunAltitudeDeg) * DEG;
  const sun: Vec2 = { x: Math.sin(sunZenith), y: Math.cos(sunZenith) };

  const length = distanceToShell(origin, view, topRadius);

  const samples: PathSample[] = [];
  // 観測者からその点までの柱密度を、行進しながら積み上げる。
  let viewRayleigh = 0;
  let viewAerosol = 0;

  for (let i = 0; i < viewSteps; i += 1) {
    const s = stepPosition(i, viewSteps, length);
    const width = stepWidth(i, viewSteps, length);
    const point: Vec2 = { x: origin.x + view.x * s, y: origin.y + view.y * s };
    const altitude = Math.hypot(point.x, point.y) - radius;

    const dRayleigh =
      (Math.exp(-altitude / shape.rayleighScaleHeightM) * width) / shape.rayleighScaleHeightM;
    const dAerosol =
      (Math.exp(-altitude / shape.aerosolScaleHeightM) * width) / shape.aerosolScaleHeightM;

    // 区間の中点までの分を加えてから、抜けた分を足す(中点則と辻褄を合わせる)。
    const midRayleigh = viewRayleigh + dRayleigh / 2;
    const midAerosol = viewAerosol + dAerosol / 2;
    viewRayleigh += dRayleigh;
    viewAerosol += dAerosol;

    if (isShadowed(point, sun, radius)) continue;

    const sunPath = integrateColumns(
      point,
      sun,
      distanceToShell(point, sun, topRadius),
      sunSteps,
      shape,
    );

    samples.push({
      dRayleigh,
      dAerosol,
      totalRayleigh: midRayleigh + sunPath.rayleigh,
      totalAerosol: midAerosol + sunPath.aerosol,
    });
  }

  return samples;
}
