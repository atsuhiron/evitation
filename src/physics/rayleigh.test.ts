import { describe, expect, it } from 'vitest';
import {
  cmfAt,
  spectrumToXYZ,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  xyzToChromaticity,
  xyzToColor,
  type XYZ,
} from '../color/index.ts';
import { normalizedSpectrum } from './planck.ts';
import {
  CO2_PPM,
  COLUMN_DENSITY,
  kingFactor,
  MEAN_MOLAR_MASS_AIR,
  opticalDepth,
  refractiveIndex,
  scatteringCrossSection,
  transmittance,
} from './rayleigh.ts';

function scaleXYZ(xyz: XYZ, factor: number): XYZ {
  return [xyz[0] * factor, xyz[1] * factor, xyz[2] * factor];
}

/** 波長 λ における log τ の傾き。実効的なべきを数値微分で取り出す。 */
function effectiveExponent(lambdaNm: number): number {
  const d = 1e-5;
  const hi = lambdaNm * (1 + d);
  const lo = lambdaNm * (1 - d);
  return (Math.log(opticalDepth(hi)) - Math.log(opticalDepth(lo))) / (Math.log(hi) - Math.log(lo));
}

/** 5778K の黒体が air mass m を通ったあとの三刺激値。 */
function transmittedSunXYZ(airMass: number): XYZ {
  return spectrumToXYZ(
    (lambdaNm) => normalizedSpectrum(lambdaNm, 5778) * transmittance(lambdaNm, airMass),
  );
}

describe('大気の光学定数', () => {
  /**
   * 断面積 σ(550nm) = 4.51e-27 cm² は、この分野で最も広く引かれている値
   * (Bodhaine et al. 1999)。
   *
   * この 1 本で、屈折率の分散式・キング因子・σ の式の 3 つをまとめて外部の基準に
   * 突き合わせられる。イルミナント A が黒体側で果たしているのと同じ役割。
   */
  it('550nm の散乱断面積が文献値 4.51e-27 cm² に一致', () => {
    // m² → cm² は 1e4 倍。
    expect(scatteringCrossSection(550) * 1e4).toBeCloseTo(4.51e-27, 29);
  });

  /**
   * τ_R(550nm) ≈ 0.097。
   *
   * 文献値には 0.0969–0.0974 の幅があり、その差はもっぱら重力加速度の取り方から来る
   * (Bodhaine は緯度 45° で大気の質量分布を重みにした実効値 9.7803 m/s² を使い、
   * こちらは SI の標準重力 9.80665 m/s² を使っている。差は 0.27%)。
   * どちらを採っても 1% には収まる。
   */
  it('550nm の光学的厚さが文献値 0.097 と 1% 以内で一致', () => {
    expect(opticalDepth(550) / 0.097).toBeCloseTo(1, 2);
  });

  it('550nm の屈折率が標準空気の値に一致', () => {
    expect(refractiveIndex(550)).toBeCloseTo(1.0002778, 7);
  });

  /**
   * 平均モル質量を組成の和として求めた結果が、Bodhaine が与えている当てはめ式
   * `m_a = 15.0556·CO₂ + 28.9595` [g/mol] と一致すること(CO₂ は体積分率)。
   * 組成表の取り違えや CO₂ の単位の間違いはここで落ちる。
   *
   * カラム密度は静水圧平衡そのもの。1cm² の柱に約 2.15e25 個。
   */
  it('平均モル質量とカラム密度が乾燥空気の値になる', () => {
    expect(MEAN_MOLAR_MASS_AIR * 1000).toBeCloseTo(15.0556 * (CO2_PPM * 1e-6) + 28.9595, 2);
    expect(COLUMN_DENSITY / 2.148e29).toBeCloseTo(1, 2);
  });

  /**
   * キング因子は分子の異方性による補正で、4% ほどある。
   * 1 に落として(= 等方な分子を仮定して)しまうと τ がその分だけ小さく出る。
   */
  it('キング因子が 1.04–1.06 の範囲で、長波長ほど小さい', () => {
    let previous = Infinity;
    for (let lambdaNm = 300; lambdaNm <= 1000; lambdaNm += 20) {
      const f = kingFactor(lambdaNm);
      expect(f, `${lambdaNm}nm`).toBeGreaterThan(1.04);
      expect(f, `${lambdaNm}nm`).toBeLessThan(1.06);
      expect(f, `${lambdaNm}nm`).toBeLessThan(previous);
      previous = f;
    }
  });
});

describe('λ⁻⁴ 則', () => {
  /**
   * べきが 4 ちょうどにならないこと。
   *
   * 屈折率の分散とキング因子の波長依存のぶんだけ 4 より急になる。λ⁻⁴ を
   * ベタ書きしていたら決して出てこない値なので、断面積を導出したことの証明になる。
   */
  it('可視域での実効的なべきが 4 よりわずかに大きい', () => {
    for (let lambdaNm = VISIBLE_LAMBDA_MIN; lambdaNm <= VISIBLE_LAMBDA_MAX; lambdaNm += 20) {
      const exponent = effectiveExponent(lambdaNm);
      expect(exponent, `${lambdaNm}nm`).toBeLessThan(-4);
      expect(exponent, `${lambdaNm}nm`).toBeGreaterThan(-4.25);
    }
    expect(effectiveExponent(550)).toBeCloseTo(-4.08, 2);
  });

  it('光学的厚さは波長に対して単調減少', () => {
    let previous = Infinity;
    for (let lambdaNm = 300; lambdaNm <= 1000; lambdaNm += 10) {
      const tau = opticalDepth(lambdaNm);
      expect(tau, `${lambdaNm}nm`).toBeLessThan(previous);
      previous = tau;
    }
  });

  /** 青(450nm)は赤(650nm)の 4 倍以上散乱される。これが空の青さと夕日の赤さの源。 */
  it('450nm は 650nm の 4 倍以上散乱される', () => {
    expect(opticalDepth(450) / opticalDepth(650)).toBeGreaterThan(4);
  });
});

describe('透過率', () => {
  it('air mass が 0 なら全波長で 1(大気圏外)', () => {
    for (let lambdaNm = 300; lambdaNm <= 1000; lambdaNm += 50) {
      expect(transmittance(lambdaNm, 0), `${lambdaNm}nm`).toBe(1);
    }
  });

  it('0 < T ≤ 1 で、air mass に対して単調減少', () => {
    for (const lambdaNm of [400, 550, 700]) {
      let previous = Infinity;
      for (let airMass = 0; airMass <= 38; airMass += 0.5) {
        const t = transmittance(lambdaNm, airMass);
        expect(t, `${lambdaNm}nm AM${airMass}`).toBeGreaterThan(0);
        expect(t, `${lambdaNm}nm AM${airMass}`).toBeLessThanOrEqual(1);
        expect(t, `${lambdaNm}nm AM${airMass}`).toBeLessThan(previous);
        previous = t;
      }
    }
  });

  /**
   * 青赤比の低下がこのページの主題。減光そのものより、
   * 「青のほうが速く減る」ことが色を動かしている。
   */
  it('青赤比 T(450)/T(650) が air mass とともに単調減少', () => {
    let previous = Infinity;
    for (let airMass = 0; airMass <= 38; airMass += 0.5) {
      const ratio = transmittance(450, airMass) / transmittance(650, airMass);
      expect(ratio, `AM${airMass}`).toBeLessThan(previous);
      previous = ratio;
    }
  });
});

describe('減衰後の色', () => {
  it('air mass が 0 なら入射と透過の三刺激値が完全に一致', () => {
    const incident = spectrumToXYZ((lambdaNm) => normalizedSpectrum(lambdaNm, 5778));
    expect(transmittedSunXYZ(0)).toEqual(incident);
  });

  /** 太陽が地平線に近づくほど赤くなる、という主張そのもの。 */
  it('air mass を上げると色度 x が単調増加し、輝度 Y が単調減少する(太陽)', () => {
    let previousX = -Infinity;
    let previousY = Infinity;
    for (let airMass = 0; airMass <= 38; airMass += 0.5) {
      const xyz = transmittedSunXYZ(airMass);
      const { x } = xyzToChromaticity(xyz);
      expect(x, `AM${airMass}`).toBeGreaterThan(previousX);
      expect(xyz[1], `AM${airMass}`).toBeLessThan(previousY);
      previousX = x;
      previousY = xyz[1];
    }
  });

  it('地平線では可視域の明るさが 1 割未満まで落ちる(太陽)', () => {
    const incident = spectrumToXYZ((lambdaNm) => normalizedSpectrum(lambdaNm, 5778));
    expect(transmittedSunXYZ(37.9)[1] / incident[1]).toBeLessThan(0.1);
  });

  /**
   * 単色光では色相が一切変わらない。
   *
   * 減衰は波長ごとの掛け算なので、波長が 1 本しかなければ三刺激値が定数倍される
   * だけで色度は動かない。「色が変わるのは連続スペクトルだからこそ」という、
   * このページのもうひとつの主張。
   */
  it('単色光では air mass によらず色度が変わらない', () => {
    for (const lambdaNm of [420, 480, 550, 620, 700]) {
      const base = xyzToChromaticity(cmfAt(lambdaNm));
      for (const airMass of [0, 1, 5, 20, 37.9]) {
        const t = transmittance(lambdaNm, airMass);
        const xy = xyzToChromaticity(scaleXYZ(cmfAt(lambdaNm), t));
        expect(xy.x, `${lambdaNm}nm AM${airMass}`).toBeCloseTo(base.x, 12);
        expect(xy.y, `${lambdaNm}nm AM${airMass}`).toBeCloseTo(base.y, 12);
      }
    }
  });

  /**
   * 減衰前後を同じスケールで表示するために、ページ側は「入射光の最大成分が 1 に
   * なる係数」を求めて透過光にも同じ値を掛ける。それが成り立つのは
   * xyzToColor の相対輝度モードが入力について 1 次同次だから。
   *
   * 依拠しているのが src/color/ 側の性質なので、暗黙の前提にしておくと
   * 将来変わったときに気付けない。ここで固定しておく。
   */
  it('相対輝度モードの linear RGB は入力の定数倍に比例する', () => {
    const xyz = transmittedSunXYZ(2);
    const base = xyzToColor(xyz, 'luminance').linearRGB;
    for (const k of [0.05, 0.3, 0.8]) {
      const scaled = xyzToColor(scaleXYZ(xyz, k), 'luminance').linearRGB;
      for (let i = 0; i < 3; i += 1) {
        expect(scaled[i]!, `k=${k} 成分${i}`).toBeCloseTo(base[i]! * k, 12);
      }
    }
  });
});
