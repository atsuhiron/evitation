import { describe, expect, it } from 'vitest';
import { spectrumToXYZ, xyzToChromaticity, xyzToColor, type XYZ } from '../color/index.ts';
import { aerosolOpticalDepth } from './aerosol.ts';
import { DEFAULT_SHAPE } from './atmosphere.ts';
import { blackbodyXYZ, normalizedSpectrum } from './planck.ts';
import { opticalDepth } from './rayleigh.ts';
import {
  azimuthAveragedPhase,
  createSkyModel,
  multipleScatteringFloor,
  planeParallelRadiance,
  planeParallelRadianceWithAirMass,
  rayleighPhase,
  scatteringAngleDeg,
  scatteringBudget,
  sphericalRadiance,
  sunSkyAngleDeg,
  type SkyConditions,
} from './sky.ts';

const DEG = Math.PI / 180;

/** 既定の条件。個々のテストで必要なところだけ上書きする。 */
function conditions(overrides: Partial<SkyConditions> = {}): SkyConditions {
  return {
    sunAltitudeDeg: 45,
    temperatureK: 5778,
    multipleScattering: false,
    aerosolOpticalDepth: 0,
    ...overrides,
  };
}

function model(overrides: Partial<SkyConditions> = {}): ReturnType<typeof createSkyModel> {
  return createSkyModel(conditions(overrides));
}

/** その方向の輝度 Y。 */
function luminance(m: ReturnType<typeof createSkyModel>, skyAngleDeg: number): number {
  return m.xyzAt(skyAngleDeg)[1];
}

describe('レイリー位相関数', () => {
  /**
   * ∫P dΩ/4π = 1。位相関数が確率分布であることの定義そのもので、
   * 係数 3/4 を取り違えていればここで落ちる。
   */
  it('全立体角で積分すると 1 になる', () => {
    const steps = 20000;
    let total = 0;
    for (let i = 0; i < steps; i += 1) {
      const cosTheta = -1 + (2 * (i + 0.5)) / steps;
      total += rayleighPhase(cosTheta) * (2 / steps);
    }
    // 中点則の打ち切り誤差(h²/24 のオーダー)がこのくらい残る。
    expect(total / 2).toBeCloseTo(1, 8);
  });

  /**
   * 前方と後方が等しく 1.5、横が 0.75。
   *
   * **この前後対称が、平行平面では東西の非対称を作れなかった理由。**
   * 西の地平線 (Θ = h) と東の地平線 (Θ = 180 − h) で cos²Θ が等しくなる。
   */
  it('前方 = 後方 = 1.5、横 = 0.75', () => {
    expect(rayleighPhase(1)).toBeCloseTo(1.5, 12);
    expect(rayleighPhase(-1)).toBeCloseTo(1.5, 12);
    expect(rayleighPhase(0)).toBeCloseTo(0.75, 12);
  });

  it('方位角平均が数値的な方位角平均と一致する', () => {
    for (const mu of [0.1, 0.5, 0.9]) {
      for (const mu0 of [0.2, 0.6, 1]) {
        const steps = 4000;
        let total = 0;
        for (let i = 0; i < steps; i += 1) {
          const phi = (2 * Math.PI * (i + 0.5)) / steps;
          const cosTheta =
            mu * mu0 + Math.sqrt(1 - mu * mu) * Math.sqrt(1 - mu0 * mu0) * Math.cos(phi);
          total += rayleighPhase(cosTheta);
        }
        expect(total / steps, `mu=${mu} mu0=${mu0}`).toBeCloseTo(azimuthAveragedPhase(mu, mu0), 6);
      }
    }
  });
});

describe('散乱角の幾何', () => {
  it('太陽は西 (+側)、高度 90° で天頂、0° で西の地平線', () => {
    expect(sunSkyAngleDeg(90)).toBe(0);
    expect(sunSkyAngleDeg(0)).toBe(90);
    expect(sunSkyAngleDeg(30)).toBe(60);
  });

  it('太陽を直接見る方向で 0、鏡像で 2z₀', () => {
    for (const sunAltitudeDeg of [0, 20, 45, 90]) {
      const z0 = sunSkyAngleDeg(sunAltitudeDeg);
      expect(scatteringAngleDeg(z0, sunAltitudeDeg), `h=${sunAltitudeDeg}`).toBeCloseTo(0, 12);
      expect(scatteringAngleDeg(-z0, sunAltitudeDeg), `h=${sunAltitudeDeg}`).toBeCloseTo(2 * z0, 12);
    }
  });

  it('太陽高度 0 で東を向くと 180°', () => {
    expect(scatteringAngleDeg(-90, 0)).toBeCloseTo(180, 12);
  });

  /** 太陽が沈むと差が 180° を超えるので折り返す。 */
  it('薄明でも 0–180° に収まる', () => {
    for (let h = -18; h <= 90; h += 3) {
      for (let a = -90; a <= 90; a += 5) {
        const theta = scatteringAngleDeg(a, h);
        expect(theta, `h=${h} a=${a}`).toBeGreaterThanOrEqual(0);
        expect(theta, `h=${h} a=${a}`).toBeLessThanOrEqual(180);
      }
    }
    // 東を向いて太陽が 18° 下 → 差は 198° なので 162° に折り返る。
    expect(scatteringAngleDeg(-90, -18)).toBeCloseTo(162, 12);
  });
});

describe('平行平面の閉じた形(参照実装)', () => {
  /**
   * 閉じた形が、光路を刻んだ数値積分と一致すること。
   * 解析解を出すときの積分がそのまま検算対象になる。
   */
  it.each([
    [90, 0],
    [45, 0],
    [45, 60],
    [45, -60],
    [10, 80],
  ])('h=%d° a=%d°: 閉形式が光路の数値積分に一致', (sunAltitudeDeg, skyAngleDeg) => {
    const mView = 1 / Math.cos(Math.abs(skyAngleDeg) * DEG);
    const mSun = 1 / Math.cos(sunSkyAngleDeg(sunAltitudeDeg) * DEG);
    const cosTheta = Math.cos(scatteringAngleDeg(skyAngleDeg, sunAltitudeDeg) * DEG);
    const phase = rayleighPhase(cosTheta);

    for (const lambdaNm of [400, 550, 700]) {
      const tau = opticalDepth(lambdaNm);
      const f0 = normalizedSpectrum(lambdaNm, 5778);

      const steps = 20000;
      let numeric = 0;
      for (let i = 0; i < steps; i += 1) {
        const t = (tau * (i + 0.5)) / steps;
        numeric +=
          f0 *
          Math.exp(-t * mSun) *
          (phase / (4 * Math.PI)) *
          Math.exp(-(tau - t) * mView) *
          mView *
          (tau / steps);
      }

      expect(
        planeParallelRadianceWithAirMass(lambdaNm, cosTheta, mView, mSun, 5778) / numeric,
        `${lambdaNm}nm`,
      ).toBeCloseTo(1, 6);
    }
  });

  /**
   * δ = m₀ − m_v → 0 で分岐が切り替わるところが連続であること。
   * 太陽方向とその鏡像がちょうどこの点に当たるので、跳ねると帯に筋が入る。
   */
  it('太陽方向の前後で値が跳ばない', () => {
    const sunAltitudeDeg = 40;
    const z0 = sunSkyAngleDeg(sunAltitudeDeg);
    const exact = planeParallelRadiance(550, z0, sunAltitudeDeg, 5778);
    for (const offset of [1e-12, 1e-9, 1e-6, 1e-4]) {
      const near = planeParallelRadiance(550, z0 + offset, sunAltitudeDeg, 5778);
      expect(near / exact, `offset=${offset}`).toBeCloseTo(1, 3);
    }
    expect(Number.isFinite(exact)).toBe(true);
    expect(exact).toBeGreaterThan(0);
  });
});

describe('球殻の単散乱', () => {
  /**
   * 地球半径を大きくしていくと平行平面に近づき、行進の結果は閉じた形に収束する。
   *
   * **球殻の実装が、検算済みの解析解を極限として含んでいることの確認。**
   * 密度プロファイル・柱密度の規格化・透過率の組み立てを一度に押さえられる。
   */
  it('R → ∞ で平行平面の閉じた形に一致する', () => {
    const flat = { ...DEFAULT_SHAPE, earthRadiusM: 1e13 };
    for (const [skyAngleDeg, sunAltitudeDeg] of [
      [0, 45],
      [60, 45],
      [-60, 45],
      [30, 10],
    ] as const) {
      const cosTheta = Math.cos(scatteringAngleDeg(skyAngleDeg, sunAltitudeDeg) * DEG);
      const mView = 1 / Math.cos(Math.abs(skyAngleDeg) * DEG);
      const mSun = 1 / Math.cos(sunSkyAngleDeg(sunAltitudeDeg) * DEG);

      for (const lambdaNm of [450, 650]) {
        const marched = sphericalRadiance(lambdaNm, skyAngleDeg, sunAltitudeDeg, 5778, 0, flat, 3000, 600);
        const closed = planeParallelRadianceWithAirMass(lambdaNm, cosTheta, mView, mSun, 5778);
        expect(marched / closed, `a=${skyAngleDeg} h=${sunAltitudeDeg} ${lambdaNm}nm`).toBeCloseTo(
          1,
          4,
        );
      }
    }
  });

  it('扱う範囲の全域で有限かつ非負', () => {
    for (let h = -18; h <= 90; h += 6) {
      for (let a = -90; a <= 90; a += 15) {
        for (const lambdaNm of [380, 450, 550, 650, 780]) {
          const value = sphericalRadiance(lambdaNm, a, h, 5778, 0.1);
          expect(Number.isFinite(value), `h=${h} a=${a} ${lambdaNm}nm`).toBe(true);
          expect(value, `h=${h} a=${a} ${lambdaNm}nm`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe('地球の影と東西の非対称', () => {
  /**
   * **この節が今回の変更の核。**
   *
   * 平行平面では東西の地平線が明るさまで厳密に一致していた(実測で比 1.0000)。
   * レイリー位相関数が Θ → 180−Θ で対称で、air mass が |a| にしか依らないため。
   * 球殻にして地球の影を入れると、日没が近いほど西が明るくなる。
   */
  it('太陽が低いほど、東西の地平線の明るさの差が大きくなる', () => {
    let previous = 0;
    for (const sunAltitudeDeg of [30, 10, 5, 2, 0.5]) {
      const m = model({ sunAltitudeDeg });
      const ratio = luminance(m, 90) / luminance(m, -90);
      expect(ratio, `h=${sunAltitudeDeg}`).toBeGreaterThan(previous);
      previous = ratio;
    }
    // 日没直前では倍以上の差がつく。
    expect(previous).toBeGreaterThan(2);
  });

  /**
   * 位相関数だけでは説明できない差であることの裏取り。
   * 東西の地平線では散乱角が Θ と 180−Θ になり、位相関数の値は厳密に等しい。
   */
  it('東西の地平線では位相関数が厳密に等しい', () => {
    for (const sunAltitudeDeg of [30, 10, 2]) {
      const west = rayleighPhase(Math.cos(scatteringAngleDeg(90, sunAltitudeDeg) * DEG));
      const east = rayleighPhase(Math.cos(scatteringAngleDeg(-90, sunAltitudeDeg) * DEG));
      expect(west, `h=${sunAltitudeDeg}`).toBeCloseTo(east, 12);
    }
  });

  /**
   * 太陽が高いと影が大気に届かないので、東西の差はほとんど消える。
   * 影が原因であることの対偶にあたる確認。
   */
  it('太陽が高いときは東西の地平線がほぼ同じ明るさ', () => {
    const m = model({ sunAltitudeDeg: 60 });
    expect(luminance(m, 90) / luminance(m, -90)).toBeCloseTo(1, 2);
  });

  /**
   * 地平線以外の方向では、太陽が高いかぎり位相関数が差を決める。
   * 球殻にしても、影の届かない範囲では平行平面と同じ描像のまま。
   */
  it('太陽が高いとき、±60° の明るさの比が位相関数の比に一致する', () => {
    const sunAltitudeDeg = 60;
    const m = model({ sunAltitudeDeg });
    const phaseRatio =
      rayleighPhase(Math.cos(scatteringAngleDeg(60, sunAltitudeDeg) * DEG)) /
      rayleighPhase(Math.cos(scatteringAngleDeg(-60, sunAltitudeDeg) * DEG));
    expect(luminance(m, 60) / luminance(m, -60)).toBeCloseTo(phaseRatio, 1);
  });
});

describe('エアロゾル', () => {
  /**
   * Henyey–Greenstein は前方に 390 倍偏るので、太陽側だけが強く明るくなる。
   * 反対側は逆に暗くなる — 増えた消散のぶん、後方散乱の足しでは補えない。
   */
  it('エアロゾルを入れると太陽側だけが強く明るくなる', () => {
    const sunAltitudeDeg = 20;
    const clear = model({ sunAltitudeDeg });
    const hazy = model({ sunAltitudeDeg, aerosolOpticalDepth: 0.1 });

    const sunward = luminance(hazy, 70) / luminance(clear, 70);
    const opposite = luminance(hazy, -70) / luminance(clear, -70);
    expect(sunward).toBeGreaterThan(10);
    expect(opposite).toBeLessThan(1);
  });

  it('量を増やすほど太陽側と反対側の差が広がる', () => {
    let previous = 0;
    for (const aerosolOpticalDepth of [0, 0.05, 0.1, 0.3, 0.5]) {
      const m = model({ sunAltitudeDeg: 20, aerosolOpticalDepth });
      const ratio = luminance(m, 70) / luminance(m, -70);
      expect(ratio, `AOD=${aerosolOpticalDepth}`).toBeGreaterThan(previous);
      previous = ratio;
    }
  });

  /**
   * 波長依存が弱い散乱を足すので、空全体が白色点へ寄る。
   * **単散乱のレイリーだけでは空が濃すぎたが、その主因がこれだった。**
   */
  it('エアロゾルを入れると天頂の色が白っぽくなる', () => {
    let previous = 0;
    for (const aerosolOpticalDepth of [0, 0.05, 0.1, 0.3]) {
      const x = xyzToChromaticity(model({ sunAltitudeDeg: 20, aerosolOpticalDepth }).xyzAt(0)).x;
      expect(x, `AOD=${aerosolOpticalDepth}`).toBeGreaterThan(previous);
      previous = x;
    }
  });

  it('量が 0 ならエアロゾルなしと完全に一致する', () => {
    const withZero = model({ sunAltitudeDeg: 30, aerosolOpticalDepth: 0 });
    const without = model({ sunAltitudeDeg: 30 });
    expect(withZero.xyzAt(45)).toEqual(without.xyzAt(45));
  });
});

describe('薄明', () => {
  /** 太陽が沈んでも上層大気は照らされているので、空はまだ明るい。 */
  it('太陽高度が負でも空は真っ暗にならない', () => {
    for (const sunAltitudeDeg of [-2, -4, -6]) {
      const m = model({ sunAltitudeDeg, aerosolOpticalDepth: 0.1 });
      expect(luminance(m, 0), `h=${sunAltitudeDeg}`).toBeGreaterThan(0);
    }
  });

  it('沈むほど急速に暗くなる', () => {
    let previous = Infinity;
    for (const sunAltitudeDeg of [2, 0, -2, -4, -6]) {
      const value = luminance(model({ sunAltitudeDeg, aerosolOpticalDepth: 0.1 }), 0);
      expect(value, `h=${sunAltitudeDeg}`).toBeLessThan(previous);
      previous = value;
    }
    // 日没から 6° 下がるまでに 2 桁以上落ちる。
    const atSunset = luminance(model({ sunAltitudeDeg: 0, aerosolOpticalDepth: 0.1 }), 0);
    expect(previous / atSunset).toBeLessThan(0.01);
  });

  /**
   * 地球影は太陽と反対側から昇ってくるので、東の低空から先に暗くなる。
   * ビーナスベルトが東に見えるのと同じ理屈。
   */
  it('薄明では西の空のほうが東より明るい', () => {
    for (const sunAltitudeDeg of [0, -2, -4]) {
      const m = model({ sunAltitudeDeg, aerosolOpticalDepth: 0.1 });
      expect(luminance(m, 90), `h=${sunAltitudeDeg}`).toBeGreaterThan(luminance(m, -90));
    }
  });

  /**
   * 低い視線ほど手前の(影に入った)濃い大気を長く通るので、薄明では
   * 天頂のほうが明るくなる。日中とは上下が逆転する。
   */
  it('薄明では天頂が地平線より明るい(日中とは逆)', () => {
    const twilight = model({ sunAltitudeDeg: -2, aerosolOpticalDepth: 0.1 });
    expect(luminance(twilight, 0)).toBeGreaterThan(luminance(twilight, 90));

    const daytime = model({ sunAltitudeDeg: 30, aerosolOpticalDepth: 0.1 });
    expect(luminance(daytime, 0)).toBeLessThan(luminance(daytime, 90));
  });

  /** 天文薄明の終わりでは、単散乱の寄与はほぼ尽きている。 */
  it('高度 −18° では空がほとんど暗い', () => {
    const m = model({ sunAltitudeDeg: -18, aerosolOpticalDepth: 0.1 });
    const atSunset = luminance(model({ sunAltitudeDeg: 0, aerosolOpticalDepth: 0.1 }), 0);
    for (const a of [-90, -45, 0, 45]) {
      expect(luminance(m, a) / atSunset, `a=${a}`).toBeLessThan(1e-6);
    }
  });
});

describe('光子の収支', () => {
  /**
   * E = E↓₁ + E↑₁ + E₂₊ で E₂₊ ≥ 0。
   *
   * 保存散乱の平行平面大気では厳密に成り立つ等式。**エアロゾルを混ぜても、
   * 2 つの位相関数の凸結合はやはり規格化されたままなので等式は保たれる。**
   */
  it('1 次散乱で抜けた分が、取り去られた分を超えない', () => {
    for (const aod of [0, 0.1, 0.5]) {
      for (let h = 1; h <= 90; h += 3) {
        for (const lambdaNm of [380, 450, 550, 650, 780]) {
          const b = scatteringBudget(
            opticalDepth(lambdaNm),
            aerosolOpticalDepth(lambdaNm, aod),
            h,
          );
          expect(
            b.firstOrderDown + b.firstOrderUp,
            `AOD=${aod} h=${h} ${lambdaNm}nm`,
          ).toBeLessThanOrEqual(b.removed);
          expect(b.higherOrder, `AOD=${aod} h=${h} ${lambdaNm}nm`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('32 点のガウス求積が、細かい中点則と一致する', () => {
    for (const h of [15, 45, 80]) {
      for (const lambdaNm of [400, 550, 700]) {
        const tau = opticalDepth(lambdaNm);
        const mu0 = Math.sin(h * DEG);
        const mSun = 1 / mu0;

        const steps = 40000;
        let down = 0;
        let up = 0;
        for (let i = 0; i < steps; i += 1) {
          const mu = (i + 0.5) / steps;
          const mView = 1 / mu;
          const phase = azimuthAveragedPhase(mu, mu0) / (4 * Math.PI);
          // 検算したいのは μ 方向の求積であって指数の扱いではないので、
          // 光路積分は sky.ts と同じ安定な形で書く。
          const spread = Math.abs(mSun - mView);
          const path =
            spread < 1e-9
              ? tau * Math.exp(-tau * mView)
              : (-Math.exp(-tau * Math.min(mView, mSun)) * Math.expm1(-tau * spread)) / spread;
          down += (mu * phase * mView * path) / steps;
          up += (mu * phase * (mView / (mSun + mView)) * -Math.expm1(-tau * (mSun + mView))) / steps;
        }

        const b = scatteringBudget(tau, 0, h);
        expect(b.firstOrderDown / (2 * Math.PI * down), `down h=${h} ${lambdaNm}nm`).toBeCloseTo(
          1,
          4,
        );
        expect(b.firstOrderUp / (2 * Math.PI * up), `up h=${h} ${lambdaNm}nm`).toBeCloseTo(1, 4);
      }
    }
  });

  it('光学的に薄いほど多重散乱の割合が小さい', () => {
    const share = (lambdaNm: number): number => {
      const b = scatteringBudget(opticalDepth(lambdaNm), 0, 60);
      return b.higherOrder / b.removed;
    };
    expect(share(450)).toBeGreaterThan(share(650));
    expect(share(650)).toBeGreaterThan(share(780));
    expect(share(780)).toBeLessThan(0.1);
  });

  /**
   * 太陽高度 0 以下で見積もりが 0 になること。
   *
   * 平行平面では水平面に届く直達光がゼロなので、収支の入口が閉じる。
   * **薄明の明るさの大半は実際には多重散乱**なので、ここがこのモデルの最も弱いところ。
   */
  it('太陽が地平線以下では多重散乱の見積もりが 0 になる', () => {
    for (const h of [0, -3, -10]) {
      expect(multipleScatteringFloor(450, h, 5778), `h=${h}`).toBe(0);
      expect(scatteringBudget(opticalDepth(450), 0, h).higherOrder, `h=${h}`).toBe(0);
    }
  });
});

describe('空の色', () => {
  it('太陽が高いとき、天頂は青い', () => {
    const m = model({ sunAltitudeDeg: 90 });
    const [r, , b] = xyzToColor(m.xyzAt(0), 'max').rgb8;
    expect(b).toBeGreaterThan(r);
    expect(xyzToChromaticity(m.xyzAt(0)).x).toBeLessThan(
      xyzToChromaticity(blackbodyXYZ(5778)).x,
    );
  });

  it('太陽高度が下がるほど天頂の色度 x が単調増加する', () => {
    let previous = -Infinity;
    for (let h = 90; h >= 5; h -= 5) {
      const x = xyzToChromaticity(model({ sunAltitudeDeg: h }).xyzAt(0)).x;
      expect(x, `h=${h}`).toBeGreaterThan(previous);
      previous = x;
    }
  });

  it('地平線は天頂より明るい(日中)', () => {
    for (const h of [90, 45, 10]) {
      const m = model({ sunAltitudeDeg: h });
      const ratio = luminance(m, 90) / luminance(m, 0);
      expect(ratio, `h=${h}`).toBeGreaterThan(3);
      expect(ratio, `h=${h}`).toBeLessThan(40);
    }
  });

  it('多重散乱を入れると全方向が明るくなり、地平線と天頂の差が縮む', () => {
    for (const h of [90, 45, 10]) {
      const single = model({ sunAltitudeDeg: h });
      const multiple = model({ sunAltitudeDeg: h, multipleScattering: true });
      for (let a = -90; a <= 90; a += 15) {
        expect(luminance(multiple, a), `h=${h} a=${a}`).toBeGreaterThan(luminance(single, a));
      }
      const ratio = (m: ReturnType<typeof createSkyModel>): number =>
        luminance(m, 90) / luminance(m, 0);
      expect(ratio(multiple), `h=${h}`).toBeLessThan(ratio(single));
    }
  });

  /**
   * 2 回以上散乱された光は λ⁻⁴ の重みを重ねて受けているぶん単散乱より青い。
   * 空を白っぽくしているのは多重散乱ではなくエアロゾルのほう。
   */
  it('多重散乱を入れると天頂は青くなる(白っぽくはならない)', () => {
    for (const h of [90, 45, 20]) {
      const single = xyzToChromaticity(model({ sunAltitudeDeg: h }).xyzAt(0)).x;
      const multiple = xyzToChromaticity(
        model({ sunAltitudeDeg: h, multipleScattering: true }).xyzAt(0),
      ).x;
      expect(multiple, `h=${h}`).toBeLessThan(single);
    }
  });

  it('多重散乱の寄与は単散乱モードで 0、多重散乱モードで 1 割以上', () => {
    expect(model({ sunAltitudeDeg: 45 }).multipleScatteringShare()).toBe(0);
    const share = model({ sunAltitudeDeg: 45, multipleScattering: true }).multipleScatteringShare();
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.5);
  });

  it('太陽の温度を上げると空も青くなる', () => {
    const x = (temperatureK: number): number =>
      xyzToChromaticity(
        model({ sunAltitudeDeg: 45, temperatureK, multipleScattering: true }).xyzAt(0),
      ).x;
    expect(x(9000)).toBeLessThan(x(5778));
    expect(x(5778)).toBeLessThan(x(3000));
  });

  /**
   * モデルは速度のために下駄を表に焼いてあるので、素の
   * multipleScatteringFloor と一致していることを確かめる。
   */
  it('モデルの多重散乱分が multipleScatteringFloor と一致する', () => {
    const single = model({ sunAltitudeDeg: 35, aerosolOpticalDepth: 0.2 }).samplerFor(20);
    const multiple = model({
      sunAltitudeDeg: 35,
      aerosolOpticalDepth: 0.2,
      multipleScattering: true,
    }).samplerFor(20);
    for (const lambdaNm of [400, 450, 550, 650, 700]) {
      expect(multiple(lambdaNm) - single(lambdaNm), `${lambdaNm}nm`).toBeCloseTo(
        multipleScatteringFloor(lambdaNm, 35, 5778, 0.2),
        15,
      );
    }
  });

  /** 速い経路(samplerFor)と、毎回行進する素の関数が同じ値を返すこと。 */
  it('samplerFor が sphericalRadiance と一致する', () => {
    const m = model({ sunAltitudeDeg: 35, aerosolOpticalDepth: 0.15 });
    for (const angle of [0, 25, -25, 55, -90, 90]) {
      const sample = m.samplerFor(angle);
      for (const lambdaNm of [380, 450, 555, 700, 780]) {
        expect(sample(lambdaNm), `a=${angle} ${lambdaNm}nm`).toBeCloseTo(
          sphericalRadiance(lambdaNm, angle, 35, 5778, 0.15),
          15,
        );
      }
      // 表に乗らない波長(小数)でも経路が一致すること。
      expect(sample(512.5), `a=${angle} 512.5nm`).toBeCloseTo(
        sphericalRadiance(512.5, angle, 35, 5778, 0.15),
        15,
      );
    }
  });

  /** 下駄はスペクトルであって定数ではない(白を足しているのではない)。 */
  it('多重散乱の下駄は青ほど大きい', () => {
    const floor = (lambdaNm: number): number => multipleScatteringFloor(lambdaNm, 45, 5778);
    const solar = (lambdaNm: number): number => normalizedSpectrum(lambdaNm, 5778);
    expect(floor(450) / solar(450)).toBeGreaterThan(floor(650) / solar(650));
    expect(spectrumToXYZ((nm) => floor(nm))[1]).toBeGreaterThan(0);
  });

  /** 三刺激値がそのまま扱える形で返ること(NaN や負が漏れない)。 */
  it('全方向で三刺激値が有限かつ非負', () => {
    for (const h of [-18, -6, 0, 20, 90]) {
      const m = model({ sunAltitudeDeg: h, aerosolOpticalDepth: 0.2, multipleScattering: true });
      for (let a = -90; a <= 90; a += 30) {
        const xyz: XYZ = m.xyzAt(a);
        for (let i = 0; i < 3; i += 1) {
          expect(Number.isFinite(xyz[i]!), `h=${h} a=${a} 成分${i}`).toBe(true);
          expect(xyz[i]!, `h=${h} a=${a} 成分${i}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
