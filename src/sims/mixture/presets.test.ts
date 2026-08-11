import { describe, expect, it } from 'vitest';
import {
  cmfAt,
  spectralLinesToXYZ,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  wavelengthToColor,
  xyzToColor,
  type RGB8,
} from '../../color/index.ts';
import { INTENSITY_STEP, toRadianceLines } from './intensity.ts';
import { presets, type Preset } from './presets.ts';

function presetByName(name: string): Preset {
  const preset = presets.find((p) => p.name.startsWith(name));
  if (preset === undefined) throw new Error(`プリセットが見つかりません: ${name}`);
  return preset;
}

/** プリセットを画面と同じ経路で色にする。 */
function renderPreset(preset: Preset): RGB8 {
  const xyz = spectralLinesToXYZ(toRadianceLines(preset.components, preset.basis));
  return xyzToColor(xyz, 'max').rgb8;
}

function distance(a: RGB8, b: RGB8): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 可視域の単色光のうち、見た目が最も近いもの。 */
function nearestSpectral(rgb: RGB8): { lambdaNm: number; distance: number } {
  let best = { lambdaNm: 0, distance: Infinity };
  for (let lambda = VISIBLE_LAMBDA_MIN; lambda <= VISIBLE_LAMBDA_MAX; lambda += 1) {
    const d = distance(rgb, wavelengthToColor(lambda, 'max').rgb8);
    if (d < best.distance) best = { lambdaNm: lambda, distance: d };
  }
  return best;
}

describe('プリセット共通', () => {
  it.each(presets.map((p) => [p.name, p] as const))('%s: 強度が 0..1 に収まる', (_name, preset) => {
    for (const component of preset.components) {
      expect(component.intensity).toBeGreaterThanOrEqual(0);
      expect(component.intensity).toBeLessThanOrEqual(1);
    }
  });

  /**
   * 表示(スライダー・数値入力)と内部状態が食い違わないための条件。
   * 刻みに乗っていないと、スライダーが勝手に近い値へ吸着して色が変わる。
   */
  it.each(presets.map((p) => [p.name, p] as const))(
    '%s: 強度がスライダーの刻みに乗っている',
    (_name, preset) => {
      for (const component of preset.components) {
        const steps = component.intensity / INTENSITY_STEP;
        expect(Math.abs(steps - Math.round(steps)), `${component.lambdaNm}nm`).toBeLessThan(1e-9);
      }
    },
  );

  it.each(presets.map((p) => [p.name, p] as const))(
    '%s: 波長が可視域に収まる',
    (_name, preset) => {
      for (const component of preset.components) {
        expect(component.lambdaNm).toBeGreaterThanOrEqual(VISIBLE_LAMBDA_MIN);
        expect(component.lambdaNm).toBeLessThanOrEqual(VISIBLE_LAMBDA_MAX);
      }
    },
  );

  /** 輝度基準では ΣI が合成後の Y になる。全プリセットで揃えてある。 */
  it.each(presets.map((p) => [p.name, p] as const))('%s: 合成輝度が 1', (_name, preset) => {
    const xyz = spectralLinesToXYZ(toRadianceLines(preset.components, preset.basis));
    expect(xyz[1]).toBeCloseTo(1, 2);
  });
});

/**
 * 各プリセットが「見せたいこと」を実際に見せられているかの検査。
 *
 * 強度を刻みに丸めた影響で白が黄ばむ、といった劣化がここで捕まる
 * (0.01 刻みだと CIE RGB の白が #FAFFE9 になっていた)。
 */
describe('プリセットが主張どおりの色になる', () => {
  it('CIE RGB 三原色 → 白: 3 成分が揃って白になる', () => {
    const rgb = renderPreset(presetByName('CIE RGB'));
    for (const channel of rgb) {
      expect(255 - channel).toBeLessThanOrEqual(4);
    }
  });

  it('補色対 → 白: 2 本だけでも白になる', () => {
    const rgb = renderPreset(presetByName('補色対'));
    for (const channel of rgb) {
      expect(255 - channel).toBeLessThanOrEqual(4);
    }
  });

  /**
   * このページの主題。マゼンタが単色光の見た目と紛れてしまうと実演として
   * 成立しないので、8bit RGB 空間でどの単色光からも明確に離れていることを見る。
   * 色度で離れていても、色域外どうしは同じ色域の縁へ寄せられて似た色になりうるため、
   * 色度ではなく最終的な見た目で判定している。
   */
  it('マゼンタ: どの単色光の見た目とも明確に異なる', () => {
    const rgb = renderPreset(presetByName('マゼンタ'));
    expect(nearestSpectral(rgb).distance).toBeGreaterThan(80);
  });

  it('マゼンタ: 赤と青が両方立った色になる', () => {
    const [r, g, b] = renderPreset(presetByName('マゼンタ'));
    expect(r).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
  });

  /** 逆に、ナトリウム D 線は単色光と区別がつかないことが見せたいこと。 */
  it('ナトリウム D 線: 589nm の単色光とほぼ同じ色になる', () => {
    const rgb = renderPreset(presetByName('ナトリウム'));
    expect(distance(rgb, wavelengthToColor(589, 'max').rgb8)).toBeLessThan(5);
  });
});

describe('toRadianceLines', () => {
  it('放射強度基準では値をそのまま渡す', () => {
    const lines = toRadianceLines([{ lambdaNm: 550, intensity: 0.4 }], 'radiance');
    expect(lines).toEqual([{ lambdaNm: 550, intensity: 0.4 }]);
  });

  it('輝度基準では ȳ(λ) で割る', () => {
    const lines = toRadianceLines([{ lambdaNm: 450, intensity: 0.4 }], 'luminance');
    expect(lines[0]!.intensity).toBeCloseTo(0.4 / cmfAt(450)[1], 12);
  });

  it('輝度基準なら合成後の Y が ΣI に一致する', () => {
    const components = [
      { lambdaNm: 430, intensity: 0.25 },
      { lambdaNm: 545, intensity: 0.4 },
      { lambdaNm: 660, intensity: 0.1 },
    ];
    const xyz = spectralLinesToXYZ(toRadianceLines(components, 'luminance'));
    expect(xyz[1]).toBeCloseTo(0.75, 12);
  });
});
