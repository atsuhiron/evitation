import { describe, expect, it } from 'vitest';
import { xyzToColor } from '../../color/index.ts';
import { blackbodyXYZ, luminousEfficacy } from '../../physics/planck.ts';
import { MAX_TEMPERATURE_K, MIN_TEMPERATURE_K } from '../../ui/temperature-axis.ts';
import { presets, PEAK_EFFICACY_TEMPERATURE_K } from './presets.ts';

describe('プリセット', () => {
  it.each(presets.map((p) => [p.name, p] as const))('%s: 温度が範囲内の整数', (_name, preset) => {
    expect(preset.temperatureK).toBeGreaterThanOrEqual(MIN_TEMPERATURE_K);
    expect(preset.temperatureK).toBeLessThanOrEqual(MAX_TEMPERATURE_K);
    expect(Number.isInteger(preset.temperatureK)).toBe(true);
  });

  it('ラベルに書いた温度と実際の温度が一致する', () => {
    const preset = presets.find((p) => p.name.startsWith('発光効率が最大'));
    expect(preset?.name).toContain(String(PEAK_EFFICACY_TEMPERATURE_K));
    expect(preset?.temperatureK).toBe(PEAK_EFFICACY_TEMPERATURE_K);
  });

  /**
   * 黄金分割探索で求めた温度が、本当に他のどの温度よりも高い効率を与えること。
   * 「発光効率が最大」というラベルが主張している内容そのもの。
   */
  it('探索で得た温度が他のどの温度よりも高い効率を与える', () => {
    const peak = luminousEfficacy(PEAK_EFFICACY_TEMPERATURE_K);
    for (
      let temperatureK = MIN_TEMPERATURE_K;
      temperatureK <= MAX_TEMPERATURE_K;
      temperatureK += 50
    ) {
      expect(luminousEfficacy(temperatureK), `${temperatureK}K`).toBeLessThanOrEqual(peak + 1e-9);
    }
  });

  /** 電球色と青白い星が、色として実際にはっきり違うこと。 */
  it('白熱電球と青色巨星の見た目が明確に異なる', () => {
    const bulb = xyzToColor(blackbodyXYZ(2856), 'max').rgb8;
    const star = xyzToColor(blackbodyXYZ(20000), 'max').rgb8;
    const distance = Math.hypot(bulb[0] - star[0], bulb[1] - star[1], bulb[2] - star[2]);
    expect(distance).toBeGreaterThan(80);
  });
});
