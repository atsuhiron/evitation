/**
 * air mass のプリセット。
 *
 * AM という数字は素のままでは体感に結びつきにくいので、身近な状況を並べて
 * 「その値がどれくらいの高さの太陽にあたるか」を示すのが主目的。
 */

import { MAX_AIR_MASS } from './air-mass.ts';

export interface AirMassPreset {
  readonly name: string;
  readonly hint: string;
  readonly airMass: number;
}

export const presets: readonly AirMassPreset[] = [
  {
    name: '大気圏外',
    airMass: 0,
    hint: '減衰なしの基準。宇宙から見た太陽で、減衰前後の色が完全に一致する。',
  },
  {
    name: '天頂 (AM 1)',
    airMass: 1,
    hint: '真上の太陽。最も条件がよいこの場合でも、400nm の光は 3 割が散乱で失われている。',
  },
  {
    name: 'AM 1.5',
    airMass: 1.5,
    hint: '太陽電池の性能を測るときの標準条件。天頂角 48.2°、つまり太陽高度 42° にあたる。',
  },
  {
    name: '夕方 (AM 5)',
    airMass: 5,
    hint: '太陽高度が 11° ほど。黄から橙へ移りきるあたりで、青は元の 3 分の 1 まで落ちる。',
  },
  {
    name: `地平線 (AM ${MAX_AIR_MASS})`,
    airMass: MAX_AIR_MASS,
    hint: '日の出と日の入り。青はほぼ完全に消え、可視域の明るさも 1 割を切る。',
  },
];

/** 初期表示。天頂の太陽から始めて、スライダーを上げれば夕焼けへ向かう。 */
export const defaultPreset = presets[1]!;
