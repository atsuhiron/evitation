/**
 * 「三刺激値 XYZ → 画面に出す色」の一本道。
 *
 * 単色光を表示するときに避けて通れないのが、スペクトル軌跡が sRGB の色域から
 * 大きくはみ出しているという事実。ここで行っているのは物理量からの厳密な再現ではなく、
 * 色域内に収まる範囲での最良の近似で、どこで妥協したかは ColorResult の
 * outOfGamut / whiteAdded / clipped に残してある。
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
 * - `max`: RGB の最大成分が 1 になるよう揃える。どの色も同じ明るさで表示されるので
 *   「何色か」を見るのに適する。スペクトル帯もこちらで描く。
 * - `luminance`: 表示輝度を Y に比例させる。単色光なら 555nm 付近が最も明るく、
 *   両端は暗く沈む。人間の目の感度の波長依存性がそのまま見える。
 */
export type NormalizeMode = 'max' | 'luminance';

export interface ColorResult {
  /** 入力の三刺激値。 */
  readonly xyz: XYZ;
  readonly chromaticity: Chromaticity;
  /** 色域マッピングと正規化を経た linear RGB (0..1)。 */
  readonly linearRGB: LinearRGB;
  readonly rgb8: RGB8;
  readonly hex: string;
  /** sRGB の色域外か。可視域の単色光ではほぼ常に true。 */
  readonly outOfGamut: boolean;
  /**
   * 色域に入れるために加えた白の量(正規化前の linear RGB スケール)。
   * 大きいほど、本来の色より白っぽく表示されていることになる。
   */
  readonly whiteAdded: number;
  /**
   * 明るさが表示可能な上限を超えて頭打ちになったか(いわゆる白飛び)。
   *
   * `max` では定義上起こらない。`luminance` では、単色光 1 本なら共通スケール係数の
   * 決め方から起こらないが、複数の光を合成して輝度を積み上げると普通に起こる。
   * 黙って潰すと画面の色が物理を表さなくなるので、呼び出し側に伝える。
   */
  readonly clipped: boolean;
}

export interface WavelengthColor extends ColorResult {
  readonly lambdaNm: number;
  /** 分光視感効率 V(λ) = ȳ(λ)。555nm で 1.0。 */
  readonly luminousEfficiency: number;
}

/** 色域マッピングまで済ませた中間状態。正規化はまだしていない。 */
interface MappedColor {
  readonly xyz: XYZ;
  readonly rgb: LinearRGB;
  readonly outOfGamut: boolean;
  readonly whiteAdded: number;
}

function mapIntoGamut(xyz: XYZ): MappedColor {
  const mapped = desaturateIntoGamut(xyzToLinearSRGB(xyz));
  return {
    xyz,
    rgb: mapped.rgb,
    outOfGamut: mapped.outOfGamut,
    whiteAdded: mapped.whiteAdded,
  };
}

/** 表示輝度が元の Y に一致するようスケールする(共通係数を掛ける前の段階)。 */
function luminanceNormalized(mapped: MappedColor): LinearRGB {
  const y = relativeLuminance(mapped.rgb);
  if (y <= 0) return [0, 0, 0];
  // 白を w 足すと輝度も w だけ増える(linear RGB → Y の係数の総和が 1 のため)。
  // 元の輝度に戻すには、その分を割り戻せばよい。
  return scaleRGB(mapped.rgb, mapped.xyz[1] / y);
}

/**
 * `luminance` モードで使う全波長共通のスケール係数。
 *
 * 単色光それぞれで「表示輝度 = ȳ(λ)」となるようスケールすると、可視域のどこかで
 * RGB が 1 を超えてしまう。そこで最大値の逆数を一度だけ求めて全体に同じ係数を掛ける。
 * 係数が一定なので、輝度比は Y の比のまま保たれる。
 *
 * 基準を「単位放射強度の単色光」に取っているため、合成光のように輝度を積み上げた
 * 入力では 1 を超えうる。その場合は clipped が立つ。
 */
let luminanceScale: number | null = null;

function luminanceModeScale(): number {
  if (luminanceScale !== null) return luminanceScale;

  let peak = 0;
  for (let lambda = VISIBLE_LAMBDA_MIN; lambda <= VISIBLE_LAMBDA_MAX; lambda += 1) {
    const rgb = luminanceNormalized(mapIntoGamut(cmfAt(lambda)));
    peak = Math.max(peak, rgb[0], rgb[1], rgb[2]);
  }

  luminanceScale = peak > 0 ? 1 / peak : 1;
  return luminanceScale;
}

function normalize(mapped: MappedColor, mode: NormalizeMode): { rgb: LinearRGB; clipped: boolean } {
  if (mode === 'max') {
    return { rgb: normalizeToMaxComponent(mapped.rgb), clipped: false };
  }

  const scaled = scaleRGB(luminanceNormalized(mapped), luminanceModeScale());
  // 係数の決め方から、単色光ではちょうど 1 に届く波長がある。丸め誤差で
  // 白飛び扱いにならないよう、わずかな許容を置く。
  const clipped = Math.max(scaled[0], scaled[1], scaled[2]) > 1 + 1e-9;
  return { rgb: clamp01(scaled), clipped };
}

/**
 * 任意の三刺激値から表示用の色を求める。
 *
 * 単色光でも、複数の単色光の合成でも、連続スペクトルの積分結果でも入口はここ。
 */
export function xyzToColor(xyz: XYZ, mode: NormalizeMode = 'max'): ColorResult {
  const mapped = mapIntoGamut(xyz);
  const { rgb: linearRGB, clipped } = normalize(mapped, mode);
  const rgb8 = toRGB8(encodeGammaRGB(linearRGB));

  return {
    xyz,
    chromaticity: xyzToChromaticity(xyz),
    linearRGB,
    rgb8,
    hex: toHex(rgb8),
    outOfGamut: mapped.outOfGamut,
    whiteAdded: mapped.whiteAdded,
    clipped,
  };
}

/**
 * 波長 [nm] から表示用の色を求める。
 *
 * 単位放射強度の単色光を XYZ に直して xyzToColor に渡しているだけ。
 *
 * @param lambdaNm 波長 [nm]。可視域外を渡すと黒に近い色が返る。
 * @param mode 明るさの決め方。既定は `max`。
 */
export function wavelengthToColor(lambdaNm: number, mode: NormalizeMode = 'max'): WavelengthColor {
  const xyz = cmfAt(lambdaNm);
  return {
    ...xyzToColor(xyz, mode),
    lambdaNm,
    luminousEfficiency: xyz[1],
  };
}
