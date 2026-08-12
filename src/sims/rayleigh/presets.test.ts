import { describe, expect, it } from 'vitest';
import { transmittance } from '../../physics/rayleigh.ts';
import { airMassAtZenithAngle, clampAirMass, MAX_AIR_MASS, MIN_AIR_MASS } from './air-mass.ts';
import { presets } from './presets.ts';

/** air mass から天頂角を逆に求める(単調なので二分法で足りる)。 */
function zenithAngleAt(airMass: number): number {
  let lo = 0;
  let hi = 90;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (airMassAtZenithAngle(mid) < airMass) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('プリセット', () => {
  it.each(presets.map((p) => [p.name, p] as const))('%s: 値が範囲内で刻みに乗る', (_name, preset) => {
    expect(preset.airMass).toBeGreaterThanOrEqual(MIN_AIR_MASS);
    expect(preset.airMass).toBeLessThanOrEqual(MAX_AIR_MASS);
    expect(clampAirMass(preset.airMass)).toBe(preset.airMass);
  });

  it('地平線のラベルに書いた値と実際の値が一致する', () => {
    const preset = presets.find((p) => p.name.startsWith('地平線'));
    expect(preset?.name).toContain(String(MAX_AIR_MASS));
    expect(preset?.airMass).toBe(MAX_AIR_MASS);
  });

  /**
   * ヒントに書いた太陽の位置が、その air mass から実際に逆算できる角度と合っていること。
   * 文章と中身がずれると、このページで最も伝えたい「AM がどれくらいの高さか」が
   * 誤情報になる。
   */
  /**
   * AM1.5 という規格の名前は単純な m = 1/cos z の定義から来ており、
   * 対応する天頂角は arccos(1/1.5) = 48.19°。Kasten–Young で解くと 48.26° で、
   * 差の 0.07° が地球の曲率と屈折の補正分にあたる。ヒントの「48.2°」は
   * 規格側の値で、どちらで読んでも小数第 1 位までは一致する。
   */
  it('AM 1.5 のヒントに書いた天頂角 48.2° が正しい', () => {
    expect((Math.acos(1 / 1.5) * 180) / Math.PI).toBeCloseTo(48.2, 1);
    expect(zenithAngleAt(1.5) - (Math.acos(1 / 1.5) * 180) / Math.PI).toBeLessThan(0.1);
  });

  it('AM 5 のヒントに書いた太陽高度 11° が正しい', () => {
    expect(90 - zenithAngleAt(5)).toBeCloseTo(11, 0);
  });

  /** 「400nm の光は 3 割が失われる」「青は元の 3 分の 1」という主張の裏取り。 */
  it('AM 1 で 400nm の透過率が 7 割ほど', () => {
    expect(transmittance(400, 1)).toBeGreaterThan(0.65);
    expect(transmittance(400, 1)).toBeLessThan(0.75);
  });

  it('AM 5 で 450nm の透過率が 3 分の 1 ほど', () => {
    expect(transmittance(450, 5)).toBeGreaterThan(0.28);
    expect(transmittance(450, 5)).toBeLessThan(0.4);
  });
});
