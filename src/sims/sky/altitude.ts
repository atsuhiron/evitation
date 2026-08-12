/**
 * 太陽高度の軸。
 *
 * 黒体ページの temperature-axis.ts、レイリーページの air-mass.ts と同じ立ち位置で、
 * 物理そのものではなくスライダーの刻み方を決める側。
 */

/**
 * 下限は天文薄明の終わり。
 *
 * 太陽が −18° まで沈むと、上層大気も地球の影に入って空はほぼ夜になる。
 * 大気を球殻として扱い地球の影を入れているので、地平線下も意味のある範囲になった
 * (平行平面では太陽が沈んだ瞬間に空が真っ黒になるだけで、扱う意味がなかった)。
 */
export const MIN_ALTITUDE_DEG = -18;
export const MAX_ALTITUDE_DEG = 90;

/** 入力の刻み。 */
export const ALTITUDE_STEP_DEG = 0.1;

/**
 * スライダーの分割数。
 *
 * 軸は素直に線形。黒体ページは 1/T、レイリーページは air mass を線形に取ったが、
 * ここで線形にする理由は違う — 太陽高度は人が直接目にできる量で、色の変化に
 * 合わせた確立した代替尺度もないから。
 *
 * ただし色が動くのは地平線の上下 10° に集中する。その偏りは隠さず、プリセットで拾う。
 */
export const SLIDER_STEPS = Math.round((MAX_ALTITUDE_DEG - MIN_ALTITUDE_DEG) / ALTITUDE_STEP_DEG);

/** スライダーの位置 (0..SLIDER_STEPS) を高度に直す。 */
export function positionToAltitude(position: number): number {
  return clampAltitude(MIN_ALTITUDE_DEG + position * ALTITUDE_STEP_DEG);
}

/** 高度をスライダーの位置に直す。 */
export function altitudeToPosition(altitudeDeg: number): number {
  return Math.round((altitudeDeg - MIN_ALTITUDE_DEG) / ALTITUDE_STEP_DEG);
}

/** 入力を扱える範囲の 0.1° 刻みに収める。 */
export function clampAltitude(value: number): number {
  const stepped = Math.round(value / ALTITUDE_STEP_DEG) * ALTITUDE_STEP_DEG;
  const clamped = Math.min(MAX_ALTITUDE_DEG, Math.max(MIN_ALTITUDE_DEG, stepped));
  // 0.1 刻みは 2 進小数で表せないので、丸めておかないと 1.2000000000000002 が出る。
  return Math.round(clamped * 10) / 10;
}
