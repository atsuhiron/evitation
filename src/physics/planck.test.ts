import { describe, expect, it } from 'vitest';
import { xyzToChromaticity, xyzToColor } from '../color/index.ts';
import { MAX_TEMPERATURE_K, MIN_TEMPERATURE_K } from '../ui/temperature-axis.ts';
import {
  BOLTZMANN_CONSTANT,
  blackbodyXYZ,
  luminousEfficacy,
  LUMINOUS_EFFICACY_MAX,
  normalizedSpectrum,
  peakWavelengthNm,
  PLANCK_CONSTANT,
  radiantExitance,
  spectralRadiance,
  SPEED_OF_LIGHT,
  STEFAN_BOLTZMANN,
  totalRadiance,
  WIEN_DISPLACEMENT,
  WIEN_ROOT,
} from './planck.ts';

/** 対数刻みで λ を並べて台形則で積分する。桁をまたぐ裾まで拾うため。 */
function integrateSpectrum(
  f: (lambdaNm: number) => number,
  lambdaMinNm: number,
  lambdaMaxNm: number,
  steps: number,
): number {
  const logMin = Math.log(lambdaMinNm);
  const logMax = Math.log(lambdaMaxNm);
  let total = 0;
  let previousLambda = lambdaMinNm;
  let previousValue = f(lambdaMinNm);

  for (let i = 1; i <= steps; i += 1) {
    const lambda = Math.exp(logMin + ((logMax - logMin) * i) / steps);
    const value = f(lambda);
    total += ((value + previousValue) / 2) * (lambda - previousLambda);
    previousLambda = lambda;
    previousValue = value;
  }
  return total;
}

describe('導出定数', () => {
  /**
   * σ も b も SI 定義値からの導出なので、CODATA の推奨値と桁まで一致するはず。
   * 式を書き間違えていれば必ずここで落ちる。
   */
  it('シュテファン・ボルツマン定数が CODATA 値に一致', () => {
    expect(STEFAN_BOLTZMANN / 5.670374419e-8).toBeCloseTo(1, 9);
  });

  it('ウィーンの変位定数が CODATA 値に一致', () => {
    expect(WIEN_DISPLACEMENT / 2.897771955e-3).toBeCloseTo(1, 9);
  });

  it('ウィーンの根が x = 5(1 − e⁻ˣ) を満たす', () => {
    expect(WIEN_ROOT).toBeCloseTo(5 * (1 - Math.exp(-WIEN_ROOT)), 12);
    // 自明な根 x = 0 に落ちていないこと。
    expect(WIEN_ROOT).toBeGreaterThan(4);
  });

  it('SI 定義値がそのまま入っている', () => {
    expect(PLANCK_CONSTANT).toBe(6.62607015e-34);
    expect(SPEED_OF_LIGHT).toBe(299792458);
    expect(BOLTZMANN_CONSTANT).toBe(1.380649e-23);
  });
});

describe('プランクの法則', () => {
  /**
   * ∫B_λ dλ = σT⁴/π。
   *
   * この一本で「プランクの法則の式」と「導出した σ」が互いに検算し合う。
   * 片方だけ間違えていても一致しないので、この節で最も強い検査。
   */
  it.each([1000, 2856, 5778, 20000])('%dK: 全波長積分が σT⁴/π に一致', (temperatureK) => {
    const numeric = integrateSpectrum(
      (lambdaNm) => spectralRadiance(lambdaNm, temperatureK),
      1,
      1e7,
      20000,
    );
    expect(numeric / totalRadiance(temperatureK)).toBeCloseTo(1, 3);
  });

  it.each([1000, 2856, 5778, 20000])('%dK: 数値的なピーク位置が λmax に一致', (temperatureK) => {
    const expected = peakWavelengthNm(temperatureK);

    // λmax の周りを細かく走査して、実際の最大がそこに立つことを見る。
    let best = { lambdaNm: 0, value: -Infinity };
    for (let lambdaNm = expected * 0.5; lambdaNm <= expected * 1.5; lambdaNm += expected * 1e-4) {
      const value = spectralRadiance(lambdaNm, temperatureK);
      if (value > best.value) best = { lambdaNm, value };
    }
    expect(best.lambdaNm / expected).toBeCloseTo(1, 3);
  });

  it('ウィーンの変位則: λmax·T が温度によらず一定', () => {
    const reference = peakWavelengthNm(1000) * 1000;
    for (const temperatureK of [1500, 3000, 6000, 12000, 20000]) {
      expect(peakWavelengthNm(temperatureK) * temperatureK, `${temperatureK}K`).toBeCloseTo(
        reference,
        6,
      );
    }
  });

  /**
   * 長波長側の極限 B_λ → 2ckT/λ⁴。
   *
   * ここは exp(x) − 1 をそのまま書くと桁落ちで壊れる領域なので、expm1 を
   * 使っていることの担保になっている。
   *
   * レイリー・ジーンズは展開の最低次でしかなく、残差は x/2 = hc/(2λkT) の
   * オーダーで残る。そこで「ある波長で十分近い」ことではなく「波長を 10 倍
   * すれば残差が 1/10 になる」ことを見る。極限であることの主張としてはこちらが強い。
   */
  it('レイリー・ジーンズ極限: 長波長で 2ckT/λ⁴ に漸近', () => {
    const temperatureK = 5778;
    const rayleighJeans = (lambdaNm: number): number => {
      const lambda = lambdaNm * 1e-9;
      return ((2 * SPEED_OF_LIGHT * BOLTZMANN_CONSTANT * temperatureK) / lambda ** 4) * 1e-9;
    };

    const deviations = [1e6, 1e7, 1e8].map(
      (lambdaNm) => Math.abs(spectralRadiance(lambdaNm, temperatureK) / rayleighJeans(lambdaNm) - 1),
    );

    for (let i = 1; i < deviations.length; i += 1) {
      expect(deviations[i - 1]! / deviations[i]!, `${i} 段目`).toBeCloseTo(10, 1);
    }
    expect(deviations.at(-1)).toBeLessThan(1e-4);
  });

  /** 短波長側の極限(ウィーンの近似)。指数が支配するので分母の −1 が効かなくなる。 */
  it('ウィーン近似: 短波長で (2hc²/λ⁵)e^(−hc/λkT) に漸近', () => {
    const temperatureK = 5778;
    for (const lambdaNm of [100, 150, 200]) {
      const lambda = lambdaNm * 1e-9;
      const c2 = (PLANCK_CONSTANT * SPEED_OF_LIGHT) / BOLTZMANN_CONSTANT;
      const expected =
        ((2 * PLANCK_CONSTANT * SPEED_OF_LIGHT ** 2) / lambda ** 5) *
        Math.exp(-c2 / (lambda * temperatureK)) *
        1e-9;
      expect(spectralRadiance(lambdaNm, temperatureK) / expected, `${lambdaNm}nm`).toBeCloseTo(1, 3);
    }
  });

  /**
   * 極端な入力で Infinity や NaN が漏れないこと。
   * 低温 × 短波長では exp が overflow するが、そこは 0 が返るのが正しい。
   */
  it('扱う範囲の全域で有限かつ非負', () => {
    for (
      let temperatureK = MIN_TEMPERATURE_K;
      temperatureK <= MAX_TEMPERATURE_K;
      temperatureK += 250
    ) {
      for (const lambdaNm of [1, 10, 100, 380, 555, 780, 3000, 1e5, 1e7]) {
        const value = spectralRadiance(lambdaNm, temperatureK);
        expect(Number.isFinite(value), `${temperatureK}K ${lambdaNm}nm`).toBe(true);
        expect(value, `${temperatureK}K ${lambdaNm}nm`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * ∂B/∂T > 0 が全波長で成り立つ、つまり温度の違うプランク曲線は交差しない。
   *
   * 対数目盛モードの説明文「高温の曲線が全波長で低温より上に来る」が主張している
   * 内容そのもの。ピーク波長だけを見ていると「低温は長波長側で有利」と誤解しやすいが、
   * 実際にはどの波長でも高温の方が明るい。
   */
  it('温度が高いほど、あらゆる波長で分光放射輝度が大きい', () => {
    const temperatures = [1000, 1500, 2856, 5778, 10000, 20000];
    for (let i = 1; i < temperatures.length; i += 1) {
      const lower = temperatures[i - 1]!;
      const higher = temperatures[i]!;
      for (let lambdaNm = 120; lambdaNm <= 3000; lambdaNm += 20) {
        expect(
          spectralRadiance(lambdaNm, higher),
          `${lambdaNm}nm: ${higher}K vs ${lower}K`,
        ).toBeGreaterThan(spectralRadiance(lambdaNm, lower));
      }
    }
  });

  it('波長や温度が正でなければ 0', () => {
    expect(spectralRadiance(0, 5778)).toBe(0);
    expect(spectralRadiance(-500, 5778)).toBe(0);
    expect(spectralRadiance(500, 0)).toBe(0);
    expect(spectralRadiance(500, -100)).toBe(0);
    expect(spectralRadiance(Number.NaN, 5778)).toBe(0);
  });

  it('放射発散度は σT⁴、放射輝度はその 1/π', () => {
    expect(radiantExitance(5778)).toBeCloseTo(STEFAN_BOLTZMANN * 5778 ** 4, 6);
    expect(totalRadiance(5778) * Math.PI).toBeCloseTo(radiantExitance(5778), 6);
  });

  it.each([1000, 5778, 20000])('%dK: 正規化スペクトルの全波長積分が 1', (temperatureK) => {
    const total = integrateSpectrum(
      (lambdaNm) => normalizedSpectrum(lambdaNm, temperatureK),
      1,
      1e7,
      20000,
    );
    expect(total).toBeCloseTo(1, 3);
  });
});

describe('黒体の色', () => {
  /**
   * CIE 標準イルミナント A は「2856K のプランク放射体」として定義されており、
   * その色度は規格上 (0.44758, 0.40745) と決まっている。
   *
   * つまりこの 1 本で、プランクの法則・等色関数テーブル・spectrumToXYZ の積分を
   * まとめて外部の基準に突き合わせられる。この一連で最も価値のある検査。
   */
  it('2856K の色度が標準イルミナント A に一致', () => {
    const xy = xyzToChromaticity(blackbodyXYZ(2856));
    expect(xy.x).toBeCloseTo(0.44758, 3);
    expect(xy.y).toBeCloseTo(0.40745, 3);
  });

  /** 6504K は D65 の相関色温度。黒体軌跡上の点なので D65 そのものとは僅かにずれる。 */
  it('6504K の色度が D65 の近傍にある', () => {
    const xy = xyzToChromaticity(blackbodyXYZ(6504));
    expect(Math.hypot(xy.x - 0.3127, xy.y - 0.329)).toBeLessThan(0.01);
  });

  it('温度が上がるほど色度 x は単調に減少する(赤 → 青)', () => {
    let previous = Infinity;
    for (
      let temperatureK = MIN_TEMPERATURE_K;
      temperatureK <= MAX_TEMPERATURE_K;
      temperatureK += 100
    ) {
      const { x } = xyzToChromaticity(blackbodyXYZ(temperatureK));
      expect(x, `${temperatureK}K`).toBeLessThan(previous);
      previous = x;
    }
  });

  it('低温は赤みが、高温は青みが強い', () => {
    const [rLow, , bLow] = xyzToColor(blackbodyXYZ(1200), 'max').rgb8;
    const [rHigh, , bHigh] = xyzToColor(blackbodyXYZ(20000), 'max').rgb8;
    expect(rLow).toBeGreaterThan(bLow);
    expect(bHigh).toBeGreaterThan(rHigh);
  });

  /**
   * 色は分光分布の「形」だけで決まり、全体を何倍しても変わらない。
   * 正規化の係数を取り違えても色は変わらない、ということの確認でもある。
   */
  it('スペクトルを定数倍しても max モードの色は変わらない', () => {
    for (const temperatureK of [1500, 5778, 12000]) {
      const base = xyzToColor(blackbodyXYZ(temperatureK), 'max').rgb8;
      for (const factor of [1e-6, 1e6]) {
        const scaled = blackbodyXYZ(temperatureK).map((v) => v * factor) as [
          number,
          number,
          number,
        ];
        expect(xyzToColor(scaled, 'max').rgb8, `${temperatureK}K x${factor}`).toEqual(base);
      }
    }
  });
});

describe('発光効率', () => {
  /**
   * 効率が最大になる温度を、プリセット側の黄金分割探索とは独立に総当たりで求める。
   * プリセットの値が正しいかどうかは presets.test.ts がこの性質を使って検査する。
   */
  const peakTemperatureK = ((): number => {
    let best = { temperatureK: 0, efficacy: -Infinity };
    for (let temperatureK = 3000; temperatureK <= 12000; temperatureK += 5) {
      const efficacy = luminousEfficacy(temperatureK);
      if (efficacy > best.efficacy) best = { temperatureK, efficacy };
    }
    return best.temperatureK;
  })();

  it('最大でも約 95 lm/W', () => {
    const peak = luminousEfficacy(peakTemperatureK);
    expect(peak).toBeGreaterThan(90);
    expect(peak).toBeLessThan(100);
  });

  it('最大を与える温度が 6000–7000K に入る', () => {
    expect(peakTemperatureK).toBeGreaterThan(6000);
    expect(peakTemperatureK).toBeLessThan(7000);
  });

  it('効率は温度について単峰(最大の外側では単調に落ちる)', () => {
    const peak = luminousEfficacy(peakTemperatureK);
    for (
      let temperatureK = MIN_TEMPERATURE_K;
      temperatureK <= MAX_TEMPERATURE_K;
      temperatureK += 50
    ) {
      expect(luminousEfficacy(temperatureK), `${temperatureK}K`).toBeLessThanOrEqual(peak + 1e-9);
    }
  });

  it('効率は K_m·Y そのもの', () => {
    expect(luminousEfficacy(5778)).toBeCloseTo(LUMINOUS_EFFICACY_MAX * blackbodyXYZ(5778)[1], 12);
  });

  /** 可視域から外れた温度では、放射の総量を揃えても目に見える分はごく僅かになる。 */
  it('1000K の効率は 1 lm/W 未満', () => {
    expect(luminousEfficacy(1000)).toBeLessThan(1);
  });
});
