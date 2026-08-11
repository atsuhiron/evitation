/**
 * 温度プリセット。
 *
 * 身近な光源を並べて「その温度が色温度の目盛りのどこに当たるか」を示すのが主目的。
 * 効率が最大になる温度だけは手で書かず、実際に走査して求める — 合成ページの
 * プリセット強度を目標色度から解いているのと同じ理由。
 */

import { luminousEfficacy } from './planck.ts';
import { clampTemperature } from './temperature.ts';

export interface TemperaturePreset {
  readonly name: string;
  readonly hint: string;
  readonly temperatureK: number;
}

/**
 * 区間 [lo, hi] で f を最大にする点を黄金分割探索で求める。
 *
 * 発光効率は温度に対して単峰(可視域からピークが外れれば低温側でも高温側でも
 * 落ちる)なので、この探索が使える。
 */
function argmax(f: (x: number) => number, lo: number, hi: number, tolerance: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);

  while (b - a > tolerance) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/** 発光効率が最大になる温度。スライダーに載る整数 K に丸めて持つ。 */
export const PEAK_EFFICACY_TEMPERATURE_K = clampTemperature(
  argmax(luminousEfficacy, 3000, 12000, 0.5),
);

export const presets: readonly TemperaturePreset[] = [
  {
    name: 'ろうそくの炎',
    temperatureK: 1850,
    hint: '赤熱の側。放射のほとんどが赤外に落ちるため、発光効率は 2 lm/W ほどしかない。',
  },
  {
    name: '白熱電球',
    temperatureK: 2856,
    hint: 'CIE 標準イルミナント A の定義温度。効率の最大点から大きく外れており、電力の大半が熱として出ていく。',
  },
  {
    name: '太陽(表面)',
    temperatureK: 5778,
    hint: '有効温度。ピークがちょうど可視域の中央付近に来る。地表で見る太陽光は大気の吸収を受けるので、これとは分布が異なる。',
  },
  {
    name: `発光効率が最大 (${PEAK_EFFICACY_TEMPERATURE_K}K)`,
    temperatureK: PEAK_EFFICACY_TEMPERATURE_K,
    hint: '放射の総量を揃えたとき最も明るく見える温度。走査して求めた値で、それでも 95 lm/W ほど — 理想的な黒体でも放射の 86% は目に見えない。',
  },
  {
    name: '青色巨星',
    temperatureK: 20000,
    hint: 'ピークは紫外の奥。可視域に届くのは裾の部分だけなので、効率はふたたび落ちる。',
  },
];

/** 初期表示。ピークが可視域の中央に来る、いちばん見通しのよい温度。 */
export const defaultPreset = presets[2]!;
