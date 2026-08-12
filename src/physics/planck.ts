/**
 * プランクの法則と、そこから導かれる量。
 *
 * DOM に依存しない純粋な数値コード。定数はできる限りベタ書きせず、
 * SI の定義値から導出する — sRGB の変換行列を規格の原色から導出しているのと
 * 同じ理由で、出所が追えてテストで検算できる形にしたいため。
 *
 * もとは黒体放射ページの中にあった。レイリー散乱ページが黒体を光源として
 * 選べるようになり 2 人目の利用者が現れたので、src/physics/ へ上げてある。
 */

import { spectrumToXYZ, type XYZ } from '../color/index.ts';

// --- SI 定義値 ----------------------------------------------------------------
// 2019 年の SI 改定以降、この 3 つはいずれも定義値(誤差を持たない)。

/** プランク定数 h [J·s]。 */
export const PLANCK_CONSTANT = 6.62607015e-34;
/** 真空中の光速 c [m/s]。 */
export const SPEED_OF_LIGHT = 299792458;
/** ボルツマン定数 k [J/K]。 */
export const BOLTZMANN_CONSTANT = 1.380649e-23;

/**
 * 最大視感効果度 K_m [lm/W]。
 *
 * 測光量と放射量を結ぶ換算係数で、「V(λ) = 1 の単色光 1W が 683lm に相当する」
 * という定義から来る。厳密には 540THz (≈555.016nm) を基準とするが、等色関数
 * テーブルの ȳ は 555nm でちょうど 1.0 を取る(生成スクリプトが検証済み)ので、
 * ここでは ȳ をそのまま V(λ) として扱う。
 */
export const LUMINOUS_EFFICACY_MAX = 683;

// --- 導出定数 ------------------------------------------------------------------

/** 第一放射定数(分光放射輝度用) c₁L = 2hc² [W·m²·sr⁻¹]。 */
const C1L = 2 * PLANCK_CONSTANT * SPEED_OF_LIGHT ** 2;

/** 第二放射定数 c₂ = hc/k [m·K]。 */
const C2 = (PLANCK_CONSTANT * SPEED_OF_LIGHT) / BOLTZMANN_CONSTANT;

/** シュテファン・ボルツマン定数 σ = 2π⁵k⁴/(15h³c²) [W·m⁻²·K⁻⁴]。 */
export const STEFAN_BOLTZMANN =
  (2 * Math.PI ** 5 * BOLTZMANN_CONSTANT ** 4) /
  (15 * PLANCK_CONSTANT ** 3 * SPEED_OF_LIGHT ** 2);

/**
 * dB_λ/dλ = 0 から出る超越方程式 x = 5(1 − e⁻ˣ) の根 (≈ 4.965114)。
 *
 * f(x) = x − 5 + 5e⁻ˣ にニュートン法をかける。x = 5 から始めれば数回で収束する
 * (x = 0 も自明な根だが、そちらへ落ちない程度には離れている)。
 */
function solveWienRoot(): number {
  let x = 5;
  for (let i = 0; i < 40; i += 1) {
    const e = Math.exp(-x);
    const next = x - (x - 5 + 5 * e) / (1 - 5 * e);
    if (Math.abs(next - x) < 1e-15) return next;
    x = next;
  }
  return x;
}

export const WIEN_ROOT = solveWienRoot();

/** ウィーンの変位定数 b = c₂/x [m·K]。 */
export const WIEN_DISPLACEMENT = C2 / WIEN_ROOT;

// --- プランクの法則 -------------------------------------------------------------

/**
 * 分光放射輝度 B_λ(λ, T) [W·sr⁻¹·m⁻²·nm⁻¹]。
 *
 *   B_λ = (2hc²/λ⁵) / (exp(hc/(λkT)) − 1)
 *
 * 内部は SI(λ は m)で計算し、最後に nm 当たりへ直す。
 */
export function spectralRadiance(lambdaNm: number, temperatureK: number): number {
  if (!(lambdaNm > 0) || !(temperatureK > 0)) return 0;

  const lambda = lambdaNm * 1e-9;
  const x = C2 / (lambda * temperatureK);

  // expm1 を使うのは長波長側のため。x が小さいとき exp(x) - 1 は桁落ちし、
  // レイリー・ジーンズ極限 2ckT/λ⁴ が出なくなる。
  //
  // 逆に短波長・低温では x が数万に達して expm1 が Infinity を返すが、
  // 有限値 / Infinity は 0 になるので NaN にはならない。可視域まで届かないほど
  // 冷たい黒体を素直に 0 と答える、という意味で結果も正しい。
  return C1L / (lambda ** 5 * Math.expm1(x)) / 1e9;
}

/** ウィーンの変位則 λmax = b/T [nm]。 */
export function peakWavelengthNm(temperatureK: number): number {
  return (WIEN_DISPLACEMENT / temperatureK) * 1e9;
}

/** 放射発散度 M = σT⁴ [W/m²]。半球全体へ放射する総量。 */
export function radiantExitance(temperatureK: number): number {
  return STEFAN_BOLTZMANN * temperatureK ** 4;
}

/**
 * 全波長にわたる放射輝度 ∫B_λ dλ = σT⁴/π [W·sr⁻¹·m⁻²]。
 *
 * 放射発散度を π で割る形になるのは、ランバート面からの放射を半球で
 * 積分すると立体角 2π ではなく π が出るため(cos θ の寄与)。
 */
export function totalRadiance(temperatureK: number): number {
  return radiantExitance(temperatureK) / Math.PI;
}

/**
 * 全波長にわたる積分が 1 になるよう正規化した分光分布 [nm⁻¹]。
 *
 * このページで温度を変えたときに揃える量。「放射の総量が同じ黒体どうしを比べる」
 * ことになるので、明るさの違いはそのまま「放射のうちどれだけが可視域に落ちるか」
 * の違いを表す。総量は解析的に分かっている(σT⁴/π)ので数値積分は要らない。
 */
export function normalizedSpectrum(lambdaNm: number, temperatureK: number): number {
  return spectralRadiance(lambdaNm, temperatureK) / totalRadiance(temperatureK);
}

/**
 * 正規化した分光分布を等色関数で積分した三刺激値。
 *
 * 連続スペクトルなので `spectrumToXYZ` の積分をそのまま使う。積分範囲は
 * 等色関数テーブルの全域(360–830nm)で、その外側は等色関数が 0 なので寄与しない。
 */
export function blackbodyXYZ(temperatureK: number): XYZ {
  return spectrumToXYZ((lambdaNm) => normalizedSpectrum(lambdaNm, temperatureK));
}

/**
 * 発光効率 [lm/W]。放射 1W あたり何ルーメンの光になるか。
 *
 * ∫B̂ dλ = 1 に正規化してあるので Y は「放射のうち視覚に届く割合」そのものであり、
 * 効率は K_m·Y で求まる。黒体では約 6600K で最大となり、それでも 95 lm/W ほど
 * — つまり理想的な黒体ですら、放射の 86% は目に見えない形で出ていく。
 */
export function luminousEfficacy(temperatureK: number): number {
  return LUMINOUS_EFFICACY_MAX * blackbodyXYZ(temperatureK)[1];
}
