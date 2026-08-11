/**
 * 「波長 → 画面に出す色」の一本道。
 *
 * 単色光を表示するときに避けて通れないのが、スペクトル軌跡が sRGB の色域から
 * 大きくはみ出しているという事実。ここで行っているのは物理量からの厳密な再現ではなく、
 * 色域内に収まる範囲での最良の近似で、どこで妥協したかは WavelengthColor の
 * outOfGamut / whiteAdded に残してある。
 */

import { cmfAt, VISIBLE_LAMBDA_MAX, VISIBLE_LAMBDA_MIN } from './cie1931.ts';
import {
  clamp01,
  desaturateIntoGamut,
  encodeGammaRGB,
  normalizeToMaxComponent,
  relativeLuminance,
  scaleRGB,
  toHex,
  toRGB8,
  xyzToChromaticity,
  xyzToLinearSRGB,
  type Chromaticity,
  type LinearRGB,
  type RGB8,
  type XYZ,
} from './srgb.ts';

export * from './cie1931.ts';
export * from './srgb.ts';

/**
 * 明るさの決め方。
 *
 * - `max`: RGB の最大成分が 1 になるよう揃える。どの波長も同じ明るさで表示されるので
 *   「その波長は何色か」を見るのに適する。スペクトル帯もこちらで描く。
 * - `luminance`: 表示輝度が視感度 ȳ(λ) に比例するようにする。555nm 付近が最も明るく、
 *   両端は暗く沈む。人間の目の感度の波長依存性がそのまま見える。
 */
export type NormalizeMode = 'max' | 'luminance';

export interface WavelengthColor {
  readonly lambdaNm: number;
  /** 等色関数の値そのもの。単位放射の単色光に対する三刺激値。 */
  readonly xyz: XYZ;
  readonly chromaticity: Chromaticity;
  /** 分光視感効率 V(λ) = ȳ(λ)。555nm で 1.0。 */
  readonly luminousEfficiency: number;
  /** 色域マッピングと正規化を経た linear RGB (0..1)。 */
  readonly linearRGB: LinearRGB;
  readonly rgb8: RGB8;
  readonly hex: string;
  /** この波長が sRGB の色域外か。可視域ではほぼ常に true。 */
  readonly outOfGamut: boolean;
  /**
   * 色域に入れるために加えた白の量(正規化前の linear RGB スケール)。
   * 大きいほど、本来の色より白っぽく表示されていることになる。
   */
  readonly whiteAdded: number;
}

/** 色域マッピングまで済ませた中間状態。正規化はまだしていない。 */
interface MappedColor {
  readonly xyz: XYZ;
  readonly rgb: LinearRGB;
  readonly outOfGamut: boolean;
  readonly whiteAdded: number;
}

function mapWavelength(lambdaNm: number): MappedColor {
  const xyz = cmfAt(lambdaNm);
  const mapped = desaturateIntoGamut(xyzToLinearSRGB(xyz));
  return {
    xyz,
    rgb: mapped.rgb,
    outOfGamut: mapped.outOfGamut,
    whiteAdded: mapped.whiteAdded,
  };
}

/**
 * `luminance` モードで使う全波長共通のスケール係数。
 *
 * 各波長で「表示輝度 = ȳ(λ)」となるようスケールすると、可視域のどこかで RGB が 1 を
 * 超えてしまう。そこで最大値の逆数を一度だけ求めて全波長に同じ係数を掛ける。
 * 係数が波長によらず一定なので、波長間の輝度比は ȳ(λ) の比のまま保たれる。
 */
let luminanceScale: number | null = null;

function luminanceModeScale(): number {
  if (luminanceScale !== null) return luminanceScale;

  let peak = 0;
  for (let lambda = VISIBLE_LAMBDA_MIN; lambda <= VISIBLE_LAMBDA_MAX; lambda += 1) {
    const rgb = luminanceNormalized(mapWavelength(lambda));
    peak = Math.max(peak, rgb[0], rgb[1], rgb[2]);
  }

  luminanceScale = peak > 0 ? 1 / peak : 1;
  return luminanceScale;
}

/** 表示輝度が ȳ(λ) に一致するようスケールする(共通係数を掛ける前の段階)。 */
function luminanceNormalized(mapped: MappedColor): LinearRGB {
  const y = relativeLuminance(mapped.rgb);
  if (y <= 0) return [0, 0, 0];
  // 白を w 足すと輝度も w だけ増える(linear RGB → Y の係数の総和が 1 のため)。
  // 元の輝度 ȳ(λ) に戻すには、その分を割り戻せばよい。
  return scaleRGB(mapped.rgb, mapped.xyz[1] / y);
}

function normalize(mapped: MappedColor, mode: NormalizeMode): LinearRGB {
  if (mode === 'max') return normalizeToMaxComponent(mapped.rgb);
  return clamp01(scaleRGB(luminanceNormalized(mapped), luminanceModeScale()));
}

/**
 * 波長 [nm] から表示用の色を求める。
 *
 * @param lambdaNm 波長 [nm]。可視域外を渡すと黒に近い色が返る。
 * @param mode 明るさの決め方。既定は `max`。
 */
export function wavelengthToColor(lambdaNm: number, mode: NormalizeMode = 'max'): WavelengthColor {
  const mapped = mapWavelength(lambdaNm);
  const linearRGB = normalize(mapped, mode);
  const rgb8 = toRGB8(encodeGammaRGB(linearRGB));

  return {
    lambdaNm,
    xyz: mapped.xyz,
    chromaticity: xyzToChromaticity(mapped.xyz),
    luminousEfficiency: mapped.xyz[1],
    linearRGB,
    rgb8,
    hex: toHex(rgb8),
    outOfGamut: mapped.outOfGamut,
    whiteAdded: mapped.whiteAdded,
  };
}

/**
 * 任意の XYZ を表示用の sRGB へ。
 *
 * 単色光以外(干渉縞や薄膜の反射スペクトル)から得た XYZ を色にするときはこちら。
 * 色域外なら白方向へ寄せ、1 を超える分はクリップする。
 */
export function xyzToDisplayColor(xyz: XYZ): { rgb8: RGB8; hex: string; outOfGamut: boolean } {
  const mapped = desaturateIntoGamut(xyzToLinearSRGB(xyz));
  const rgb8 = toRGB8(encodeGammaRGB(clamp01(mapped.rgb)));
  return { rgb8, hex: toHex(rgb8), outOfGamut: mapped.outOfGamut };
}
