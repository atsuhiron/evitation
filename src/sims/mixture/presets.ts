/**
 * プリセット。
 *
 * 「見せたいこと」がはっきりしている組み合わせだけを置く。
 * 強度は手で選んだ数値ではなく、目標の色度から解いて求める — sRGB の変換行列を
 * 原色の色度から導出しているのと同じ理由で、出所が追えてテストで検算できるから。
 */

import {
  chromaticityToXYZ,
  cmfAt,
  D65,
  linearSRGBToXYZ,
  solveMixIntensities,
  solveTwoLineMix,
  xyzToChromaticity,
} from '../../color/index.ts';
import { INTENSITY_STEP, type IntensityBasis, type IntensityComponent } from './intensity.ts';

export type PresetComponent = IntensityComponent;

export interface Preset {
  readonly name: string;
  readonly hint: string;
  readonly basis: IntensityBasis;
  readonly components: readonly PresetComponent[];
}

/**
 * 放射強度で解いた結果を、スライダーに載せる輝度基準の強度へ直す。
 *
 * 合計が 1 になるよう正規化しているので、どのプリセットも合成後の輝度が等しい。
 * プリセットを切り替えたときに明るさではなく色相の違いが見える、という意図。
 * 放射強度のままだと 700nm の値が桁違いに大きくなり(視感度が 0.004 しかないため)
 * スライダーの範囲に収まらない、という実務上の理由もある。
 */
function toLuminanceBasis(
  lambdas: readonly number[],
  radiances: readonly number[],
): PresetComponent[] {
  const luminances = lambdas.map((lambdaNm, i) => (radiances[i] ?? 0) * cmfAt(lambdaNm)[1]);
  const total = luminances.reduce((sum, v) => sum + v, 0);
  const scale = total > 0 ? 1 / total : 0;

  return lambdas.map((lambdaNm, i) => ({
    lambdaNm,
    intensity:
      Math.round(((luminances[i] ?? 0) * scale) / INTENSITY_STEP) * INTENSITY_STEP,
  }));
}

/**
 * CIE 1931 RGB 表色系の原色。
 *
 * 本来は 700 / 546.1 / 435.8nm だが、波長の入力を 1nm 刻みにしているので整数に丸める。
 * 色度への影響は無視できる。
 */
const CIE_RGB_LAMBDAS = [700, 546, 436] as const;

/**
 * 補色対。
 *
 * 色度図上で D65 を挟んで向かい合う 2 波長。可視域を総当たりで探すと
 * 白色点をぴたりと通る組み合わせがいくつかあるが、その中で 2 成分の強度が
 * 極端に偏らない(= どちらの成分も効いていることが見て取れる)この対を選んだ。
 */
const COMPLEMENTARY_LAMBDAS = [491, 607] as const;

/** 紫の側で最も鮮やかな非スペクトル色を狙う 2 波長。 */
const MAGENTA_LAMBDAS = [450, 650] as const;

/** sRGB のマゼンタ(赤と青の原色を等量で混ぜた点)の色度。 */
const SRGB_MAGENTA = xyzToChromaticity(linearSRGBToXYZ([1, 0, 1]));

function cieRgbWhite(): PresetComponent[] {
  const solution = solveMixIntensities(CIE_RGB_LAMBDAS, chromaticityToXYZ(D65, 1));
  return toLuminanceBasis(CIE_RGB_LAMBDAS, solution.intensities);
}

function twoLine(lambdas: readonly [number, number], target: typeof D65): PresetComponent[] {
  return toLuminanceBasis(lambdas, solveTwoLineMix(lambdas[0], lambdas[1], target).intensities);
}

export const presets: readonly Preset[] = [
  {
    name: 'CIE RGB 三原色 → 白',
    hint: '700 / 546 / 436nm の 3 本だけで D65 の白ができる。強度は連立方程式を解いて求めた値。',
    basis: 'luminance',
    components: cieRgbWhite(),
  },
  {
    name: 'マゼンタ',
    hint: '450 + 650nm。スペクトル帯のどこを探しても出てこない色で、単一の波長では作れない。',
    basis: 'luminance',
    components: twoLine(MAGENTA_LAMBDAS, SRGB_MAGENTA),
  },
  {
    name: '補色対 → 白',
    hint: '491 + 607nm。色度図上で白色点を挟んで向かい合う 2 波長。たった 2 本でも白になる。',
    basis: 'luminance',
    components: twoLine(COMPLEMENTARY_LAMBDAS, D65),
  },
  {
    name: 'ナトリウム D 線',
    hint: '実際は 589.0 と 589.6nm の二重線。ここでは 1nm 刻みで近似。色としては単色光と区別がつかない。',
    basis: 'luminance',
    components: [
      { lambdaNm: 589, intensity: 0.5 },
      { lambdaNm: 590, intensity: 0.5 },
    ],
  },
];

/** 初期表示。3 本の単色光から白ができる、というこのページの主題をそのまま出す。 */
export const defaultPreset = presets[0]!;
