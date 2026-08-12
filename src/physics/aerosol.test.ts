import { describe, expect, it } from 'vitest';
import {
  aerosolOpticalDepth,
  ANGSTROM_EXPONENT,
  AEROSOL_ASYMMETRY,
  henyeyGreenstein,
} from './aerosol.ts';
import { opticalDepth } from './rayleigh.ts';

describe('Henyey–Greenstein 位相関数', () => {
  /** レイリー位相関数と同じ約束(∫P dΩ/4π = 1)に乗っていること。 */
  it.each([0, 0.3, 0.76, 0.9])('g=%s: 全立体角で積分すると 1', (g) => {
    const steps = 200000;
    let total = 0;
    for (let i = 0; i < steps; i += 1) {
      const cosTheta = -1 + (2 * (i + 0.5)) / steps;
      total += henyeyGreenstein(cosTheta, g) * (2 / steps);
    }
    expect(total / 2).toBeCloseTo(1, 4);
  });

  it('g = 0 なら等方(どの角度でも 1)', () => {
    for (const cosTheta of [-1, -0.5, 0, 0.5, 1]) {
      expect(henyeyGreenstein(cosTheta, 0), `cos=${cosTheta}`).toBeCloseTo(1, 12);
    }
  });

  /**
   * これがエアロゾルの本質。レイリーは前方も後方も 1.5 で対称だったが、
   * こちらは 390 倍の差がある。太陽の周りだけが白く光るのはこのため。
   */
  it('既定の g で前方が後方の 390 倍ほど', () => {
    const forward = henyeyGreenstein(1, AEROSOL_ASYMMETRY);
    const backward = henyeyGreenstein(-1, AEROSOL_ASYMMETRY);
    expect(forward).toBeCloseTo(30.6, 1);
    expect(backward).toBeCloseTo(0.0775, 4);
    expect(forward / backward).toBeGreaterThan(350);
    expect(forward / backward).toBeLessThan(430);
  });

  it('g が大きいほど前方後方比が大きい', () => {
    let previous = 0;
    for (const g of [0, 0.2, 0.4, 0.6, 0.8]) {
      const ratio = henyeyGreenstein(1, g) / henyeyGreenstein(-1, g);
      expect(ratio, `g=${g}`).toBeGreaterThan(previous);
      previous = ratio;
    }
  });

  it('散乱角に対して単調減少(前方が最大、後方が最小)', () => {
    let previous = Infinity;
    for (let thetaDeg = 0; thetaDeg <= 180; thetaDeg += 2) {
      const value = henyeyGreenstein(Math.cos((thetaDeg * Math.PI) / 180));
      expect(value, `${thetaDeg}°`).toBeLessThan(previous);
      previous = value;
    }
  });
});

describe('Ångström の式', () => {
  it('基準波長では指定した値そのもの', () => {
    expect(aerosolOpticalDepth(550, 0.1)).toBeCloseTo(0.1, 12);
    expect(aerosolOpticalDepth(550, 0.37)).toBeCloseTo(0.37, 12);
  });

  it('波長比のべきが Ångström 指数になる', () => {
    const ratio = aerosolOpticalDepth(400, 0.1) / aerosolOpticalDepth(700, 0.1);
    expect(ratio).toBeCloseTo((700 / 400) ** ANGSTROM_EXPONENT, 10);
  });

  /**
   * レイリー(実効 4.08 乗)よりずっと波長に鈍い。だからエアロゾルの散乱は
   * 色を選ばず、白っぽいまま散らす。
   */
  it('レイリーより波長依存が弱い', () => {
    const aerosolRatio = aerosolOpticalDepth(400, 0.1) / aerosolOpticalDepth(700, 0.1);
    const rayleighRatio = opticalDepth(400) / opticalDepth(700);
    expect(aerosolRatio).toBeLessThan(rayleighRatio);
    expect(aerosolRatio).toBeCloseTo(2.09, 1);
    expect(rayleighRatio).toBeGreaterThan(9);
  });

  it('量が 0 なら全波長で 0', () => {
    for (const lambdaNm of [380, 550, 780]) {
      expect(aerosolOpticalDepth(lambdaNm, 0), `${lambdaNm}nm`).toBe(0);
    }
  });
});
