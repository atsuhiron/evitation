/**
 * 3x3 行列のごく小さなヘルパ。
 *
 * 色変換行列を数値でベタ書きせず「原色の色度」から導出するために使う。
 * ベタ書きされた 9 個の数値は出所が追えず検算もできないが、原色の色度は
 * sRGB の規格そのものなので、そちらを定数として持つ方が正しい。
 */

/** 行優先(row-major)の 3x3 行列。 */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type Vec3 = readonly [number, number, number];

export function multiplyMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** 逆行列。特異行列を渡された場合は例外を投げる。 */
export function invert(m: Mat3): Mat3 {
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) {
    throw new Error(`invert: 行列が特異です (det=${det})`);
  }
  const d = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * d,
    (m[2] * m[7] - m[1] * m[8]) * d,
    (m[1] * m[5] - m[2] * m[4]) * d,

    (m[5] * m[6] - m[3] * m[8]) * d,
    (m[0] * m[8] - m[2] * m[6]) * d,
    (m[2] * m[3] - m[0] * m[5]) * d,

    (m[3] * m[7] - m[4] * m[6]) * d,
    (m[1] * m[6] - m[0] * m[7]) * d,
    (m[0] * m[4] - m[1] * m[3]) * d,
  ];
}

/** 各列を s の対応する成分でスケールする(列スケーリング)。 */
export function scaleColumns(m: Mat3, s: Vec3): Mat3 {
  return [
    m[0] * s[0], m[1] * s[1], m[2] * s[2],
    m[3] * s[0], m[4] * s[1], m[5] * s[2],
    m[6] * s[0], m[7] * s[1], m[8] * s[2],
  ];
}
