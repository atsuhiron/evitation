/**
 * CIE 1931 2° 標準観測者の等色関数へのアクセス。
 *
 * テーブル本体は cie1931-data.ts(生成物)にあり、このファイルは
 * 補間と積分だけを担当する。
 */

import {
  CMF_DATA,
  CMF_LAMBDA_MAX,
  CMF_LAMBDA_MIN,
  CMF_SAMPLE_COUNT,
} from './cie1931-data.ts';
import { invert, multiplyMat3Vec3, type Mat3 } from './mat3.ts';
import { xyzToChromaticity, type Chromaticity, type XYZ } from './srgb.ts';

export { CMF_LAMBDA_MAX, CMF_LAMBDA_MIN };

/**
 * UI で扱う可視域。
 *
 * テーブル自体は 360–830nm を持っているが、両端では等色関数がほぼ 0 に落ちて
 * 事実上見えないので、入力範囲としてはこの範囲を使う。
 */
export const VISIBLE_LAMBDA_MIN = 380;
export const VISIBLE_LAMBDA_MAX = 780;

function sampleAt(index: number): XYZ {
  const base = index * 3;
  return [CMF_DATA[base] ?? 0, CMF_DATA[base + 1] ?? 0, CMF_DATA[base + 2] ?? 0];
}

/**
 * 波長 λ [nm] における等色関数の値 (x̄, ȳ, z̄)。
 *
 * テーブルは 1nm 刻みなので、整数波長ならそのまま、小数を含む波長なら
 * 線形補間する。テーブルの範囲外は 0(見えない)。
 */
export function cmfAt(lambdaNm: number): XYZ {
  if (!Number.isFinite(lambdaNm) || lambdaNm < CMF_LAMBDA_MIN || lambdaNm > CMF_LAMBDA_MAX) {
    return [0, 0, 0];
  }

  const pos = lambdaNm - CMF_LAMBDA_MIN; // 刻み幅 1nm なので位置 = 添字
  const i = Math.floor(pos);
  const frac = pos - i;

  const a = sampleAt(i);
  if (frac === 0 || i + 1 >= CMF_SAMPLE_COUNT) return a;

  const b = sampleAt(i + 1);
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ];
}

/**
 * 分光視感効率 V(λ)。等色関数の ȳ そのもので、555nm でピーク 1.0 をとる。
 * 「同じ放射エネルギーでも波長によって明るさの感じ方が違う」という部分を担う関数。
 */
export function luminousEfficiency(lambdaNm: number): number {
  return cmfAt(lambdaNm)[1];
}

export interface SpectrumIntegrationOptions {
  /** 積分範囲の下限 [nm]。既定はテーブル下限。 */
  readonly lambdaMin?: number;
  /** 積分範囲の上限 [nm]。既定はテーブル上限。 */
  readonly lambdaMax?: number;
  /** 積分の刻み [nm]。既定は 1nm(テーブルの刻みと同じ)。 */
  readonly stepNm?: number;
}

/**
 * 任意の分光分布 S(λ) を等色関数で重み付き積分して XYZ を得る。
 *
 *   X = ∫ S(λ) x̄(λ) dλ,  Y = ∫ S(λ) ȳ(λ) dλ,  Z = ∫ S(λ) z̄(λ) dλ
 *
 * 単色光は δ 関数なのでこの積分ではなく cmfAt を直接使うが、薄膜干渉の反射
 * スペクトルや干渉縞のように連続スペクトルを扱う場面ではこちらを使う。
 *
 * 返り値は絶対量ではなく S の与え方に対する相対値。表示に使うときは
 * 呼び出し側で正規化すること。
 */
export function spectrumToXYZ(
  spectrum: (lambdaNm: number) => number,
  options: SpectrumIntegrationOptions = {},
): XYZ {
  const lambdaMin = options.lambdaMin ?? CMF_LAMBDA_MIN;
  const lambdaMax = options.lambdaMax ?? CMF_LAMBDA_MAX;
  const step = options.stepNm ?? 1;

  if (step <= 0) throw new Error(`stepNm は正の数である必要があります: ${step}`);

  let x = 0;
  let y = 0;
  let z = 0;

  // 台形則。刻みが細かいので端点の重み 1/2 の有無で結果はほとんど変わらないが、
  // 積分範囲を変えたときに値がぶれないようにしておく。
  const steps = Math.floor((lambdaMax - lambdaMin) / step);
  for (let i = 0; i <= steps; i += 1) {
    const lambda = lambdaMin + i * step;
    const weight = i === 0 || i === steps ? 0.5 : 1;
    const s = spectrum(lambda) * weight;
    if (s === 0) continue;
    const cmf = cmfAt(lambda);
    x += s * cmf[0];
    y += s * cmf[1];
    z += s * cmf[2];
  }

  return [x * step, y * step, z * step];
}

// --- 単色光の合成 -------------------------------------------------------------

export interface SpectralLine {
  readonly lambdaNm: number;
  /** 相対放射強度。 */
  readonly intensity: number;
}

/**
 * 複数の単色光を重ね合わせた光の三刺激値。
 *
 *   XYZ = Σ Iᵢ · cmf(λᵢ)
 *
 * 単色光は δ 関数なので spectrumToXYZ の積分ではなくこちらを使う。
 *
 * 合成が単なる和で書けるのがグラスマンの法則で、これが成り立つのは XYZ 空間の中だけ。
 * 波長を平均しても RGB の 8bit 値を足しても、混色の結果にはならない。
 *
 * なお、ここで足しているのは強度であってスペクトルの振幅ではない。つまり
 * インコヒーレントな重ね合わせで、干渉は起きない前提。
 */
export function spectralLinesToXYZ(lines: readonly SpectralLine[]): XYZ {
  let x = 0;
  let y = 0;
  let z = 0;

  for (const line of lines) {
    if (line.intensity === 0) continue;
    const cmf = cmfAt(line.lambdaNm);
    x += line.intensity * cmf[0];
    y += line.intensity * cmf[1];
    z += line.intensity * cmf[2];
  }

  return [x, y, z];
}

export interface MixSolution {
  /** 各波長の放射強度。 */
  readonly intensities: readonly [number, number, number];
  /**
   * 全ての強度が 0 以上か。
   *
   * false は「目標の色度が、この 3 波長が色度図上に張る三角形の外にある」ことを意味する。
   * 負の強度は物理的には作れない(光を引くことはできない)。
   */
  readonly feasible: boolean;
}

/**
 * 3 つの単色光から目標の三刺激値を作るのに必要な放射強度を求める。
 *
 * 各波長の等色関数を列に並べた行列を C とすると、求めるのは C·I = XYZ の解。
 * 合成が XYZ の線形和である(spectralLinesToXYZ)以上、これは 3 元 1 次方程式にすぎない。
 *
 * 3 波長が相異なれば C は正則。同じ波長を重複して渡すと特異になり invert が例外を投げる。
 */
export function solveMixIntensities(
  lambdas: readonly [number, number, number],
  targetXYZ: XYZ,
): MixSolution {
  const [a, b, c] = [cmfAt(lambdas[0]), cmfAt(lambdas[1]), cmfAt(lambdas[2])];

  // 等色関数を「列」に並べる(Mat3 は行優先なので転置して書く)。
  const matrix: Mat3 = [
    a[0], b[0], c[0],
    a[1], b[1], c[1],
    a[2], b[2], c[2],
  ];

  const intensities = multiplyMat3Vec3(invert(matrix), targetXYZ);
  return {
    intensities,
    feasible: intensities[0] >= 0 && intensities[1] >= 0 && intensities[2] >= 0,
  };
}

export interface TwoLineMixSolution {
  /** 各波長の放射強度。 */
  readonly intensities: readonly [number, number];
  /** 実際に到達する色度。 */
  readonly chromaticity: Chromaticity;
  /** 目標色度からのずれ(xy 平面上の距離)。 */
  readonly distance: number;
}

/**
 * 2 つの単色光の混合で、目標の色度にできるだけ近づく強度比を求める。
 *
 * 2 波長では自由度が足りないので、到達できるのは色度図上で 2 点を結ぶ線分の上だけ。
 * そこで目標をその線分へ射影する。どれだけ届かなかったかは distance で返す
 * (真の補色対どうしなら 0 になる)。
 *
 * 混合後の色度は (X+Y+Z) を重みとした 2 点の内分点になる。これは色度が XYZ を
 * その総和で割ったものである以上、当然そうなる。したがって内分比 t が決まれば
 * 放射強度は (1-t)/Σcmf(λ₁) : t/Σcmf(λ₂) で定まる。
 */
export function solveTwoLineMix(
  lambda1: number,
  lambda2: number,
  target: Chromaticity,
): TwoLineMixSolution {
  const c1 = cmfAt(lambda1);
  const c2 = cmfAt(lambda2);
  const xy1 = xyzToChromaticity(c1);
  const xy2 = xyzToChromaticity(c2);

  const dx = xy2.x - xy1.x;
  const dy = xy2.y - xy1.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    throw new Error(`色度が同一の 2 波長では比率を決められません: ${lambda1}nm, ${lambda2}nm`);
  }

  const raw = ((target.x - xy1.x) * dx + (target.y - xy1.y) * dy) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));

  const sum1 = c1[0] + c1[1] + c1[2];
  const sum2 = c2[0] + c2[1] + c2[2];
  const intensities: readonly [number, number] = [(1 - t) / sum1, t / sum2];

  const chromaticity = xyzToChromaticity(
    spectralLinesToXYZ([
      { lambdaNm: lambda1, intensity: intensities[0] },
      { lambdaNm: lambda2, intensity: intensities[1] },
    ]),
  );

  return {
    intensities,
    chromaticity,
    distance: Math.hypot(chromaticity.x - target.x, chromaticity.y - target.y),
  };
}
