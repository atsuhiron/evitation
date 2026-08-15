/**
 * 空の色 — 大気にばらまかれた光の放射伝達。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * rayleigh.ts が扱ったのは光路から **失われる** 分 exp(−τ·m) だけだった。
 * こちらはその **行き先** を計算する。散乱で消えた光がどこへ行ったのかという
 * 問いの答えが、そのまま空の色になる。
 *
 * ## 大気は球殻として扱う
 *
 * かつては平行平面で、単散乱が閉じた形で解けていた(`planeParallelRadiance` に残して
 * ある)。しかし平行平面には **地球の影が存在しない** — 太陽が地平線より上にある限り
 * 大気のあらゆる点が照らされるので、日没直前でも東の地平線が西とまったく同じ色・
 * 同じ明るさになってしまう。レイリー位相関数が Θ → 180−Θ で対称なうえ、air mass が
 * |視線角| にしか依らないためで、実測でも東西が厳密に一致していた。
 *
 * そこで atmosphere.ts の球殻の行進に置き換えてある。散乱は 2 種類:
 *
 * - **レイリー散乱**(空気分子)— 前後対称、λ⁻⁴ に近い
 * - **Mie 散乱**(エアロゾル)— 強く前方に偏り、波長にはあまり依らない
 *
 * ## 入っていないもの
 *
 * オゾンの Chappuis 帯、地面の反射、大気による屈折、エアロゾルの吸収 (ω < 1)。
 * 多重散乱は平行平面の見積もりのままで、球殻化していない。
 */

import { spectrumToXYZ, type XYZ } from '../color/index.ts';
import {
  AEROSOL_ASYMMETRY,
  aerosolOpticalDepth,
  henyeyGreenstein,
} from './aerosol.ts';
import { airMassAtZenithAngle } from './air-mass.ts';
import { DEFAULT_SHAPE, SUN_STEPS, VIEW_STEPS, viewPathSamples, type AtmosphereShape, type PathSample } from './atmosphere.ts';
import { normalizedSpectrum } from './planck.ts';
import { opticalDepth } from './rayleigh.ts';

const DEG = Math.PI / 180;

/**
 * 分光積分の範囲と刻み。
 *
 * 可視域だけで足りる。行進の 1 標本ごとに指数関数が要るので、刻みは CIE が
 * 等色関数を表にしているのと同じ 5nm まで落としてある。既定(360–830nm を 1nm)と
 * 比べた 8bit の色差は、太陽高度・エアロゾル量・方向を振っても **最大 1**
 * (10nm まで落としても 1 のままだが、余裕を見て 5nm に留めている)。
 */
const SPECTRUM_OPTIONS = { lambdaMin: 380, lambdaMax: 780, stepNm: 5 } as const;

export interface SkyConditions {
  /** 太陽高度 [deg]。0 が地平線、90 が天頂。負なら地平線下(薄明)。 */
  readonly sunAltitudeDeg: number;
  /** 太陽の分光分布を決める黒体温度 [K]。 */
  readonly temperatureK: number;
  /** 2 回以上散乱された光を等方な成分として足すか。 */
  readonly multipleScattering: boolean;
  /** エアロゾルの光学的厚さ (550nm)。0 で無効。 */
  readonly aerosolOpticalDepth: number;
}

// --- 幾何 ----------------------------------------------------------------------

/**
 * 太陽の「空の角度」。天頂を 0、西を + とする符号つき角 [deg]。
 *
 * 太陽は西に沈むものとして + 側に置く。高度 90° なら 0(天頂)、0° なら +90(西の
 * 地平線)、負の高度なら 90 を超えて地平線下を指す。
 */
export function sunSkyAngleDeg(sunAltitudeDeg: number): number {
  return 90 - sunAltitudeDeg;
}

/**
 * 散乱角 Θ [deg]。
 *
 * 視線も太陽方向もどちらも固定の直線なので、**球殻でも光路上で一定**。
 * 主平面の中で 2 方向のなす角は符号つき角の引き算で出る。太陽高度が負だと
 * 差が 180° を超えるので折り返す。
 */
export function scatteringAngleDeg(skyAngleDeg: number, sunAltitudeDeg: number): number {
  const difference = Math.abs(skyAngleDeg - sunSkyAngleDeg(sunAltitudeDeg)) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * レイリー位相関数 P(Θ) = (3/4)(1 + cos²Θ)。
 *
 * ∫P dΩ/4π = 1 に規格化されている。前方 (0°) と後方 (180°) が等しく 1.5、
 * 横 (90°) が 0.75 — つまり散乱は前後に 2 倍偏るだけで、ほぼ等方に近い。
 * **前後対称なので、これだけでは東西の非対称は決して生まれない。**
 */
export function rayleighPhase(cosTheta: number): number {
  return 0.75 * (1 + cosTheta * cosTheta);
}

/**
 * 方位角について平均したレイリー位相関数。
 *
 *   ⟨P⟩(μ, μ₀) = (3/4)[ 1 + μ²μ₀² + ½(1−μ²)(1−μ₀²) ]
 *
 * cosΘ = μμ₀ + √(1−μ²)√(1−μ₀²)·cos Δφ を Δφ について平均すると出る
 * (⟨cos Δφ⟩ = 0、⟨cos²Δφ⟩ = 1/2)。フラックスを求めるときは方位角が積分で
 * 消えるので、こちらを使えば 2 重積分が 1 重で済む。
 */
export function azimuthAveragedPhase(mu: number, mu0: number): number {
  return 0.75 * (1 + mu * mu * mu0 * mu0 + 0.5 * (1 - mu * mu) * (1 - mu0 * mu0));
}

/** Henyey–Greenstein の方位角平均。閉じた形にならないので数値で積分する。 */
const AZIMUTH_STEPS = 64;

function azimuthAveragedHenyeyGreenstein(mu: number, mu0: number): number {
  const cross = Math.sqrt(Math.max(0, 1 - mu * mu)) * Math.sqrt(Math.max(0, 1 - mu0 * mu0));
  let total = 0;
  for (let i = 0; i < AZIMUTH_STEPS; i += 1) {
    const phi = (2 * Math.PI * (i + 0.5)) / AZIMUTH_STEPS;
    total += henyeyGreenstein(mu * mu0 + cross * Math.cos(phi), AEROSOL_ASYMMETRY);
  }
  return total / AZIMUTH_STEPS;
}

// --- 平行平面の閉じた形(参照用) ----------------------------------------------------

/** δ = m₀ − m_v がこれより小さければ極限の式に切り替える。 */
const DELTA_EPSILON = 1e-9;

/**
 * 光路積分の中身。
 *
 *   ∫₀^τ e^(−t·m₀) · e^(−(τ−t)·m_v) dt  =  [e^(−τ m_v) − e^(−τ m₀)] / (m₀ − m_v)
 *
 * 太陽方向とその鏡像では m₀ ≈ m_v になって分母が 0 に近づき、素直に引き算すると
 * 桁落ちする。planck.ts で expm1 を使ったのと同じ理由でここも書き換える。
 *
 * **括り出すのは指数の小さいほう(= 値の大きいほう)でなければならない。**
 * 逆にすると、視線が地平線に寄って m_v ≫ m₀ になったとき e^(−大) が 0 に
 * アンダーフローする一方 expm1(+大) が Infinity になり、0 × ∞ = NaN が出る。
 */
function pathIntegral(tau: number, mView: number, mSun: number): number {
  const spread = Math.abs(mSun - mView);
  if (spread < DELTA_EPSILON) return tau * Math.exp(-tau * mView);
  const magnitude = -Math.exp(-tau * Math.min(mView, mSun)) * Math.expm1(-tau * spread);
  return magnitude / spread;
}

/**
 * 平行平面・単散乱の閉じた形。
 *
 *   L₁ = F₀ · P(Θ)/4π · m_v · [e^(−τ m_v) − e^(−τ m₀)]/(m₀ − m_v)
 *
 * **いまはページから使っていない。**球殻の行進が R → ∞ でこれに収束することを
 * 確かめるための参照実装として残してある。air mass を引数で受けるので、
 * Kasten–Young でも 1/cos z でも差し替えられる。
 */
export function planeParallelRadianceWithAirMass(
  lambdaNm: number,
  cosTheta: number,
  mView: number,
  mSun: number,
  temperatureK: number,
): number {
  const tau = opticalDepthAt(lambdaNm);
  return (
    normalizedSpectrum(lambdaNm, temperatureK) *
    (rayleighPhase(cosTheta) / (4 * Math.PI)) *
    mView *
    pathIntegral(tau, mView, mSun)
  );
}

/** 上の Kasten–Young 版。かつてページが使っていた式そのもの。 */
export function planeParallelRadiance(
  lambdaNm: number,
  skyAngleDeg: number,
  sunAltitudeDeg: number,
  temperatureK: number,
): number {
  return planeParallelRadianceWithAirMass(
    lambdaNm,
    Math.cos(scatteringAngleDeg(skyAngleDeg, sunAltitudeDeg) * DEG),
    airMassAtZenithAngle(Math.abs(skyAngleDeg)),
    airMassAtZenithAngle(sunSkyAngleDeg(sunAltitudeDeg)),
    temperatureK,
  );
}

// --- 球殻の単散乱 ----------------------------------------------------------------

/**
 * 行進した標本から分光放射輝度を組み立てる。
 *
 *   L₁(λ) = Σ_i exp(−[τ_R·totalR_i + τ_M·totalM_i])
 *              · ( τ_R·P_R(Θ)/4π·dR_i + τ_M·P_M(Θ)/4π·dM_i )
 *
 * 視線側と太陽側の柱密度は標本を作る時点で足してあるので、**波長あたりの指数は
 * 標本ひとつに 1 回**で済む。
 */
function radianceFromSamples(
  samples: readonly PathSample[],
  phaseRayleigh: number,
  phaseAerosol: number,
  tauRayleigh: number,
  tauAerosol: number,
): number {
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const transmittance = Math.exp(
      -(tauRayleigh * sample.totalRayleigh + tauAerosol * sample.totalAerosol),
    );
    total +=
      transmittance *
      (tauRayleigh * phaseRayleigh * sample.dRayleigh +
        tauAerosol * phaseAerosol * sample.dAerosol);
  }
  return total;
}

/**
 * 球殻・単散乱の分光放射輝度。1 点だけ知りたいとき用(毎回行進するので遅い)。
 * ページは `createSkyModel` の `samplerFor` を使う。
 */
export function sphericalRadiance(
  lambdaNm: number,
  skyAngleDeg: number,
  sunAltitudeDeg: number,
  temperatureK: number,
  aerosolOpticalDepth550 = 0,
  shape: AtmosphereShape = DEFAULT_SHAPE,
  viewSteps: number = VIEW_STEPS,
  sunSteps: number = SUN_STEPS,
): number {
  const cosTheta = Math.cos(scatteringAngleDeg(skyAngleDeg, sunAltitudeDeg) * DEG);
  const samples = viewPathSamples(skyAngleDeg, sunAltitudeDeg, shape, viewSteps, sunSteps);
  return (
    normalizedSpectrum(lambdaNm, temperatureK) *
    radianceFromSamples(
      samples,
      rayleighPhase(cosTheta) / (4 * Math.PI),
      henyeyGreenstein(cosTheta) / (4 * Math.PI),
      opticalDepthAt(lambdaNm),
      aerosolOpticalDepth(lambdaNm, aerosolOpticalDepth550),
    )
  );
}

// --- 多重散乱 ------------------------------------------------------------------

/**
 * ガウス・ルジャンドル求積の節点と重み(区間 [0, 1])。
 *
 * 節点は数表を書き写さず、ルジャンドル多項式の根をニュートン法で解いて求める
 * — ウィーンの根を解いているのと同じ理由で、出所が追えてテストで検算できる形にしたい。
 */
function gaussLegendre(n: number): { nodes: Float64Array; weights: Float64Array } {
  const nodes = new Float64Array(n);
  const weights = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    // 根のよい初期値(Abramowitz & Stegun の近似)。
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));

    for (let iteration = 0; iteration < 100; iteration += 1) {
      // 漸化式 (k+1)P_{k+1} = (2k+1)x·P_k − k·P_{k−1} で P_n と P_{n−1} を作る。
      let previous = 1;
      let current = x;
      for (let k = 1; k < n; k += 1) {
        const next = ((2 * k + 1) * x * current - k * previous) / (k + 1);
        previous = current;
        current = next;
      }
      const derivative = (n * (x * current - previous)) / (x * x - 1);
      const step = current / derivative;
      x -= step;
      if (Math.abs(step) < 1e-15) break;
    }

    let previous = 1;
    let current = x;
    for (let k = 1; k < n; k += 1) {
      const next = ((2 * k + 1) * x * current - k * previous) / (k + 1);
      previous = current;
      current = next;
    }
    const derivative = (n * (x * current - previous)) / (x * x - 1);

    // [-1, 1] から [0, 1] へ写す。
    nodes[i] = 0.5 * (1 - x);
    weights[i] = 1 / ((1 - x * x) * derivative * derivative);
  }

  return { nodes, weights };
}

/**
 * 半球のフラックス積分に使う節点数。
 *
 * μ → 0 の近くで exp(−τ/μ) が急に落ちるので、そこそこの数が要る。
 * 32 点あれば細かい中点則との差は 1e-4 以下(テストで確認している)。
 */
const QUADRATURE_NODES = 32;
const QUADRATURE = gaussLegendre(QUADRATURE_NODES);

export interface ScatteringBudget {
  /** 直達光から取り去られた全エネルギー(F₀ = 1 としたときの値)。 */
  readonly removed: number;
  /** 1 回だけ散乱されて下向きに抜けた分。 */
  readonly firstOrderDown: number;
  /** 同じく上向きに宇宙へ抜けた分。 */
  readonly firstOrderUp: number;
  /** 残り = 2 回以上散乱された光。 */
  readonly higherOrder: number;
}

const EMPTY_BUDGET: ScatteringBudget = {
  removed: 0,
  firstOrderDown: 0,
  firstOrderUp: 0,
  higherOrder: 0,
};

/**
 * 太陽高度を固定して、波長ごとの収支を繰り返し解くための器。
 *
 * 方位角平均した位相関数は波長に依らない(節点と μ₀ だけで決まる)ので、
 * ここで 1 度だけ作って使い回す。Henyey–Greenstein の方位角平均は閉じた形に
 * ならず数値積分が要るぶん、この巻き上げが効く。
 */
export function createBudgetSolver(
  sunAltitudeDeg: number,
): (tauRayleigh: number, tauAerosol: number) => ScatteringBudget {
  // cos(90 − h) ではなく sin(h) で書く。前者は h = 0 で 6.1e-17 という
  // 「ほぼ 0 だが 0 ではない」値を返し、下駄がきっちり 0 にならない。
  const mu0 = Math.sin(sunAltitudeDeg * DEG);
  if (!(mu0 > 0)) return () => EMPTY_BUDGET;

  const mSun = 1 / mu0;

  /**
   * 位相関数を下向き / 上向きで別々に持つ。
   *
   * 直達光は下へ進むので、**上向きに散乱される角度は cosΘ の符号が反転する**。
   * レイリーの ⟨P⟩ は μ の偶関数なので上下で同じ値になり、この区別は要らなかった。
   * Henyey–Greenstein は前方に偏っていて偶関数ではないので、上向きに前方散乱の
   * 値を使うと上へ抜ける分を大幅に過大評価し、収支の等式が破れる(実測した)。
   */
  const phaseRayleighDown = new Float64Array(QUADRATURE_NODES);
  const phaseRayleighUp = new Float64Array(QUADRATURE_NODES);
  const phaseAerosolDown = new Float64Array(QUADRATURE_NODES);
  const phaseAerosolUp = new Float64Array(QUADRATURE_NODES);
  for (let i = 0; i < QUADRATURE_NODES; i += 1) {
    const mu = QUADRATURE.nodes[i]!;
    phaseRayleighDown[i] = azimuthAveragedPhase(mu, mu0);
    phaseRayleighUp[i] = azimuthAveragedPhase(-mu, mu0);
    phaseAerosolDown[i] = azimuthAveragedHenyeyGreenstein(mu, mu0);
    phaseAerosolUp[i] = azimuthAveragedHenyeyGreenstein(-mu, mu0);
  }

  /**
   * 離散化した位相関数を、**この求積の上でちょうど 1 に**規格化し直す。
   *
   *   (1/2)∫₋₁¹ ⟨P⟩ dμ = 1
   *
   * 収支の等式が成り立つ条件は「位相関数が規格化されていること」だが、それは
   * 連続の話。前方に尖った Henyey–Greenstein は 32 点では解ききれず、離散版の
   * 積分が 1 からずれる。ずれたまま使うと E₂₊ が負に振れうるので、離散の世界でも
   * ちょうど 1 になるよう割り戻しておく(離散座標法で使われる標準的な処置)。
   */
  const discreteNorm = (down: Float64Array, up: Float64Array): number => {
    let total = 0;
    for (let i = 0; i < QUADRATURE_NODES; i += 1) {
      total += QUADRATURE.weights[i]! * (down[i]! + up[i]!);
    }
    return total / 2;
  };
  const normRayleigh = discreteNorm(phaseRayleighDown, phaseRayleighUp);
  const normAerosol = discreteNorm(phaseAerosolDown, phaseAerosolUp);

  return (tauRayleigh, tauAerosol) => {
    const tau = tauRayleigh + tauAerosol;
    if (!(tau > 0)) return EMPTY_BUDGET;

    // 2 種の位相関数を散乱寄与で重み付けして 1 本にまとめる。どちらも
    // ∫P dΩ/4π = 1 に規格化されているので、凸結合もまた規格化されたまま
    // — 収支の等式が厳密に成り立つ条件が保たれる。
    const weightRayleigh = tauRayleigh / tau;
    const weightAerosol = tauAerosol / tau;

    const removed = mu0 * -Math.expm1(-tau * mSun);

    let down = 0;
    let up = 0;
    for (let i = 0; i < QUADRATURE_NODES; i += 1) {
      const mu = QUADRATURE.nodes[i]!;
      const weight = QUADRATURE.weights[i]!;
      const mView = 1 / mu;
      const phaseDown =
        (weightRayleigh * (phaseRayleighDown[i]! / normRayleigh) +
          weightAerosol * (phaseAerosolDown[i]! / normAerosol)) /
        (4 * Math.PI);
      const phaseUp =
        (weightRayleigh * (phaseRayleighUp[i]! / normRayleigh) +
          weightAerosol * (phaseAerosolUp[i]! / normAerosol)) /
        (4 * Math.PI);

      // 下向き: 深さ t から地面まで (τ − t) の減衰。単散乱の式と同じ形。
      down += weight * mu * phaseDown * mView * pathIntegral(tau, mView, mSun);

      // 上向き: 深さ t から大気圏外まで t だけ戻るので、指数の符号が揃う。
      const sum = mSun + mView;
      up += weight * mu * phaseUp * (mView / sum) * -Math.expm1(-tau * sum);
    }

    const firstOrderDown = 2 * Math.PI * down;
    const firstOrderUp = 2 * Math.PI * up;
    // 求積の誤差でわずかに負へ振れることがあるので下限を置く(実測では 1e-12 未満)。
    const higherOrder = Math.max(0, removed - firstOrderDown - firstOrderUp);

    return { removed, firstOrderDown, firstOrderUp, higherOrder };
  };
}

/**
 * 光子の収支。保存散乱 (ω = 1) の平行平面大気では次が **厳密に成り立つ**:
 *
 *   E = E↓₁ + E↑₁ + E₂₊
 *
 * 直達光から取り去られたエネルギーは、すべて 1 次散乱で生成される。その光は
 * 下へ抜けるか、上へ抜けるか、もう一度散乱されるかのいずれかしかない。
 * したがって残差 E₂₊ が「2 回以上散乱された光」であり、構成上つねに 0 以上になる。
 *
 * **この計算だけは平行平面 (1/μ) のまま。**上の等式が厳密に成り立つのはその幾何の
 * 中だけだから(単散乱の表示は球殻の行進に移してある)。2 種の尺度高さが違うのを
 * 均質な 1 層に均してしまう、という近似がもうひとつ乗っている。
 *
 * 代償として、太陽高度が 0 以下では μ₀ ≤ 0 から E = 0 となり、多重散乱の見積もりも
 * 0 になる。**薄明の明るさの大半は実際には多重散乱**なので、ここがこのモデルの
 * 最も弱いところ。
 */
export function scatteringBudget(
  tauRayleigh: number,
  tauAerosol: number,
  sunAltitudeDeg: number,
): ScatteringBudget {
  return createBudgetSolver(sunAltitudeDeg)(tauRayleigh, tauAerosol);
}

/**
 * 等方な多重散乱成分 L_ms(λ)。視線方向に依らない。
 *
 * 置いている仮定はひとつだけ — **2 回以上散乱された光は等方で、上下に半分ずつ抜ける**。
 * 等方な放射輝度 L が水平面を通す下向きフラックスは πL なので:
 *
 *   L_ms = ½·E₂₊ / π
 */
export function multipleScatteringFloor(
  lambdaNm: number,
  sunAltitudeDeg: number,
  temperatureK: number,
  aerosolOpticalDepth550 = 0,
): number {
  const budget = scatteringBudget(
    opticalDepthAt(lambdaNm),
    aerosolOpticalDepth(lambdaNm, aerosolOpticalDepth550),
    sunAltitudeDeg,
  );
  return (normalizedSpectrum(lambdaNm, temperatureK) * budget.higherOrder) / (2 * Math.PI);
}

// --- τ(λ) のキャッシュ ------------------------------------------------------------

/**
 * 波長ごとの表(τ・入射スペクトル・多重散乱の下駄)を張る 1nm 格子。
 *
 * バックエンドが返す分光放射輝度の表もこの格子に載せる。Rust 実装も同じ格子を
 * 使うので、突き合わせるときに端点の解釈がずれない。
 */
export const SPECTRUM_TABLE_LAMBDA_MIN = SPECTRUM_OPTIONS.lambdaMin;
export const SPECTRUM_TABLE_LAMBDA_MAX = SPECTRUM_OPTIONS.lambdaMax;
export const SPECTRUM_TABLE_LENGTH =
  SPECTRUM_TABLE_LAMBDA_MAX - SPECTRUM_TABLE_LAMBDA_MIN + 1;

const TAU_LAMBDA_MIN = SPECTRUM_TABLE_LAMBDA_MIN;
const TAU_LAMBDA_MAX = SPECTRUM_TABLE_LAMBDA_MAX;

/**
 * レイリーの光学的厚さは波長だけで決まり、パラメータには依存しない。
 *
 * 帯の 1 標本ごとに全波長を舐めるので、屈折率とキング因子を毎回計算していると
 * ここが効いてくる。1nm 格子の上に一度だけ作っておく。
 */
const TAU_TABLE = ((): Float64Array => {
  const table = new Float64Array(TAU_LAMBDA_MAX - TAU_LAMBDA_MIN + 1);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = opticalDepth(TAU_LAMBDA_MIN + i);
  }
  return table;
})();

function tableIndex(lambdaNm: number): number {
  if (!Number.isInteger(lambdaNm)) return -1;
  const index = lambdaNm - TAU_LAMBDA_MIN;
  return index >= 0 && index < TAU_TABLE.length ? index : -1;
}

function opticalDepthAt(lambdaNm: number): number {
  const index = tableIndex(lambdaNm);
  return index < 0 ? opticalDepth(lambdaNm) : TAU_TABLE[index]!;
}

// --- 状態ごとのモデル -------------------------------------------------------------

export interface SkyModel {
  /**
   * ひとつの方向について「波長 → 分光放射輝度」の関数を作る。
   *
   * 方向を固定して波長を舐めるとき(スペクトル図・色の積分)はこちらを使う。
   * **球殻の行進をここで 1 度だけ済ませて閉じ込める**ので、`radianceAt` を
   * 波長ループから呼ぶのとは桁で速さが違う。
   */
  samplerFor(skyAngleDeg: number): (lambdaNm: number) => number;
  /** その方向・その波長の分光放射輝度。1 点だけ知りたいとき用。 */
  radianceAt(lambdaNm: number, skyAngleDeg: number): number;
  /** その方向の三刺激値。 */
  xyzAt(skyAngleDeg: number): XYZ;
  /** 天頂で、輝度 Y のうち多重散乱が占める割合 (0..1)。単散乱モードでは 0。 */
  multipleScatteringShare(): number;
}

/**
 * 状態(太陽高度・温度・散乱の次数・エアロゾル量)ごとに 1 つ作り、全方向で使い回す。
 *
 * 多重散乱の下駄も入射スペクトルも視線方向に依らないので、方向ごとに解き直すのは無駄。
 * 帯は 100 点以上を描くので、ここを分けておかないとスライダーの追従が落ちる。
 */
export function createSkyModel(conditions: SkyConditions): SkyModel {
  const { sunAltitudeDeg, temperatureK, multipleScattering } = conditions;
  const aod = Math.max(0, conditions.aerosolOpticalDepth);

  /**
   * 入射スペクトル F₀(λ) と エアロゾルの τ(λ) を、モデルの中で固定なので表に焼く。
   * 温度も AOD も方向には依らない。
   */
  const solar = new Float64Array(TAU_TABLE.length);
  const tauAerosol = new Float64Array(TAU_TABLE.length);
  for (let i = 0; i < solar.length; i += 1) {
    const lambdaNm = TAU_LAMBDA_MIN + i;
    solar[i] = normalizedSpectrum(lambdaNm, temperatureK);
    tauAerosol[i] = aerosolOpticalDepth(lambdaNm, aod);
  }

  const floor = multipleScattering
    ? ((): Float64Array => {
        const solve = createBudgetSolver(sunAltitudeDeg);
        const table = new Float64Array(TAU_TABLE.length);
        for (let i = 0; i < table.length; i += 1) {
          const budget = solve(TAU_TABLE[i]!, tauAerosol[i]!);
          table[i] = (solar[i]! * budget.higherOrder) / (2 * Math.PI);
        }
        return table;
      })()
    : null;

  const floorAt = (lambdaNm: number): number => {
    if (floor === null) return 0;
    const index = Math.round(lambdaNm) - TAU_LAMBDA_MIN;
    return index >= 0 && index < floor.length ? floor[index]! : 0;
  };

  const samplerFor = (skyAngleDeg: number): ((lambdaNm: number) => number) => {
    const cosTheta = Math.cos(scatteringAngleDeg(skyAngleDeg, sunAltitudeDeg) * DEG);
    const phaseRayleigh = rayleighPhase(cosTheta) / (4 * Math.PI);
    const phaseAerosol = henyeyGreenstein(cosTheta) / (4 * Math.PI);
    // 球殻の行進はここで 1 度だけ。以降の波長ループは指数関数しか回さない。
    const samples = viewPathSamples(skyAngleDeg, sunAltitudeDeg);

    return (lambdaNm) => {
      const index = tableIndex(lambdaNm);
      const tauR = index < 0 ? opticalDepth(lambdaNm) : TAU_TABLE[index]!;
      const tauM = index < 0 ? aerosolOpticalDepth(lambdaNm, aod) : tauAerosol[index]!;
      const f0 = index < 0 ? normalizedSpectrum(lambdaNm, temperatureK) : solar[index]!;

      const single =
        f0 * radianceFromSamples(samples, phaseRayleigh, phaseAerosol, tauR, tauM);
      return floor === null || index < 0 ? single + floorAt(lambdaNm) : single + floor[index]!;
    };
  };

  const xyzAt = (skyAngleDeg: number): XYZ =>
    spectrumToXYZ(samplerFor(skyAngleDeg), SPECTRUM_OPTIONS);

  return {
    samplerFor,
    radianceAt: (lambdaNm, skyAngleDeg) => samplerFor(skyAngleDeg)(lambdaNm),
    xyzAt,
    multipleScatteringShare(): number {
      if (floor === null) return 0;
      const total = xyzAt(0)[1];
      if (!(total > 0)) return 0;
      return spectrumToXYZ(floorAt, SPECTRUM_OPTIONS)[1] / total;
    },
  };
}
