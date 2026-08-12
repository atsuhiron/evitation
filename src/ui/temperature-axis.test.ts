import { describe, expect, it } from 'vitest';
import {
  clampTemperature,
  MAX_TEMPERATURE_K,
  MIN_TEMPERATURE_K,
  positionToTemperature,
  temperatureToPosition,
} from './temperature-axis.ts';

describe('温度軸', () => {
  it('位置と温度が往復する', () => {
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      expect(temperatureToPosition(positionToTemperature(t)), `t=${t}`).toBeCloseTo(t, 12);
    }
  });

  it('両端が範囲の両端に一致する', () => {
    expect(positionToTemperature(0)).toBeCloseTo(MIN_TEMPERATURE_K, 9);
    expect(positionToTemperature(1)).toBeCloseTo(MAX_TEMPERATURE_K, 9);
  });

  /**
   * 逆数目盛にした狙いそのもの。温度で等分すると 1000–4000K は全体の 16% しか
   * 取れないが、1/T で並べれば半分以上を占める。
   */
  it('1000–4000K が帯の半分以上を占める', () => {
    expect(temperatureToPosition(4000)).toBeGreaterThan(0.5);
  });

  it('範囲外の入力は端に丸められる', () => {
    expect(clampTemperature(0)).toBe(MIN_TEMPERATURE_K);
    expect(clampTemperature(1e9)).toBe(MAX_TEMPERATURE_K);
    expect(clampTemperature(5777.6)).toBe(5778);
  });
});
