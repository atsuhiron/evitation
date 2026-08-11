import { describe, expect, it } from 'vitest';
import {
  CMF_LAMBDA_MAX,
  CMF_LAMBDA_MIN,
  cmfAt,
  luminousEfficiency,
  spectrumToXYZ,
} from './cie1931.ts';
import { xyzToChromaticity } from './srgb.ts';

/** 1nm 刻みで走査して、指定成分が最大になる波長とその値を返す。 */
function findPeak(component: 0 | 1 | 2): { lambdaNm: number; value: number } {
  let best = { lambdaNm: CMF_LAMBDA_MIN, value: -Infinity };
  for (let lambda = CMF_LAMBDA_MIN; lambda <= CMF_LAMBDA_MAX; lambda += 1) {
    const value = cmfAt(lambda)[component];
    if (value > best.value) best = { lambdaNm: lambda, value };
  }
  return best;
}

describe('等色関数テーブル', () => {
  // ȳ は分光視感効率 V(λ) そのもので、555nm でちょうど 1.0 に正規化されている。
  // これがずれていたらテーブルのスケールか列の対応が壊れている。
  it('ȳ のピークは 555nm で 1.0', () => {
    const peak = findPeak(1);
    expect(peak.lambdaNm).toBe(555);
    expect(peak.value).toBeCloseTo(1, 6);
  });

  // 文献でよく引かれる「x̄ は 600nm で 1.0622」「z̄ は 445nm で 1.7826」は、
  // その波長における値であって最大値そのものではない。1nm テーブルの実際の頂点は
  // それぞれ 599nm と 446nm にあり 1nm ずれる。両方を別々に確認する。
  it('x̄ の 600nm の値が 1.0622、ピークはその近傍', () => {
    expect(cmfAt(600)[0]).toBeCloseTo(1.0622, 6);
    expect(Math.abs(findPeak(0).lambdaNm - 600)).toBeLessThanOrEqual(2);
  });

  it('z̄ の 445nm の値が 1.7826、ピークはその近傍', () => {
    expect(cmfAt(445)[2]).toBeCloseTo(1.7826, 6);
    expect(Math.abs(findPeak(2).lambdaNm - 445)).toBeLessThanOrEqual(2);
  });

  /**
   * 全波長で等しいエネルギーを持つ光(CIE 標準イルミナント E)の色度は、
   * 等色関数の正規化の定義から厳密に x = y = 1/3 になる。
   * ∫x̄ = ∫ȳ = ∫z̄ が成り立っているかを見ていることになるので、
   * テーブル全体のスケール違い・行の欠落・列の入れ替わりを一度に検出できる。
   */
  it('等エネルギー白(イルミナント E)の色度が x = y = 1/3', () => {
    const xyz = spectrumToXYZ(() => 1);
    const { x, y } = xyzToChromaticity(xyz);
    expect(x).toBeCloseTo(1 / 3, 3);
    expect(y).toBeCloseTo(1 / 3, 3);
  });

  it('テーブルに欠損が無い(可視域の全波長で ȳ > 0)', () => {
    for (let lambda = 380; lambda <= 780; lambda += 1) {
      expect(luminousEfficiency(lambda)).toBeGreaterThan(0);
    }
  });

  it('テーブル範囲外は 0 を返す', () => {
    expect(cmfAt(CMF_LAMBDA_MIN - 1)).toEqual([0, 0, 0]);
    expect(cmfAt(CMF_LAMBDA_MAX + 1)).toEqual([0, 0, 0]);
    expect(cmfAt(Number.NaN)).toEqual([0, 0, 0]);
  });

  it('端の波長はテーブルの値をそのまま返す', () => {
    expect(cmfAt(CMF_LAMBDA_MIN)).toEqual([0.0001299, 0.000003917, 0.0006061]);
    expect(cmfAt(CMF_LAMBDA_MAX)[2]).toBe(0);
  });
});

describe('補間', () => {
  it('整数波長ではテーブルの値をそのまま返す', () => {
    const at555 = cmfAt(555);
    expect(at555[1]).toBeCloseTo(1, 6);
  });

  it('中間の波長は前後の平均になる', () => {
    const a = cmfAt(500);
    const b = cmfAt(501);
    const mid = cmfAt(500.5);
    for (let i = 0; i < 3; i += 1) {
      expect(mid[i]).toBeCloseTo((a[i]! + b[i]!) / 2, 12);
    }
  });

  it('補間は単調に効く', () => {
    const a = cmfAt(520);
    const q = cmfAt(520.25);
    const b = cmfAt(521);
    expect(q[1]).toBeCloseTo(a[1]! + (b[1]! - a[1]!) * 0.25, 12);
  });
});

describe('spectrumToXYZ', () => {
  it('分光分布が 0 なら XYZ も 0', () => {
    expect(spectrumToXYZ(() => 0)).toEqual([0, 0, 0]);
  });

  it('線形性: S を 2 倍すると XYZ も 2 倍', () => {
    const single = spectrumToXYZ((l) => Math.exp(-((l - 550) ** 2) / 400));
    const doubled = spectrumToXYZ((l) => 2 * Math.exp(-((l - 550) ** 2) / 400));
    for (let i = 0; i < 3; i += 1) {
      expect(doubled[i]).toBeCloseTo(single[i]! * 2, 12);
    }
  });

  // 幅の狭いガウシアンは δ 関数に近いので、その色度は単色光の色度に寄る。
  it('鋭いピークを持つスペクトルの色度は同じ波長の単色光に近づく', () => {
    const narrow = spectrumToXYZ((l) => Math.exp(-((l - 550) ** 2) / 2), { stepNm: 0.5 });
    const spectral = xyzToChromaticity(cmfAt(550));
    const integrated = xyzToChromaticity(narrow);
    expect(integrated.x).toBeCloseTo(spectral.x, 3);
    expect(integrated.y).toBeCloseTo(spectral.y, 3);
  });

  it('刻み幅を変えても積分値はほぼ変わらない', () => {
    const coarse = spectrumToXYZ(() => 1, { stepNm: 5 });
    const fine = spectrumToXYZ(() => 1, { stepNm: 1 });
    expect(coarse[1]).toBeCloseTo(fine[1]!, 1);
  });

  it('刻み幅が非正なら例外', () => {
    expect(() => spectrumToXYZ(() => 1, { stepNm: 0 })).toThrow();
  });
});
