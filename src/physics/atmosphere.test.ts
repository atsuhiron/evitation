import { describe, expect, it } from 'vitest';
import { airMassAtZenithAngle } from './air-mass.ts';
import {
  ATMOSPHERE_TOP_M,
  DEFAULT_SHAPE,
  EARTH_RADIUS_M,
  isShadowed,
  RAYLEIGH_SCALE_HEIGHT_M,
  slantColumnsFromGround,
  VIEW_STEPS,
  viewPathSamples,
  type Vec2,
} from './atmosphere.ts';

const DEG = Math.PI / 180;

/** 太陽高度から、主平面での太陽方向の単位ベクトルを作る。 */
function sunDirection(altitudeDeg: number): Vec2 {
  const zenith = (90 - altitudeDeg) * DEG;
  return { x: Math.sin(zenith), y: Math.cos(zenith) };
}

/** 地球中心を原点としたときの、真上に高度 `altitudeM` だけ上がった点。 */
function overhead(altitudeM: number): Vec2 {
  return { x: 0, y: EARTH_RADIUS_M + altitudeM };
}

describe('柱密度', () => {
  /**
   * 鉛直の柱を 1 とする規格化そのもの。∫₀^∞ exp(−z/H) dz = H で割っている。
   *
   * 既定の刻み数で残る誤差は 7e-4(中点則の打ち切り)で、1/N² で減る。
   * 刻み数は「色を 8bit に落としたときの差が 1 以内」を基準に選んであり、
   * その意味ではこの残差は十分小さい(量子化幅 1/255 ≈ 4e-3 の 6 分の 1)。
   */
  it('天頂方向の柱密度が 1', () => {
    const columns = slantColumnsFromGround(0);
    expect(columns.rayleigh).toBeCloseTo(1, 2);
    expect(columns.aerosol).toBeCloseTo(1, 2);
  });

  /**
   * 等温の指数大気について、水平方向の柱密度は解析的に √(πR/2H) と分かっている。
   *
   * **行進・密度プロファイル・球殻の幾何を一度に外部の基準へ突き合わせられる 1 本。**
   * イルミナント A や σ = 4.51e-27 cm² と同じ役割を、この節で果たす。
   */
  it('水平方向の柱密度が √(πR/2H) に一致', () => {
    const analytic = Math.sqrt((Math.PI * EARTH_RADIUS_M) / (2 * RAYLEIGH_SCALE_HEIGHT_M));
    expect(analytic).toBeCloseTo(34.31, 2);
    expect(slantColumnsFromGround(90).rayleigh / analytic).toBeCloseTo(1, 2);
  });

  /**
   * Kasten–Young の経験式が与える air mass と同じ量を、こちらは幾何から求めている。
   * 一致はしない — 経験式は屈折と実際の(等温でない)温度分布を織り込んでいるため。
   * それでも 10% 以内には収まるはずで、外れていれば幾何のほうを疑える。
   */
  it('Kasten–Young の air mass と 10% 以内で一致する', () => {
    for (const zenithDeg of [0, 30, 60, 75, 85, 90]) {
      const ratio = slantColumnsFromGround(zenithDeg).rayleigh / airMassAtZenithAngle(zenithDeg);
      expect(ratio, `${zenithDeg}°`).toBeGreaterThan(0.9);
      expect(ratio, `${zenithDeg}°`).toBeLessThan(1.1);
    }
  });

  /** 地平線に近いほど長い。単調性が崩れたら幾何を間違えている。 */
  it('天頂角が大きいほど柱密度が大きい', () => {
    let previous = 0;
    for (let zenithDeg = 0; zenithDeg <= 90; zenithDeg += 2) {
      const value = slantColumnsFromGround(zenithDeg).rayleigh;
      expect(value, `${zenithDeg}°`).toBeGreaterThan(previous);
      previous = value;
    }
  });

  /**
   * エアロゾルは尺度高さが小さいぶん、地平線方向で分子よりずっと長い光路になる。
   * 薄い層を寝かせて覗き込む形になるため。
   */
  it('水平方向ではエアロゾルの柱密度が分子より大きい', () => {
    const horizon = slantColumnsFromGround(90);
    expect(horizon.aerosol).toBeGreaterThan(horizon.rayleigh * 2);
    // 天頂方向ではどちらも 1 で並ぶ(尺度高さの違いは光路の傾きでしか効かない)。
    const zenith = slantColumnsFromGround(0);
    expect(zenith.aerosol).toBeCloseTo(zenith.rayleigh, 2);
  });

  /**
   * 刻みを 8 倍にしても値が動かない。
   *
   * 刻みを始点に寄せて二次で分布させているのが効いている。一様に刻むと、鉛直に近い
   * 視線でエアロゾル(尺度高さ 1.2km)が解けず 0.8% ずれる。
   */
  it('行進の刻みを増やしても値が変わらない', () => {
    for (const zenithDeg of [0, 60, 90]) {
      const coarse = slantColumnsFromGround(zenithDeg, DEFAULT_SHAPE, VIEW_STEPS);
      const fine = slantColumnsFromGround(zenithDeg, DEFAULT_SHAPE, VIEW_STEPS * 8);
      expect(coarse.rayleigh / fine.rayleigh, `${zenithDeg}° R`).toBeCloseTo(1, 2);
      expect(coarse.aerosol / fine.aerosol, `${zenithDeg}° M`).toBeCloseTo(1, 2);
    }
  });

  /**
   * 地球半径を大きくしていくと平行平面に近づき、柱密度は 1/cos z に収束する。
   * 球殻の実装が平行平面の極限を含んでいることの確認。
   */
  it('R → ∞ で 1/cos z に収束する', () => {
    const flat = { ...DEFAULT_SHAPE, earthRadiusM: 1e13 };
    for (const zenithDeg of [0, 30, 60, 80]) {
      const columns = slantColumnsFromGround(zenithDeg, flat, 4096);
      expect(columns.rayleigh, `${zenithDeg}°`).toBeCloseTo(1 / Math.cos(zenithDeg * DEG), 4);
    }
  });
});

describe('地球の影', () => {
  /** 太陽が地平線より上にあれば、地上も含めてどこも影に入らない。 */
  it('太陽高度が正なら地上は日向', () => {
    for (const altitudeDeg of [0.5, 5, 30, 90]) {
      expect(isShadowed(overhead(0), sunDirection(altitudeDeg), EARTH_RADIUS_M), `h=${altitudeDeg}`)
        .toBe(false);
    }
  });

  it('太陽が沈むと地上が影に入る', () => {
    for (const altitudeDeg of [-0.5, -3, -10]) {
      expect(isShadowed(overhead(0), sunDirection(altitudeDeg), EARTH_RADIUS_M), `h=${altitudeDeg}`)
        .toBe(true);
    }
  });

  /**
   * 影から出る高度は幾何で決まり、R(1/cos|h| − 1) が目安になる。
   * 東から昇る地球影の高さがこれで、その上に見えるのがビーナスベルト。
   */
  it('影から出る高度が R(1/cos|h| − 1) の近傍にある', () => {
    for (const altitudeDeg of [-1, -3, -6]) {
      const sun = sunDirection(altitudeDeg);
      const theory = EARTH_RADIUS_M * (1 / Math.cos(-altitudeDeg * DEG) - 1);

      // 二分法で境界を探す。
      let lit = ATMOSPHERE_TOP_M;
      let dark = 0;
      for (let i = 0; i < 60; i += 1) {
        const mid = (lit + dark) / 2;
        if (isShadowed(overhead(mid), sun, EARTH_RADIUS_M)) dark = mid;
        else lit = mid;
      }
      expect((lit + dark) / 2 / theory, `h=${altitudeDeg}`).toBeCloseTo(1, 1);
    }
  });

  /** 高いところほど先に日が当たる。境界が 1 つしかないことの確認でもある。 */
  it('影から出たらそれより上はすべて日向', () => {
    const sun = sunDirection(-4);
    let seenLit = false;
    for (let altitudeM = 0; altitudeM <= ATMOSPHERE_TOP_M; altitudeM += 1000) {
      const shadowed = isShadowed(overhead(altitudeM), sun, EARTH_RADIUS_M);
      if (!shadowed) seenLit = true;
      else expect(seenLit, `${altitudeM}m で影に戻った`).toBe(false);
    }
    expect(seenLit).toBe(true);
  });
});

describe('視線に沿った標本', () => {
  it('太陽が高いときは光路全体が日向', () => {
    for (const skyAngleDeg of [-90, -45, 0, 45, 90]) {
      expect(viewPathSamples(skyAngleDeg, 45).length, `a=${skyAngleDeg}`).toBe(VIEW_STEPS);
    }
  });

  /**
   * 薄明では影に入った区間が落ちる。**東を向くほど残る標本が少ない** —
   * 地球影は太陽と反対側から昇ってくるので、これが東西の非対称を生む正体。
   */
  it('薄明では西を向くほど日の当たる区間が多い', () => {
    const counts = [-90, -45, 0, 45, 90].map((a) => viewPathSamples(a, -6).length);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!, `${i} 番目`).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
    // 東の地平線は完全に影の中、西寄りには残っている。
    expect(counts[0]).toBe(0);
    expect(counts.at(-1)).toBeGreaterThan(0);
  });

  it('天文薄明の終わりではほとんど日が当たらない', () => {
    const total = [-90, -45, 0, 45, 90].reduce((sum, a) => sum + viewPathSamples(a, -18).length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(VIEW_STEPS);
  });

  /** 標本の柱密度を足し戻すと、その方向の全柱密度に戻る。 */
  it('日向の標本の柱密度を足すと視線全体の柱密度になる(太陽が高いとき)', () => {
    for (const skyAngleDeg of [0, 60, 90]) {
      const samples = viewPathSamples(skyAngleDeg, 60);
      const sum = samples.reduce((total, s) => total + s.dRayleigh, 0);
      expect(sum / slantColumnsFromGround(skyAngleDeg).rayleigh, `a=${skyAngleDeg}`).toBeCloseTo(
        1,
        6,
      );
    }
  });
});
