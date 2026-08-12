/**
 * air mass の軸。
 *
 * 黒体放射ページの temperature-axis.ts と同じ立ち位置で、物理そのものではなく
 * 「スライダーの目盛りをどう刻むか」を決める側。air mass の定義そのものは
 * src/physics/air-mass.ts にある(空の色ページと共有している)。
 */

import { HORIZON_AIR_MASS } from '../../physics/air-mass.ts';

/** 大気圏外。減衰なしの基準として端に置く。 */
export const MIN_AIR_MASS = 0;

/** 太陽が地平線にあるときの値 ≈ 37.9。手で書かず経験式から取る。 */
export const MAX_AIR_MASS = Math.round(HORIZON_AIR_MASS * 10) / 10;

/** 入力の刻み。スライダーも数値入力もこの単位で動く。 */
export const AIR_MASS_STEP = 0.1;

/**
 * スライダーの分割数。
 *
 * 軸は線形に取る。黒体ページが 1/T の逆数目盛を採ったのとは逆の判断で、理由がある —
 * 色相のずれは log T(λ₁) − log T(λ₂) = m·(τ(λ₂) − τ(λ₁)) すなわち m に比例するので、
 * 線形の軸のままスライダーを動かすと色がほぼ等速で変わっていく。
 */
export const SLIDER_STEPS = Math.round(MAX_AIR_MASS / AIR_MASS_STEP);

/** 入力を扱える範囲の 0.1 刻みに収める。 */
export function clampAirMass(value: number): number {
  const stepped = Math.round(value / AIR_MASS_STEP) * AIR_MASS_STEP;
  const clamped = Math.min(MAX_AIR_MASS, Math.max(MIN_AIR_MASS, stepped));
  // 0.1 刻みは 2 進小数で表せないので、丸めておかないと 1.2000000000000002 が出る。
  return Math.round(clamped * 10) / 10;
}
