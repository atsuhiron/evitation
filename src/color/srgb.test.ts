import { describe, expect, it } from 'vitest';
import {
  chromaticityToXYZ,
  clamp01,
  D65,
  decodeGamma,
  desaturateIntoGamut,
  encodeGamma,
  LINEAR_SRGB_TO_XYZ,
  linearSRGBToXYZ,
  normalizeToMaxComponent,
  relativeLuminance,
  toHex,
  toRGB8,
  XYZ_TO_LINEAR_SRGB,
  xyzToChromaticity,
  xyzToLinearSRGB,
} from './srgb.ts';
import { invert, multiplyMat3Vec3, type Mat3 } from './mat3.ts';

describe('XYZ ↔ linear sRGB 行列', () => {
  /**
   * 行列は原色の色度から導出しているので、規格書に載っている数値と一致するはず。
   * 導出のロジック(逆行列・列スケーリング)が壊れたらここで落ちる。
   */
  it('導出した行列が sRGB 規格の公表値と一致する', () => {
    const published: Mat3 = [
      3.2406, -1.5372, -0.4986,
      -0.9689, 1.8758, 0.0415,
      0.0557, -0.204, 1.057,
    ];
    for (let i = 0; i < 9; i += 1) {
      expect(XYZ_TO_LINEAR_SRGB[i]).toBeCloseTo(published[i]!, 3);
    }
  });

  it('白色点 D65 を入れると linear RGB が (1, 1, 1) になる', () => {
    const rgb = xyzToLinearSRGB(chromaticityToXYZ(D65, 1));
    expect(rgb[0]).toBeCloseTo(1, 10);
    expect(rgb[1]).toBeCloseTo(1, 10);
    expect(rgb[2]).toBeCloseTo(1, 10);
  });

  it('linear RGB (1, 1, 1) の色度が D65 になる', () => {
    const { x, y } = xyzToChromaticity(linearSRGBToXYZ([1, 1, 1]));
    expect(x).toBeCloseTo(D65.x, 10);
    expect(y).toBeCloseTo(D65.y, 10);
  });

  it('往復変換で元に戻る', () => {
    const xyz = [0.2, 0.35, 0.15] as const;
    const back = linearSRGBToXYZ(xyzToLinearSRGB(xyz));
    for (let i = 0; i < 3; i += 1) {
      expect(back[i]).toBeCloseTo(xyz[i]!, 12);
    }
  });

  it('2 つの行列は互いに逆行列', () => {
    const identity = multiplyMat3Vec3(XYZ_TO_LINEAR_SRGB, multiplyMat3Vec3(LINEAR_SRGB_TO_XYZ, [1, 2, 3]));
    expect(identity[0]).toBeCloseTo(1, 10);
    expect(identity[1]).toBeCloseTo(2, 10);
    expect(identity[2]).toBeCloseTo(3, 10);
  });

  it('特異行列の逆行列は例外', () => {
    expect(() => invert([1, 2, 3, 2, 4, 6, 1, 1, 1])).toThrow();
  });
});

describe('相対輝度', () => {
  it('よく知られた係数 0.2126 / 0.7152 / 0.0722 に一致する', () => {
    expect(relativeLuminance([1, 0, 0])).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance([0, 1, 0])).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance([0, 0, 1])).toBeCloseTo(0.0722, 4);
  });

  /**
   * 係数の総和が 1 であること。色域マッピングで白を w だけ足したとき
   * 輝度もちょうど w だけ増える、という前提がここに乗っている。
   */
  it('白を w 足すと輝度も w だけ増える', () => {
    const base: readonly [number, number, number] = [0.1, 0.4, 0.2];
    const w = 0.3;
    const lifted = [base[0] + w, base[1] + w, base[2] + w] as const;
    expect(relativeLuminance(lifted) - relativeLuminance(base)).toBeCloseTo(w, 12);
  });
});

describe('色域マッピング', () => {
  it('色域内の色はそのまま通す', () => {
    const result = desaturateIntoGamut([0.2, 0.5, 0.1]);
    expect(result.outOfGamut).toBe(false);
    expect(result.whiteAdded).toBe(0);
    expect(result.rgb).toEqual([0.2, 0.5, 0.1]);
  });

  it('負の成分は白を足して解消され、負値が残らない', () => {
    const result = desaturateIntoGamut([0.4, 0.9, -0.25]);
    expect(result.outOfGamut).toBe(true);
    expect(result.whiteAdded).toBeCloseTo(0.25, 12);
    expect(Math.min(...result.rgb)).toBeCloseTo(0, 12);
    expect(Math.min(...result.rgb)).toBeGreaterThanOrEqual(0);
  });

  it('白を足しても成分間の差は変わらない(色相を保つ)', () => {
    const before: readonly [number, number, number] = [0.4, 0.9, -0.25];
    const after = desaturateIntoGamut(before).rgb;
    expect(after[1] - after[0]).toBeCloseTo(before[1] - before[0], 12);
    expect(after[2] - after[1]).toBeCloseTo(before[2] - before[1], 12);
  });

  it('最大成分正規化で最大値が 1 になる', () => {
    const rgb = normalizeToMaxComponent([0.2, 0.5, 0.1]);
    expect(Math.max(...rgb)).toBeCloseTo(1, 12);
    expect(rgb[0] / rgb[1]).toBeCloseTo(0.2 / 0.5, 12);
  });

  it('全て 0 の入力は黒のまま(0 除算しない)', () => {
    expect(normalizeToMaxComponent([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('clamp01 が 0..1 に収める', () => {
    expect(clamp01([-0.5, 0.5, 1.5])).toEqual([0, 0.5, 1]);
  });
});

describe('ガンマ(伝達関数)', () => {
  it('端点が保存される', () => {
    expect(encodeGamma(0)).toBe(0);
    expect(encodeGamma(1)).toBeCloseTo(1, 12);
    expect(decodeGamma(0)).toBe(0);
    expect(decodeGamma(1)).toBeCloseTo(1, 12);
  });

  it('線形部と冪部の継ぎ目で連続', () => {
    const threshold = 0.0031308;
    const below = encodeGamma(threshold - 1e-9);
    const above = encodeGamma(threshold + 1e-9);
    expect(above - below).toBeLessThan(1e-6);
  });

  it('encode と decode が互いの逆関数', () => {
    for (const v of [0, 0.001, 0.0031308, 0.05, 0.18, 0.5, 0.9, 1]) {
      expect(decodeGamma(encodeGamma(v))).toBeCloseTo(v, 10);
    }
  });

  it('単調増加', () => {
    let previous = -1;
    for (let v = 0; v <= 1; v += 0.001) {
      const encoded = encodeGamma(v);
      expect(encoded).toBeGreaterThan(previous);
      previous = encoded;
    }
  });

  // 中間グレー 0.5 は linear では約 0.214。ガンマの向きを取り違えていないかの確認。
  it('sRGB の 0.5 は linear の約 0.214', () => {
    expect(decodeGamma(0.5)).toBeCloseTo(0.2140, 3);
  });
});

describe('出力形式', () => {
  it('8bit 化と HEX', () => {
    expect(toRGB8([1, 0, 0])).toEqual([255, 0, 0]);
    expect(toHex([255, 71, 0])).toBe('#FF4700');
    expect(toHex([0, 0, 0])).toBe('#000000');
    expect(toHex([255, 255, 255])).toBe('#FFFFFF');
  });

  it('範囲外の値はクリップされる', () => {
    expect(toRGB8([-1, 0.5, 2])).toEqual([0, 128, 255]);
  });
});
