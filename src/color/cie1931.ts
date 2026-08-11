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
import type { XYZ } from './srgb.ts';

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
