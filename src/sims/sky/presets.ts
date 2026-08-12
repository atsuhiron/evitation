/**
 * 太陽高度のプリセット。
 *
 * 空の色が動くのは地平線の上下 10° に集中しているので、そこを拾うのが主目的。
 * スライダーを端から端まで引くだけでは、上半分ではほとんど何も起きない。
 */

export interface AltitudePreset {
  readonly name: string;
  readonly hint: string;
  readonly altitudeDeg: number;
}

export const presets: readonly AltitudePreset[] = [
  {
    name: '正午 (90°)',
    altitudeDeg: 90,
    hint: '太陽が天頂にある。空は東西対称で、天頂が最も濃い青になる。',
  },
  {
    name: '午後 (45°)',
    altitudeDeg: 45,
    hint: '昼間の典型。太陽側のほうが明るい。地球の影はまだ大気に届かないので、東西の差は位相関数の分だけ。',
  },
  {
    name: '夕方 (10°)',
    altitudeDeg: 10,
    hint: '太陽の周りが白から黄へ移り始める。エアロゾルを入れると太陽側だけが強く輝く。',
  },
  {
    name: '日没直前 (2°)',
    altitudeDeg: 2,
    hint: '西が橙、東はもう暗い。地球の影が東の低空を覆い始め、東西の差が一気に開く。',
  },
  {
    name: '日没 (0°)',
    altitudeDeg: 0,
    hint: '太陽が地平線に接する。ここから下は多重散乱の見積もりが 0 になる(平行平面の収支が使えなくなるため)。',
  },
  {
    name: '市民薄明 (−6°)',
    altitudeDeg: -6,
    hint: '地上は影の中で、照らされているのは高度 35km より上だけ。東の空から先に暗くなる。',
  },
  {
    name: '天文薄明の終わり (−18°)',
    altitudeDeg: -18,
    hint: '大気の上端まで影に入り、単散乱の寄与はほぼ尽きる。ここから先が夜。',
  },
];

/** 初期表示。太陽側と反対側の差が見え始め、かつ空が十分明るい高度。 */
export const defaultPreset = presets[1]!;
