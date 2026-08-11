import { describe, expect, it } from 'vitest';
import {
  chromaticityToXYZ,
  cmfAt,
  D65,
  solveMixIntensities,
  solveTwoLineMix,
  spectralLinesToXYZ,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  xyzToChromaticity,
  xyzToColor,
  type SpectralLine,
} from './index.ts';

const CIE_RGB: readonly [number, number, number] = [700, 546, 436];

describe('spectralLinesToXYZ', () => {
  it('成分が無ければ黒', () => {
    expect(spectralLinesToXYZ([])).toEqual([0, 0, 0]);
  });

  it('1 本だけなら cmfAt(λ)·I に一致する', () => {
    const cmf = cmfAt(550);
    const xyz = spectralLinesToXYZ([{ lambdaNm: 550, intensity: 2.5 }]);
    for (let i = 0; i < 3; i += 1) {
      expect(xyz[i]).toBeCloseTo(cmf[i]! * 2.5, 12);
    }
  });

  /**
   * グラスマンの法則。混合光の三刺激値が各成分の和になる、という
   * このページ全体の前提そのもの。
   */
  it('加法性: mix(A ∪ B) === mix(A) + mix(B)', () => {
    const a: SpectralLine[] = [
      { lambdaNm: 450, intensity: 0.7 },
      { lambdaNm: 520, intensity: 0.3 },
    ];
    const b: SpectralLine[] = [
      { lambdaNm: 610, intensity: 0.9 },
      { lambdaNm: 680, intensity: 0.2 },
    ];

    const combined = spectralLinesToXYZ([...a, ...b]);
    const separate = [spectralLinesToXYZ(a), spectralLinesToXYZ(b)];
    for (let i = 0; i < 3; i += 1) {
      expect(combined[i]).toBeCloseTo(separate[0]![i]! + separate[1]![i]!, 12);
    }
  });

  it('強度に対して線形', () => {
    const lines: SpectralLine[] = [
      { lambdaNm: 480, intensity: 0.4 },
      { lambdaNm: 600, intensity: 0.6 },
    ];
    const doubled = spectralLinesToXYZ(lines.map((l) => ({ ...l, intensity: l.intensity * 2 })));
    const single = spectralLinesToXYZ(lines);
    for (let i = 0; i < 3; i += 1) {
      expect(doubled[i]).toBeCloseTo(single[i]! * 2, 12);
    }
  });

  it('順序を入れ替えても同じ', () => {
    const lines: SpectralLine[] = [
      { lambdaNm: 470, intensity: 0.5 },
      { lambdaNm: 530, intensity: 0.8 },
      { lambdaNm: 640, intensity: 0.2 },
    ];
    expect(spectralLinesToXYZ([...lines].reverse())).toEqual(spectralLinesToXYZ(lines));
  });

  it('強度 0 の成分は結果に影響しない', () => {
    const base: SpectralLine[] = [{ lambdaNm: 550, intensity: 1 }];
    expect(spectralLinesToXYZ([...base, { lambdaNm: 400, intensity: 0 }])).toEqual(
      spectralLinesToXYZ(base),
    );
  });
});

describe('solveMixIntensities', () => {
  /**
   * 解いた強度で実際に合成し直すと目標に戻ることの検算。
   * solveMixIntensities と spectralLinesToXYZ の両方を一度に通すので、
   * 混色パス全体で最も効く検査。
   */
  it('CIE RGB 三原色から D65 を作る強度を解くと、合成結果が D65 に戻る', () => {
    const target = chromaticityToXYZ(D65, 1);
    const solution = solveMixIntensities(CIE_RGB, target);

    expect(solution.feasible).toBe(true);

    const remixed = spectralLinesToXYZ(
      CIE_RGB.map((lambdaNm, i) => ({ lambdaNm, intensity: solution.intensities[i]! })),
    );
    for (let i = 0; i < 3; i += 1) {
      expect(remixed[i]).toBeCloseTo(target[i]!, 10);
    }

    const { x, y } = xyzToChromaticity(remixed);
    expect(x).toBeCloseTo(D65.x, 9);
    expect(y).toBeCloseTo(D65.y, 9);
  });

  it('解いた強度で合成すると実際に白く表示される', () => {
    const solution = solveMixIntensities(CIE_RGB, chromaticityToXYZ(D65, 1));
    const xyz = spectralLinesToXYZ(
      CIE_RGB.map((lambdaNm, i) => ({ lambdaNm, intensity: solution.intensities[i]! })),
    );
    const [r, g, b] = xyzToColor(xyz, 'max').rgb8;
    // D65 は sRGB の白色点そのものなので、3 成分が揃うはず。
    expect(Math.abs(r - 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 255)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 255)).toBeLessThanOrEqual(1);
  });

  it('三角形の外の目標色は feasible が false になる', () => {
    // 480nm の単色光は、700/546/436 が張る三角形の外側(スペクトル軌跡上)にある。
    const solution = solveMixIntensities(CIE_RGB, cmfAt(480));
    expect(solution.feasible).toBe(false);
    expect(Math.min(...solution.intensities)).toBeLessThan(0);
  });

  it('同じ波長を重複して渡すと特異行列で例外', () => {
    expect(() => solveMixIntensities([550, 550, 600], cmfAt(570))).toThrow();
  });
});

describe('単一波長では作れない色', () => {
  /**
   * このページの主題。450 + 650nm のマゼンタはスペクトル軌跡の上に無いので、
   * 可視域のどの単色光とも色度が一致しない。
   */
  it('450 + 650nm の色度は、どの単色光の色度とも一致しない', () => {
    const magenta = xyzToChromaticity(
      spectralLinesToXYZ([
        { lambdaNm: 450, intensity: 1 },
        { lambdaNm: 650, intensity: 1 },
      ]),
    );

    let closest = Infinity;
    for (let lambda = VISIBLE_LAMBDA_MIN; lambda <= VISIBLE_LAMBDA_MAX; lambda += 0.5) {
      const spectral = xyzToChromaticity(cmfAt(lambda));
      closest = Math.min(
        closest,
        Math.hypot(spectral.x - magenta.x, spectral.y - magenta.y),
      );
    }

    // 色度図上でどの単色光からも明確に離れている。
    expect(closest).toBeGreaterThan(0.05);
  });

  it('単色光そのものはスペクトル軌跡の上にある(上の検査の対照)', () => {
    const single = xyzToChromaticity(cmfAt(550));
    let closest = Infinity;
    for (let lambda = VISIBLE_LAMBDA_MIN; lambda <= VISIBLE_LAMBDA_MAX; lambda += 0.5) {
      const spectral = xyzToChromaticity(cmfAt(lambda));
      closest = Math.min(closest, Math.hypot(spectral.x - single.x, spectral.y - single.y));
    }
    expect(closest).toBeLessThan(1e-9);
  });
});

describe('solveTwoLineMix', () => {
  const mixOf = (solution: { intensities: readonly [number, number] }, l1: number, l2: number) =>
    spectralLinesToXYZ([
      { lambdaNm: l1, intensity: solution.intensities[0] },
      { lambdaNm: l2, intensity: solution.intensities[1] },
    ]);

  /**
   * 491 と 607nm は D65 に対するほぼ厳密な補色対。2 本の単色光だけで白が作れる。
   * 合成ページの「補色対 → 白」プリセットがこれに依存している。
   */
  it('491 + 607nm は D65 にほぼ厳密に届く', () => {
    const solution = solveTwoLineMix(491, 607, D65);
    expect(solution.distance).toBeLessThan(1e-3);

    const { x, y } = xyzToChromaticity(mixOf(solution, 491, 607));
    expect(x).toBeCloseTo(D65.x, 3);
    expect(y).toBeCloseTo(D65.y, 3);
  });

  it('解いた比率で合成すると実際に白く表示される', () => {
    const solution = solveTwoLineMix(491, 607, D65);
    const [r, g, b] = xyzToColor(mixOf(solution, 491, 607), 'max').rgb8;
    expect(Math.abs(r - 255)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 255)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 255)).toBeLessThanOrEqual(2);
  });

  it('返す色度は実際に合成した結果と一致する', () => {
    const solution = solveTwoLineMix(470, 580, D65);
    const actual = xyzToChromaticity(mixOf(solution, 470, 580));
    expect(solution.chromaticity.x).toBeCloseTo(actual.x, 12);
    expect(solution.chromaticity.y).toBeCloseTo(actual.y, 12);
  });

  it('強度はどちらも 0 以上(光を引くことはできない)', () => {
    for (const [l1, l2] of [
      [450, 650],
      [491, 607],
      [400, 700],
    ] as const) {
      const { intensities } = solveTwoLineMix(l1, l2, D65);
      expect(Math.min(...intensities), `${l1}+${l2}`).toBeGreaterThanOrEqual(0);
    }
  });

  /** 2 波長では線分の上しか到達できないので、線分から外れた目標には届かない。 */
  it('線分の上に無い目標には届かず、distance にずれが残る', () => {
    // 520nm の単色光は 450–650 を結ぶ線分から大きく外れている。
    const solution = solveTwoLineMix(450, 650, xyzToChromaticity(cmfAt(520)));
    expect(solution.distance).toBeGreaterThan(0.1);
  });

  it('色度が同一の 2 波長では例外', () => {
    expect(() => solveTwoLineMix(550, 550, D65)).toThrow();
  });
});

describe('補色対', () => {
  const distanceToD65 = (xyz: readonly [number, number, number]): number => {
    const { x, y } = xyzToChromaticity(xyz);
    return Math.hypot(x - D65.x, y - D65.y);
  };

  it('混ぜるとどちらの単色光より白色点に近づく', () => {
    const solution = solveTwoLineMix(491, 607, D65);
    const mixed = spectralLinesToXYZ([
      { lambdaNm: 491, intensity: solution.intensities[0] },
      { lambdaNm: 607, intensity: solution.intensities[1] },
    ]);

    expect(distanceToD65(mixed)).toBeLessThan(distanceToD65(cmfAt(491)));
    expect(distanceToD65(mixed)).toBeLessThan(distanceToD65(cmfAt(607)));
  });
});

describe('輝度基準の強度', () => {
  /**
   * 輝度基準では I を「その成分が担う輝度」と定義しているので、
   * 放射強度 I/ȳ(λ) に直して合成すると、合成後の Y はちょうど ΣI になる。
   * 合成ページの強度スライダーの意味づけがこれに依存している。
   */
  it('I/ȳ(λ) で合成すると Y が ΣI に一致する', () => {
    const requested = [
      { lambdaNm: 450, intensity: 0.2 },
      { lambdaNm: 550, intensity: 0.5 },
      { lambdaNm: 650, intensity: 0.1 },
    ];
    const xyz = spectralLinesToXYZ(
      requested.map((c) => ({
        lambdaNm: c.lambdaNm,
        intensity: c.intensity / cmfAt(c.lambdaNm)[1],
      })),
    );
    const total = requested.reduce((sum, c) => sum + c.intensity, 0);
    expect(xyz[1]).toBeCloseTo(total, 12);
  });
});
