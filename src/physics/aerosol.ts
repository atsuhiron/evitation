/**
 * エアロゾル(Mie 散乱)。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * レイリー散乱は前方と後方が等しく、波長の −4 乗で効いた。エアロゾルはどちらも違う:
 *
 * - **強く前方に偏る**(g = 0.76 で前方 30.6、後方 0.078 と 390 倍の差)。
 *   これが太陽の周りだけを白く光らせる正体で、実際の空が計算より白っぽい理由の大半
 * - **波長依存が弱い**(Ångström 指数 α ≈ 1.3、レイリーの 4.08 に対して)。
 *   だから色をあまり選ばず、白っぽいまま散乱する
 *
 * 粒径分布から Mie 理論を解くのが本筋だが、粒径分布そのものが場所と天候で
 * 桁で変わる量なので、ここでは観測から決まる 2 つの経験パラメータ
 * (Ångström 指数と非対称因子)で代表させる。
 */

/**
 * Ångström 指数 α。大陸性エアロゾルの代表値。
 * 粒径が大きいほど小さくなり、砂塵では 0 近く、細かい煙霧では 2 に近づく。
 */
export const ANGSTROM_EXPONENT = 1.3;

/**
 * Henyey–Greenstein の非対称因子 g = ⟨cosΘ⟩。
 * 1 に近いほど前方に尖る。大気のエアロゾルでは 0.6–0.8 が使われる。
 */
export const AEROSOL_ASYMMETRY = 0.76;

/** 光学的厚さを指定する基準波長 [nm]。 */
export const AEROSOL_REFERENCE_LAMBDA_NM = 550;

/** エアロゾルの尺度高さ [m]。定義は atmosphere.ts と共有している。 */
export const DEFAULT_AEROSOL_OPTICAL_DEPTH = 0.1;

/**
 * Ångström の式による光学的厚さ。
 *
 *   τ_a(λ) = τ_a(550) · (λ/550)^−α
 *
 * 基準は 550nm。この 1 点の値(AOD)が「どれだけかすんでいるか」を表す量で、
 * 澄んだ日で 0.05 前後、都市の霞んだ日で 0.3 を超える。
 */
export function aerosolOpticalDepth(
  lambdaNm: number,
  opticalDepth550: number,
  angstromExponent: number = ANGSTROM_EXPONENT,
): number {
  if (!(opticalDepth550 > 0) || !(lambdaNm > 0)) return 0;
  return opticalDepth550 * (lambdaNm / AEROSOL_REFERENCE_LAMBDA_NM) ** -angstromExponent;
}

/**
 * Henyey–Greenstein 位相関数。
 *
 *   P(Θ) = (1 − g²) / (1 + g² − 2g·cosΘ)^{3/2}
 *
 * ∫P dΩ/4π = 1 に規格化されている(レイリー位相関数と同じ約束)。
 * Mie 理論の厳密解ではなく、前方への偏りだけを 1 つのパラメータで真似た当てはめ式。
 * 虹角やグローリーのような角度構造は再現しないが、空の明るさの分布にはそれで足りる。
 */
export function henyeyGreenstein(cosTheta: number, g: number = AEROSOL_ASYMMETRY): number {
  const denominator = 1 + g * g - 2 * g * cosTheta;
  return (1 - g * g) / (denominator * Math.sqrt(denominator));
}
