import { describe, expect, it } from 'vitest';
import { HORIZON_AIR_MASS } from '../../physics/air-mass.ts';
import { AIR_MASS_STEP, clampAirMass, MAX_AIR_MASS, MIN_AIR_MASS } from './air-mass.ts';

describe('air mass の軸', () => {
  it('上限が地平線の値を刻みに丸めたものになる', () => {
    expect(MAX_AIR_MASS).toBe(Math.round(HORIZON_AIR_MASS * 10) / 10);
    expect(MAX_AIR_MASS).toBe(37.9);
  });

  it('範囲外の入力は端に、途中の値は刻みに丸められる', () => {
    expect(clampAirMass(-5)).toBe(MIN_AIR_MASS);
    expect(clampAirMass(1e6)).toBe(MAX_AIR_MASS);
    expect(clampAirMass(1.53)).toBe(1.5);
    expect(clampAirMass(1.57)).toBe(1.6);
  });

  /** 2 進小数の誤差が表示に漏れないこと(1.2000000000000002 のような値を出さない)。 */
  it('丸めた値が刻みの整数倍として厳密に表せる', () => {
    for (let i = 0; i <= 380; i += 1) {
      const value = clampAirMass(i * AIR_MASS_STEP);
      expect(String(value).split('.')[1]?.length ?? 0, `i=${i}`).toBeLessThanOrEqual(1);
    }
  });
});
