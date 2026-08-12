/**
 * air mass — 光が大気を通る距離を、天頂方向の 1 回分を単位として測ったもの。
 *
 * DOM に依存しない純粋な数値コード。レイリー散乱ページと空の色ページが使う。
 */

/**
 * 天頂角から air mass を求める(Kasten & Young 1989 の経験式)。
 *
 *   m = 1 / (cos z + 0.50572 (96.07995 − z)^−1.6364),  z は度
 *
 * 単純な 1/cos z は地平線で発散してしまう。地球が丸いこと(と大気による屈折)で
 * 実際には有限に留まり、この式はその測定結果に合わせてある。
 */
export function airMassAtZenithAngle(zenithDeg: number): number {
  const radians = (zenithDeg * Math.PI) / 180;
  return 1 / (Math.cos(radians) + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}

/** 太陽が地平線にあるときの値 ≈ 37.92。手で書かず経験式から取る。 */
export const HORIZON_AIR_MASS = airMassAtZenithAngle(90);
