/**
 * CIE XYZ から sRGB への変換。
 *
 * 単色光を扱ううえで本質的に重要なのは「単色光はほぼ全ての波長で sRGB 色域の外にある」
 * という点。スペクトル軌跡は sRGB の三角形の外側を通るので、変換結果の linear RGB には
 * 必ずと言っていいほど負の成分が現れる。この負値をどう潰すかで見た目が決まるため、
 * その処理(色域マッピング)は隠さず、どれだけ手を加えたかを呼び出し側に返す。
 */

import { invert, multiplyMat3Vec3, scaleColumns, type Mat3, type Vec3 } from './mat3.ts';

export type XYZ = Vec3;
export type LinearRGB = Vec3;
export type RGB8 = readonly [number, number, number];

/** xy 色度座標。 */
export interface Chromaticity {
  readonly x: number;
  readonly y: number;
}

// --- sRGB の規格値 (IEC 61966-2-1) -------------------------------------------
// 変換行列そのものではなく、行列の出所である原色と白色点の色度を定数として持つ。

export const SRGB_PRIMARIES = {
  r: { x: 0.64, y: 0.33 },
  g: { x: 0.3, y: 0.6 },
  b: { x: 0.15, y: 0.06 },
} as const satisfies Record<'r' | 'g' | 'b', Chromaticity>;

/** CIE 標準イルミナント D65 の色度(sRGB の白色点)。 */
export const D65: Chromaticity = { x: 0.3127, y: 0.329 };

/** 等エネルギー白(CIE 標準イルミナント E)の色度。 */
export const ILLUMINANT_E: Chromaticity = { x: 1 / 3, y: 1 / 3 };

/**
 * 色度 (x, y) と輝度 Y から XYZ を作る。
 * y = 0 は物理的に意味を持たない(輝度ゼロの方向)ため黒を返す。
 */
export function chromaticityToXYZ(c: Chromaticity, luminanceY = 1): XYZ {
  if (c.y === 0) return [0, 0, 0];
  const scale = luminanceY / c.y;
  return [c.x * scale, luminanceY, (1 - c.x - c.y) * scale];
}

/** XYZ から xy 色度を求める。XYZ が全て 0 のときは白色点を返す。 */
export function xyzToChromaticity(xyz: XYZ): Chromaticity {
  const sum = xyz[0] + xyz[1] + xyz[2];
  if (sum === 0) return D65;
  return { x: xyz[0] / sum, y: xyz[1] / sum };
}

/**
 * 原色 3 つと白色点の色度から linear RGB → XYZ 行列を導出する。
 *
 * 手順は標準的なもの: 各原色の色度から輝度を 1 に正規化した列ベクトルを並べ、
 * 「(1,1,1) を入れたら白色点の XYZ が出る」という条件から各列のスケールを解く。
 */
export function rgbToXyzMatrix(
  primaries: { r: Chromaticity; g: Chromaticity; b: Chromaticity },
  whitePoint: Chromaticity,
): Mat3 {
  const column = (c: Chromaticity): Vec3 => [c.x / c.y, 1, (1 - c.x - c.y) / c.y];
  const [rx, ry, rz] = column(primaries.r);
  const [gx, gy, gz] = column(primaries.g);
  const [bx, by, bz] = column(primaries.b);

  const base: Mat3 = [rx, gx, bx, ry, gy, by, rz, gz, bz];
  const white = chromaticityToXYZ(whitePoint, 1);
  const scales = multiplyMat3Vec3(invert(base), white);

  return scaleColumns(base, scales);
}

export const LINEAR_SRGB_TO_XYZ: Mat3 = rgbToXyzMatrix(SRGB_PRIMARIES, D65);
export const XYZ_TO_LINEAR_SRGB: Mat3 = invert(LINEAR_SRGB_TO_XYZ);

export function xyzToLinearSRGB(xyz: XYZ): LinearRGB {
  return multiplyMat3Vec3(XYZ_TO_LINEAR_SRGB, xyz);
}

export function linearSRGBToXYZ(rgb: LinearRGB): XYZ {
  return multiplyMat3Vec3(LINEAR_SRGB_TO_XYZ, rgb);
}

/**
 * linear RGB の相対輝度 Y。
 * LINEAR_SRGB_TO_XYZ の 2 行目そのもの(いわゆる 0.2126 / 0.7152 / 0.0722)。
 */
export function relativeLuminance(rgb: LinearRGB): number {
  return (
    LINEAR_SRGB_TO_XYZ[3] * rgb[0] +
    LINEAR_SRGB_TO_XYZ[4] * rgb[1] +
    LINEAR_SRGB_TO_XYZ[5] * rgb[2]
  );
}

// --- 色域マッピング -----------------------------------------------------------

export interface GamutMapResult {
  /** 全成分が 0 以上になった linear RGB。上限 1 のクリップはまだ行っていない。 */
  readonly rgb: LinearRGB;
  /** 元の linear RGB に負の成分があったか(= sRGB 色域外だったか)。 */
  readonly outOfGamut: boolean;
  /** 色域に入れるために加えた白の量(linear RGB の単位)。0 なら無加工。 */
  readonly whiteAdded: number;
}

/**
 * 負の成分を、白を足すことで解消する。
 *
 * 単に 0 でクリップすると色相まで動いてしまう。白を等量加えるのは
 * 「彩度だけを落として色相を保つ」操作にあたり、色域外の単色光を表示する際の
 * 定番の扱い。加えた白の量は whiteAdded として返し、UI 側で
 * 「実際にはもっと鮮やかな色である」ことを提示できるようにする。
 *
 * 白を w だけ足すと輝度 Y もちょうど w だけ増える点に注意
 * (linear RGB → Y の係数の総和が 1 なので)。
 */
export function desaturateIntoGamut(rgb: LinearRGB): GamutMapResult {
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  if (min >= 0) {
    return { rgb, outOfGamut: false, whiteAdded: 0 };
  }
  const w = -min;
  return {
    rgb: [rgb[0] + w, rgb[1] + w, rgb[2] + w],
    outOfGamut: true,
    whiteAdded: w,
  };
}

/** 最大成分が 1 になるようスケールする。全成分 0 のときは黒のまま。 */
export function normalizeToMaxComponent(rgb: LinearRGB): LinearRGB {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (max <= 0) return [0, 0, 0];
  return [rgb[0] / max, rgb[1] / max, rgb[2] / max];
}

export function scaleRGB(rgb: LinearRGB, s: number): LinearRGB {
  return [rgb[0] * s, rgb[1] * s, rgb[2] * s];
}

/** 0..1 の範囲に収める。色域マッピング後の最終段でのみ使う。 */
export function clamp01(rgb: LinearRGB): LinearRGB {
  return [
    Math.min(1, Math.max(0, rgb[0])),
    Math.min(1, Math.max(0, rgb[1])),
    Math.min(1, Math.max(0, rgb[2])),
  ];
}

// --- 伝達関数(ガンマ) -------------------------------------------------------

const GAMMA_THRESHOLD_LINEAR = 0.0031308;
const GAMMA_THRESHOLD_ENCODED = 0.04045;

/** linear → sRGB (IEC 61966-2-1 の伝達関数)。 */
export function encodeGamma(c: number): number {
  if (c <= GAMMA_THRESHOLD_LINEAR) return 12.92 * c;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB → linear。 */
export function decodeGamma(c: number): number {
  if (c <= GAMMA_THRESHOLD_ENCODED) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

export function encodeGammaRGB(rgb: LinearRGB): Vec3 {
  return [encodeGamma(rgb[0]), encodeGamma(rgb[1]), encodeGamma(rgb[2])];
}

// --- 出力形式 -----------------------------------------------------------------

/** ガンマ適用済みの 0..1 を 8bit 整数へ。 */
export function toRGB8(encoded: Vec3): RGB8 {
  return [
    Math.round(Math.min(1, Math.max(0, encoded[0])) * 255),
    Math.round(Math.min(1, Math.max(0, encoded[1])) * 255),
    Math.round(Math.min(1, Math.max(0, encoded[2])) * 255),
  ];
}

export function toHex(rgb8: RGB8): string {
  const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  return `#${hex(rgb8[0])}${hex(rgb8[1])}${hex(rgb8[2])}`;
}
