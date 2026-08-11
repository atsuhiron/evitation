/**
 * 温度軸の取り方。
 *
 * 物理そのものではなく「スライダーと色温度帯の目盛りをどう刻むか」という
 * 表示側の都合なので planck.ts とは分けてある。
 */

/** UI で扱う温度範囲。下端は物が赤熱して見え始めるあたり、上端は青い星の域。 */
export const MIN_TEMPERATURE_K = 1000;
export const MAX_TEMPERATURE_K = 20000;

/**
 * スライダーの分割数。1 目盛りあたり約 0.95 ミレッド、
 * 温度にすると 1000K 付近で約 1K、20000K 付近で約 380K の刻みになる。
 */
export const SLIDER_STEPS = 1000;

const MIRED_AT_MIN = 1e6 / MIN_TEMPERATURE_K;
const MIRED_AT_MAX = 1e6 / MAX_TEMPERATURE_K;

/**
 * 位置 t (0..1) → 温度 [K]。
 *
 * 温度そのものではなく 1/T について線形に配置する。1000–20000K を温度で等分すると、
 * 色が最も激しく動く 1000–4000K が全体の 16% に潰れてしまう。色の変化がほぼ 1/T に
 * 比例することは、写真の分野で色温度の差をミレッド (10⁶/T) で測る理由でもある。
 *
 * 左端を低温にしたいので、ミレッドは降順に取る。
 */
export function positionToTemperature(t: number): number {
  const mired = MIRED_AT_MIN + (MIRED_AT_MAX - MIRED_AT_MIN) * t;
  return 1e6 / mired;
}

/** 温度 [K] → 位置 t (0..1)。`positionToTemperature` の逆関数。 */
export function temperatureToPosition(temperatureK: number): number {
  const mired = 1e6 / temperatureK;
  return (mired - MIRED_AT_MIN) / (MIRED_AT_MAX - MIRED_AT_MIN);
}

/** 入力を扱える範囲の整数 K に収める。 */
export function clampTemperature(value: number): number {
  return Math.min(MAX_TEMPERATURE_K, Math.max(MIN_TEMPERATURE_K, Math.round(value)));
}
