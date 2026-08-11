/**
 * 可視光スペクトル帯。
 *
 * GradientBar を波長軸で設定しただけのもの。中身は全部あちら側にある。
 */

import { wavelengthToColor } from '../color/index.ts';
import { GradientBar } from './gradient-bar.ts';

export interface SpectrumBarOptions {
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /**
   * 帯の上で波長が選ばれたときに呼ばれる。値は整数 nm に丸めて渡す。
   * 省略すると帯は表示専用になる(成分が複数ある画面では、帯のどこを掴んでも
   * どれを動かすべきか決まらないため)。
   */
  readonly onSelect?: (lambdaNm: number) => void;
}

/**
 * 帯の色は常に最大成分正規化(`max`)で描く。
 *
 * 相対輝度で描くと両端が真っ黒に沈んで「どこがどの波長か」が読めなくなり、
 * 目盛りとして機能しなくなるため。各ページの表示モードとは意図的に独立させている。
 */
export function createSpectrumBar(options: SpectrumBarOptions): GradientBar {
  const { lambdaMin, lambdaMax, onSelect } = options;

  const ticks: number[] = [];
  for (let lambda = 400; lambda <= lambdaMax; lambda += 50) {
    ticks.push(lambda);
  }

  return new GradientBar({
    min: lambdaMin,
    max: lambdaMax,
    colorAt: (lambdaNm) => wavelengthToColor(lambdaNm, 'max').rgb8,
    ticks,
    onSelect: onSelect === undefined ? undefined : (value) => onSelect(Math.round(value)),
  });
}
