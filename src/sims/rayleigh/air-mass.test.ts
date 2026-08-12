import { describe, expect, it } from 'vitest';
import {
  AIR_MASS_STEP,
  airMassAtZenithAngle,
  clampAirMass,
  MAX_AIR_MASS,
  MIN_AIR_MASS,
} from './air-mass.ts';

describe('air mass の軸', () => {
  it('天頂で 1、天頂角 60° で約 2、地平線で約 37.9', () => {
    expect(airMassAtZenithAngle(0)).toBeCloseTo(1, 3);
    expect(airMassAtZenithAngle(60)).toBeCloseTo(2, 1);
    expect(airMassAtZenithAngle(90)).toBeCloseTo(37.9, 1);
  });

  /** 太陽電池の標準条件 AM1.5 に対応する天頂角は 48.19°。 */
  it('天頂角 48.19° が AM 1.5 に対応する', () => {
    expect(airMassAtZenithAngle(48.19)).toBeCloseTo(1.5, 2);
  });

  it('天頂角に対して単調増加', () => {
    let previous = -Infinity;
    for (let zenithDeg = 0; zenithDeg <= 90; zenithDeg += 1) {
      const airMass = airMassAtZenithAngle(zenithDeg);
      expect(airMass, `${zenithDeg}°`).toBeGreaterThan(previous);
      previous = airMass;
    }
  });

  /**
   * 単純な 1/cos z なら地平線で発散する。有限に留まることが、この式を使っている
   * 理由そのもの(地球が丸いことと大気による屈折を織り込んである)。
   */
  it('地平線でも有限に留まる', () => {
    expect(Number.isFinite(MAX_AIR_MASS)).toBe(true);
    expect(MAX_AIR_MASS).toBeLessThan(50);
    expect(MAX_AIR_MASS).toBeGreaterThan(30);
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
