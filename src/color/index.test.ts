import { describe, expect, it } from 'vitest';
import {
  relativeLuminance,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  wavelengthToColor,
  xyzToDisplayColor,
} from './index.ts';

/** 可視域の全波長(1nm 刻み)。 */
function visibleWavelengths(): number[] {
  const out: number[] = [];
  for (let l = VISIBLE_LAMBDA_MIN; l <= VISIBLE_LAMBDA_MAX; l += 1) out.push(l);
  return out;
}

describe('wavelengthToColor: 可視域全体の健全性', () => {
  it('linear RGB が 0..1 に収まり、NaN が出ない', () => {
    for (const mode of ['max', 'luminance'] as const) {
      for (const lambda of visibleWavelengths()) {
        const { linearRGB } = wavelengthToColor(lambda, mode);
        for (const c of linearRGB) {
          expect(Number.isFinite(c), `${lambda}nm (${mode})`).toBe(true);
          expect(c, `${lambda}nm (${mode})`).toBeGreaterThanOrEqual(0);
          expect(c, `${lambda}nm (${mode})`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('rgb8 が 0..255 の整数', () => {
    for (const lambda of visibleWavelengths()) {
      for (const c of wavelengthToColor(lambda).rgb8) {
        expect(Number.isInteger(c), `${lambda}nm`).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });

  it('HEX が 6 桁の形式になっている', () => {
    for (const lambda of visibleWavelengths()) {
      expect(wavelengthToColor(lambda).hex).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  // スペクトル軌跡は sRGB の三角形の外側を通るので、単色光はほぼ全て色域外になる。
  // ここが false ばかりになったら色域判定が働いていない。
  it('可視域のほぼ全ての波長が sRGB 色域外と判定される', () => {
    const all = visibleWavelengths();
    const outside = all.filter((l) => wavelengthToColor(l).outOfGamut);
    expect(outside.length / all.length).toBeGreaterThan(0.95);
  });
});

describe('wavelengthToColor: 色相', () => {
  const dominant = (lambda: number): 'R' | 'G' | 'B' => {
    const [r, g, b] = wavelengthToColor(lambda).rgb8;
    if (r >= g && r >= b) return 'R';
    return g >= b ? 'G' : 'B';
  };

  it.each([
    [450, 'B'],
    [470, 'B'],
    [510, 'G'],
    [530, 'G'],
    [650, 'R'],
    [700, 'R'],
  ])('%dnm の主成分は %s', (lambda, expected) => {
    expect(dominant(lambda)).toBe(expected);
  });

  it('580nm は黄色: R と G が高く B が低い', () => {
    const [r, g, b] = wavelengthToColor(580).rgb8;
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(g!);
  });

  // ナトリウム D 線。黄色よりわずかに赤寄りになるはず。
  it('589nm(ナトリウム D 線)は 580nm より赤寄り', () => {
    const na = wavelengthToColor(589).rgb8;
    const yellow = wavelengthToColor(580).rgb8;
    expect(na[1] / na[0]).toBeLessThan(yellow[1] / yellow[0]);
  });

  /**
   * 変換全体に不連続点が無いことの確認。
   *
   * 「隣り合う波長で N 以上変わらない」という形にすると、変化の速さを見ているだけで
   * 連続性の検査にはならない。実際 549–551nm(緑から黄への遷移)や 464–466nm
   * (色域マッピングで負になる成分が G から R へ入れ替わる点)では 1nm あたり
   * 8bit で 40 以上動くが、これらはいずれも連続な急変化にすぎない。
   *
   * そこで刻みを 1/4 にしたときに段差も相応に小さくなることを見る。
   * 本物の不連続があれば、刻みを細かくしても段差は縮まらない。
   */
  const maxStepChange = (stepNm: number): number => {
    let previous = wavelengthToColor(VISIBLE_LAMBDA_MIN).rgb8;
    let worst = 0;
    for (let l = VISIBLE_LAMBDA_MIN + stepNm; l <= VISIBLE_LAMBDA_MAX; l += stepNm) {
      const current = wavelengthToColor(l).rgb8;
      worst = Math.max(
        worst,
        Math.abs(current[0] - previous[0]),
        Math.abs(current[1] - previous[1]),
        Math.abs(current[2] - previous[2]),
      );
      previous = current;
    }
    return worst;
  };

  it('不連続点が無い(刻みを細かくすると段差も小さくなる)', () => {
    const coarse = maxStepChange(1);
    const fine = maxStepChange(0.25);
    expect(fine).toBeLessThan(coarse * 0.4);
  });

  it('1nm 刻みでの変化が 8bit で 50 未満に収まる', () => {
    expect(maxStepChange(1)).toBeLessThan(50);
  });
});

describe('wavelengthToColor: 明るさの正規化', () => {
  it('max モードではどの波長でも最大成分が 255', () => {
    for (const lambda of visibleWavelengths()) {
      expect(Math.max(...wavelengthToColor(lambda, 'max').rgb8), `${lambda}nm`).toBe(255);
    }
  });

  /**
   * luminance モードでは表示輝度が視感度 ȳ(λ) に比例する。
   * 全波長共通のスケールを掛けているだけなので、輝度比は ȳ の比に一致するはず。
   */
  it('luminance モードの輝度比が視感度の比に一致する', () => {
    for (const lambda of [420, 500, 580, 660]) {
      const a = wavelengthToColor(555, 'luminance');
      const b = wavelengthToColor(lambda, 'luminance');
      expect(
        relativeLuminance(b.linearRGB) / relativeLuminance(a.linearRGB),
        `${lambda}nm`,
      ).toBeCloseTo(b.luminousEfficiency / a.luminousEfficiency, 6);
    }
  });

  it('luminance モードで表示輝度が最大になるのは 555nm', () => {
    let brightest = { lambdaNm: 0, value: -1 };
    for (const lambda of visibleWavelengths()) {
      const value = relativeLuminance(wavelengthToColor(lambda, 'luminance').linearRGB);
      if (value > brightest.value) brightest = { lambdaNm: lambda, value };
    }
    expect(brightest.lambdaNm).toBe(555);
  });

  /**
   * 全波長共通のスケール係数は「どの波長でも 1 を超えない、かつどこかでちょうど 1 に届く」
   * ように決めている。1 を超えるとクリップして輝度比が崩れ、届かないと無駄に暗くなる。
   * ちなみに成分が 1 に届くのは 555nm ではなく 606nm 付近 — 赤は同じ輝度を得るのに
   * 大きな成分値を要するため。
   */
  it('luminance モードのスケールが上限ぎりぎりまで使われている', () => {
    let peak = 0;
    for (const lambda of visibleWavelengths()) {
      peak = Math.max(peak, ...wavelengthToColor(lambda, 'luminance').linearRGB);
    }
    expect(peak).toBeCloseTo(1, 9);
  });

  it('luminance モードでは可視域の両端が暗くなる', () => {
    const edge = relativeLuminance(wavelengthToColor(400, 'luminance').linearRGB);
    const middle = relativeLuminance(wavelengthToColor(555, 'luminance').linearRGB);
    expect(edge).toBeLessThan(middle * 0.001);
  });

  it('モードを変えても色相(色度)は変わらない', () => {
    for (const lambda of [420, 500, 580, 660]) {
      const a = wavelengthToColor(lambda, 'max');
      const b = wavelengthToColor(lambda, 'luminance');
      expect(a.chromaticity.x).toBeCloseTo(b.chromaticity.x, 12);
      expect(a.chromaticity.y).toBeCloseTo(b.chromaticity.y, 12);
    }
  });
});

describe('xyzToDisplayColor', () => {
  it('D65 の白は白として出る', () => {
    const { rgb8 } = xyzToDisplayColor([0.9505, 1, 1.089]);
    for (const c of rgb8) expect(Math.abs(c - 255)).toBeLessThanOrEqual(1);
  });

  it('黒は黒', () => {
    expect(xyzToDisplayColor([0, 0, 0]).hex).toBe('#000000');
  });
});
