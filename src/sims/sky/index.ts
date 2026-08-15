/**
 * 空の色シミュレータ。
 *
 * 太陽の黒体温度と高度を与えて、東の地平線から天頂を通って西の地平線までの
 * 各方向の空の色を求める。
 *
 * レイリー散乱ページが扱ったのは光路から失われる分 exp(−τ·m) だけだった。
 * こちらはその行き先を計算する — 散乱で消えた光がどこへ行ったのかという問いの
 * 答えが、そのまま空の色になる。2 ページで 1 組。
 */

import './sky.css';
import {
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  xyzToColor,
  type ColorResult,
  type XYZ,
} from '../../color/index.ts';
import { blackbodyXYZ, normalizedSpectrum } from '../../physics/planck.ts';
import {
  sunSkyAngleDeg,
  SPECTRUM_TABLE_LAMBDA_MIN,
  type SkyConditions,
} from '../../physics/sky.ts';
import { backend, initWasmBackend, type SkyBackendModel } from '../../physics/sky-backend.ts';
import { GradientBar } from '../../ui/gradient-bar.ts';
import { createRadioGroup, type RadioGroup } from '../../ui/radio-group.ts';
import { SpectrumChart, type ChartCurve } from '../../ui/spectrum-chart.ts';
import {
  clampTemperature,
  MAX_TEMPERATURE_K,
  MIN_TEMPERATURE_K,
  positionToTemperature,
  SLIDER_STEPS as TEMPERATURE_SLIDER_STEPS,
  temperatureToPosition,
} from '../../ui/temperature-axis.ts';
import { ValueList } from '../../ui/value-list.ts';
import {
  ALTITUDE_STEP_DEG,
  altitudeToPosition,
  clampAltitude,
  MAX_ALTITUDE_DEG,
  MIN_ALTITUDE_DEG,
  positionToAltitude,
  SLIDER_STEPS as ALTITUDE_SLIDER_STEPS,
} from './altitude.ts';
import { defaultPreset, presets } from './presets.ts';

/** エアロゾルの光学的厚さ (550nm) の範囲と刻み。 */
const MIN_AEROSOL = 0;
const MAX_AEROSOL = 0.5;
const AEROSOL_STEP = 0.01;
const AEROSOL_SLIDER_STEPS = Math.round(MAX_AEROSOL / AEROSOL_STEP);

/** 空の角度の範囲。−90 が東の地平線、0 が天頂、+90 が西の地平線。 */
const MIN_SKY_ANGLE_DEG = -90;
const MAX_SKY_ANGLE_DEG = 90;
const BAR_TICKS = [-90, -60, -30, 0, 30, 60, 90];

/**
 * 帯の標本数 = 0.5° 刻み。
 *
 * `GradientBar` は区間の中点で色を求めるので、180° を 360 等分すると
 * −89.75°, −89.25°, … と 0.5° ごとの代表値になる。
 *
 * 1 標本ごとに球殻を行進して可視域を積分するので、ここが再描画時間を直接決める。
 */
const BAR_SAMPLES = Math.round((MAX_SKY_ANGLE_DEG - MIN_SKY_ANGLE_DEG) / 0.5);

const CHART_X_TICKS = [400, 500, 600, 700];
const CHART_Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

const DEFAULT_TEMPERATURE_K = 5778;

/**
 * 明るさの決め方。
 *
 * - `scene`: その状態の空で最も明るい方向を基準にする。空の中の明暗差は残しつつ、
 *   どの高度でも空らしい明るさで見える(目の順応に相当)
 * - `absolute`: 太陽高度によらない固定係数。高度を下げると実際に暗くなる
 */
type BrightnessMode = 'scene' | 'absolute';

interface State {
  temperatureK: number;
  sunAltitudeDeg: number;
  /** エアロゾルを入れるか。外しても量は覚えておく。 */
  aerosolEnabled: boolean;
  aerosolOpticalDepth: number;
  multipleScattering: boolean;
  brightness: BrightnessMode;
}

const state: State = {
  temperatureK: DEFAULT_TEMPERATURE_K,
  sunAltitudeDeg: defaultPreset.altitudeDeg,
  aerosolEnabled: true,
  aerosolOpticalDepth: 0.1,
  multipleScattering: true,
  brightness: 'scene',
};

/** 物理側に渡す条件。チェックが外れていれば量に関わらず 0 を渡す。 */
function currentConditions(): SkyConditions {
  return {
    sunAltitudeDeg: state.sunAltitudeDeg,
    temperatureK: state.temperatureK,
    multipleScattering: state.multipleScattering,
    aerosolOpticalDepth: state.aerosolEnabled ? state.aerosolOpticalDepth : 0,
  };
}

let bar: GradientBar | null = null;
let chart: SpectrumChart | null = null;
let values: ValueList;
let modeGroups: RadioGroup[] = [];

// mount 時に組み立て、render で中身を書き替える要素。
let altitudeSlider: HTMLInputElement;
let altitudeNumber: HTMLInputElement;
let temperatureSlider: HTMLInputElement;
let temperatureNumber: HTMLInputElement;
let aerosolCheckbox: HTMLInputElement;
let aerosolSlider: HTMLInputElement;
let aerosolNumber: HTMLInputElement;
let swatches: Record<'zenith' | 'sun' | 'opposite', HTMLElement>;
let notes: HTMLElement;
let presetHint: HTMLElement;

/**
 * 帯が参照する現在のモデルとスケール。
 *
 * `GradientBar` の `colorAt` は構築時に閉じ込められるので、状態はここを経由して渡す。
 * 色が変わったら `bar.recolor()` を呼ぶこと(呼ばないと帯だけ古いまま残る)。
 */
// 描画のたびに作り直す。wasm 実装ではハンドルを握るので、**作り直す前に必ず
// free() すること**(解放を怠るとスライダーを動かすたびに線形メモリが増える)。
let currentModel: SkyBackendModel | null = null;
let currentScale = 1;

/**
 * いまページが載っているか。
 *
 * wasm の読み込みは待たずに走らせるので、解決したときにはもうページを
 * 離れていることがある。そのまま描くと破棄済みの帯や図を触ることになる。
 */
let mounted = false;

/**
 * この描画で求めた三刺激値の覚え書き。
 *
 * 帯の各標本は「最大値を探すため」と「色を塗るため」の 2 回参照される。球殻の
 * 行進は 1 方向あたり数百マイクロ秒かかるので、2 度解かずに使い回す。
 * 状態が変わるたびに捨てる。
 */
let xyzCache = new Map<number, XYZ>();

/**
 * 覚え書きを引く。無ければ 1 方向だけ解いて足す。
 *
 * 帯の色を塗る直前に `renderNow` がまとめて解いて埋めておくので、通常はここが
 * 当たる。**当たらない経路も残す必要がある** — `GradientBar` の標本数は
 * `min(canvas の幅, maxSamples)` なので、幅の狭い画面では 360 未満になり、
 * `barSampleAngles()` と角度が一致しなくなる。
 */
function cachedXYZ(angleDeg: number): XYZ {
  const hit = xyzCache.get(angleDeg);
  if (hit !== undefined) return hit;
  const value = model().xyzAt(angleDeg);
  xyzCache.set(angleDeg, value);
  return value;
}

/**
 * wasm 実装を使うよう指定されているか。
 *
 * **クエリはハッシュではなく検索文字列側に置く。**ルータの `parseHash` は
 * `#/([\w-]+)` しか受け付けないので、`#/sky?wasm=1` と書くと sky ページ自体に
 * 辿り着けない。デバッグ用の切り替えのためにルータを緩めたくはない。
 */
function wasmRequested(): boolean {
  return new URLSearchParams(location.search).get('wasm') === '1';
}

/** 描画中に必ず存在する現在のモデル。 */
function model(): SkyBackendModel {
  if (currentModel === null) {
    currentModel = backend().createModel(currentConditions());
  }
  return currentModel;
}

// --- 色の計算 ------------------------------------------------------------------

function scaleXYZ(xyz: XYZ, factor: number): XYZ {
  return [xyz[0] * factor, xyz[1] * factor, xyz[2] * factor];
}

/**
 * 太陽側 / 反対側として数値に出す方向。
 *
 * 太陽が沈むと空の角度が 90° を超えて **空の方向ではなくなる**ので、地平線で止める。
 */
function representativeAngle(sunAltitudeDeg: number): number {
  return Math.min(sunSkyAngleDeg(sunAltitudeDeg), MAX_SKY_ANGLE_DEG);
}

/**
 * `GradientBar` が標本を取る角度。
 *
 * 帯の内部と同じ並べ方(区間の中点)を再現している。ここで求めた三刺激値を
 * 覚えておけば、最大値の探索と塗りで同じ値を使い回せる。
 */
function barSampleAngles(): number[] {
  const angles: number[] = [];
  for (let i = 0; i < BAR_SAMPLES; i += 1) {
    angles.push(
      MIN_SKY_ANGLE_DEG +
        ((MAX_SKY_ANGLE_DEG - MIN_SKY_ANGLE_DEG) * (i + 0.5)) / BAR_SAMPLES,
    );
  }
  return angles;
}

/**
 * 空全体で最も明るい方向の、linear RGB の最大成分。
 *
 * **帯が実際に描く角度をすべて見る。**代表点をいくつか拾うだけでは足りない —
 * 地球の影を入れてから、最も明るい方向が地平線とは限らなくなった(日没前後では
 * 60–85° あたりに来る)。取りこぼすとスケールが大きくなりすぎ、帯の中ほどが
 * 白飛びして色が消える(実際にそうなった)。
 */
function scenePeak(sunAltitudeDeg: number): number {
  const sunAngle = representativeAngle(sunAltitudeDeg);
  let peak = 0;
  for (const angle of [...barSampleAngles(), 0, sunAngle, -sunAngle]) {
    const { linearRGB } = xyzToColor(cachedXYZ(angle), 'luminance');
    peak = Math.max(peak, linearRGB[0], linearRGB[1], linearRGB[2]);
  }
  return peak;
}

/**
 * 太陽高度によらない固定係数。
 *
 * 扱う範囲を一度だけ走査して、いちばん明るくなる組み合わせが上限に届く値を求める。
 * 黒体ページの displayScale と同じ手口。単散乱と多重散乱の両方を含めて 1 つの係数に
 * するので、モードを切り替えたときの明るさの差がそのまま見える。
 */
let cachedAbsoluteScale: number | null = null;

function absoluteScale(): number {
  if (cachedAbsoluteScale !== null) return cachedAbsoluteScale;

  // 走査は粗くてよい。上限を決めるだけで、帯の全角度を見る必要はない。
  const angles = new Float64Array(19);
  for (let i = 0; i < angles.length; i += 1) angles[i] = -90 + i * 10;

  let peak = 0;
  for (const multipleScattering of [false, true]) {
    for (const aerosolOpticalDepth of [0, MAX_AEROSOL]) {
      for (let sunAltitudeDeg = 0; sunAltitudeDeg <= 90; sunAltitudeDeg += 10) {
        const scan = backend().createModel({
          sunAltitudeDeg,
          temperatureK: DEFAULT_TEMPERATURE_K,
          multipleScattering,
          aerosolOpticalDepth,
        });
        // ここで作るモデルは 40 個。同じ反復の中で必ず解放する。
        try {
          const flat = scan.xyzMany(angles);
          for (let i = 0; i < angles.length; i += 1) {
            const { linearRGB } = xyzToColor(
              [flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!],
              'luminance',
            );
            peak = Math.max(peak, linearRGB[0], linearRGB[1], linearRGB[2]);
          }
        } finally {
          scan.free();
        }
      }
    }
  }

  cachedAbsoluteScale = peak > 0 ? 1 / peak : 1;
  return cachedAbsoluteScale;
}

/**
 * 表示用の色。
 *
 * **方向ごとに正規化してはいけない。**そうすると空の中の明暗差が消えて、
 * 帯がのっぺりする。スケールは空全体で 1 つ。
 */
function colorAt(angleDeg: number): ColorResult {
  return xyzToColor(scaleXYZ(cachedXYZ(angleDeg), currentScale), 'luminance');
}

// --- 状態の更新 ----------------------------------------------------------------

/**
 * 再描画をフレームに 1 回へ束ねる。
 *
 * 1 回の描画は帯の 363 方向ぶんの球殻の行進を伴うので、`input` イベントごとに
 * 同期で走らせるとスライダーのドラッグ中に描画がキューへ積み上がり、
 * **入力に対して際限なく遅れていく**。フレームに 1 回へ潰せば、遅れは
 * 常に高々 1 描画ぶんに収まる。
 *
 * 状態はイベントハンドラが即座に書き替え、`renderNow` は走る時点の `state` を
 * 読み直すので、束ねても取りこぼしは出ない。
 */
let renderHandle = 0;

function scheduleRender(): void {
  if (renderHandle !== 0) return;
  renderHandle = requestAnimationFrame(() => {
    renderHandle = 0;
    renderNow();
  });
}

function setAltitude(value: number): void {
  const sunAltitudeDeg = clampAltitude(value);
  if (sunAltitudeDeg === state.sunAltitudeDeg) return;
  state.sunAltitudeDeg = sunAltitudeDeg;
  scheduleRender();
}

function setTemperature(value: number): void {
  const temperatureK = clampTemperature(value);
  if (temperatureK === state.temperatureK) return;
  state.temperatureK = temperatureK;
  scheduleRender();
}

function setAerosol(value: number): void {
  const stepped = Math.round(value / AEROSOL_STEP) * AEROSOL_STEP;
  const clamped = Math.round(Math.min(MAX_AEROSOL, Math.max(MIN_AEROSOL, stepped)) * 100) / 100;
  if (clamped === state.aerosolOpticalDepth) return;
  state.aerosolOpticalDepth = clamped;
  scheduleRender();
}

// --- 部品の組み立て -----------------------------------------------------------

/**
 * スライダーと数値入力の組。
 *
 * 数値入力は打ち込み途中の値も反映するが、範囲外や空欄をその場では書き戻さない
 * (入力中に勝手に値が変わると打ちづらいため)。確定時に丸めた値を反映する。
 */
function buildSliderRow(config: {
  readonly sliderId: string;
  readonly ariaLabel: string;
  readonly sliderMax: number;
  readonly numberMin: number;
  readonly numberMax: number;
  readonly numberStep: number;
  readonly unit: string;
  readonly onSlider: (position: number) => void;
  readonly onNumber: (value: number) => void;
  readonly writeBack: () => string;
  /** 目盛りを打つ位置(0..1)とラベル。 */
  readonly ticks?: readonly { readonly fraction: number; readonly label: string }[];
}): { row: HTMLElement; slider: HTMLInputElement; number: HTMLInputElement } {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = config.sliderId;
  slider.className = 'sky__slider';
  slider.min = '0';
  slider.max = String(config.sliderMax);
  slider.step = '1';

  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'sky__number';
  number.min = String(config.numberMin);
  number.max = String(config.numberMax);
  number.step = String(config.numberStep);
  number.setAttribute('aria-label', config.ariaLabel);

  const unit = document.createElement('span');
  unit.className = 'sky__unit';
  unit.textContent = config.unit;

  const group = document.createElement('div');
  group.className = 'sky__number-group';
  group.append(number, unit);

  const row = document.createElement('div');
  row.className = 'sky__control-row';

  if (config.ticks === undefined) {
    row.append(slider, group);
  } else {
    // つまみは端で半個ぶん内側に寄るので、目盛りもその分を差し引いた幅に載せる。
    // つまみの実寸は UA のシャドウ DOM の中で読めないため、Chrome の既定に合わせて
    // 1rem と置いてある。仮に実寸がずれても、ずれ量 × |0.5 − 位置| しか効かない。
    const ticks = document.createElement('div');
    ticks.className = 'sky__slider-ticks';
    ticks.setAttribute('aria-hidden', 'true');
    for (const tick of config.ticks) {
      const mark = document.createElement('span');
      mark.className = 'sky__slider-tick';
      mark.style.left = `calc(${tick.fraction} * (100% - 1rem) + 0.5rem)`;
      mark.textContent = tick.label;
      ticks.append(mark);
    }

    const wrap = document.createElement('div');
    wrap.className = 'sky__slider-wrap';
    wrap.append(slider, ticks);
    row.append(wrap, group);
  }

  slider.addEventListener('input', () => {
    config.onSlider(Number(slider.value));
  });
  number.addEventListener('input', () => {
    const value = Number(number.value);
    if (number.value !== '' && Number.isFinite(value)) config.onNumber(value);
  });
  const writeBack = (): void => {
    number.value = config.writeBack();
  };
  number.addEventListener('change', writeBack);
  number.addEventListener('blur', writeBack);

  return { row, slider, number };
}

/**
 * 太陽高度と温度をひとつのパネルにまとめる。
 *
 * 別々のパネルにすると、枠の余白と間隔のぶんだけ帯と図が下へ押し出される。
 * このページは「スライダーを動かしながら帯を見る」使い方をするので、
 * 操作部の縦幅を詰めることを優先する(Request B と同じ判断)。
 */
function buildControlPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel sky-altitude';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = 'sky-altitude-slider';
  label.textContent = `太陽高度(${MIN_ALTITUDE_DEG}–${MAX_ALTITUDE_DEG}°。0° が地平線、負は日没後の薄明)`;

  const control = buildSliderRow({
    sliderId: 'sky-altitude-slider',
    ariaLabel: '太陽高度 (度)',
    sliderMax: ALTITUDE_SLIDER_STEPS,
    numberMin: MIN_ALTITUDE_DEG,
    numberMax: MAX_ALTITUDE_DEG,
    numberStep: ALTITUDE_STEP_DEG,
    unit: '°',
    onSlider: (position) => setAltitude(positionToAltitude(position)),
    onNumber: setAltitude,
    writeBack: () => state.sunAltitudeDeg.toFixed(1),
    // 地平線がどこかは目盛りがないと分からない。軸が −18° から始まるので、
    // 0° はスライダーの左寄り(全体の 1/6)という中途半端な位置に来る。
    ticks: [
      {
        fraction: altitudeToPosition(0) / ALTITUDE_SLIDER_STEPS,
        label: '0°(地平線)',
      },
    ],
  });
  altitudeSlider = control.slider;
  altitudeNumber = control.number;

  const buttons = document.createElement('div');
  buttons.className = 'sky-presets__buttons';
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sky-presets__button';
    button.textContent = preset.name;
    button.title = preset.hint;
    button.addEventListener('click', () => {
      presetHint.textContent = preset.hint;
      setAltitude(preset.altitudeDeg);
    });
    buttons.append(button);
  }

  presetHint = document.createElement('p');
  presetHint.className = 'sky-presets__hint';
  presetHint.textContent = defaultPreset.hint;

  // --- エアロゾル ---
  aerosolCheckbox = document.createElement('input');
  aerosolCheckbox.type = 'checkbox';
  aerosolCheckbox.id = 'sky-aerosol-toggle';
  aerosolCheckbox.checked = state.aerosolEnabled;
  aerosolCheckbox.addEventListener('change', () => {
    state.aerosolEnabled = aerosolCheckbox.checked;
    scheduleRender();
  });

  const aerosolLabel = document.createElement('label');
  aerosolLabel.className = 'field-label sky__toggle-label';
  aerosolLabel.htmlFor = 'sky-aerosol-toggle';
  aerosolLabel.append(aerosolCheckbox, document.createTextNode('エアロゾル(Mie 散乱)を入れる'));

  const aerosol = buildSliderRow({
    sliderId: 'sky-aerosol-slider',
    ariaLabel: 'エアロゾルの光学的厚さ (550nm)',
    sliderMax: AEROSOL_SLIDER_STEPS,
    numberMin: MIN_AEROSOL,
    numberMax: MAX_AEROSOL,
    numberStep: AEROSOL_STEP,
    unit: 'AOD',
    onSlider: (position) => setAerosol(position * AEROSOL_STEP),
    onNumber: setAerosol,
    writeBack: () => state.aerosolOpticalDepth.toFixed(2),
  });
  aerosolSlider = aerosol.slider;
  aerosolNumber = aerosol.number;

  const aerosolHint = document.createElement('p');
  aerosolHint.className = 'sky-presets__hint';
  aerosolHint.textContent =
    '550nm での光学的厚さ (AOD)。澄んだ日で 0.05 前後、都市の霞んだ日で 0.3 を超える。前方に強く偏って散乱するので、太陽の周りだけが白く輝く。';

  const temperatureLabel = document.createElement('label');
  temperatureLabel.className = 'field-label';
  temperatureLabel.htmlFor = 'sky-temperature-slider';
  temperatureLabel.textContent = `太陽の温度 T(${MIN_TEMPERATURE_K}–${MAX_TEMPERATURE_K} K。分光分布を決める)`;

  const temperature = buildSliderRow({
    sliderId: 'sky-temperature-slider',
    ariaLabel: '温度 (K)',
    sliderMax: TEMPERATURE_SLIDER_STEPS,
    numberMin: MIN_TEMPERATURE_K,
    numberMax: MAX_TEMPERATURE_K,
    numberStep: 1,
    unit: 'K',
    // 黒体ページと同じく 1/T について線形に並べる。
    onSlider: (position) => setTemperature(positionToTemperature(position / TEMPERATURE_SLIDER_STEPS)),
    onNumber: setTemperature,
    writeBack: () => String(state.temperatureK),
  });
  temperatureSlider = temperature.slider;
  temperatureNumber = temperature.number;

  panel.append(
    label,
    control.row,
    buttons,
    presetHint,
    aerosolLabel,
    aerosol.row,
    aerosolHint,
    temperatureLabel,
    temperature.row,
  );
  return panel;
}

function buildBarPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '空の色(−90° が東の地平線、0° が天頂、+90° が西の地平線。縦線は太陽の位置)';

  // onSelect は渡さない = 表示専用。角度はパラメータではないので、
  // 帯をクリックしても動かすものがない。
  bar = new GradientBar({
    min: MIN_SKY_ANGLE_DEG,
    max: MAX_SKY_ANGLE_DEG,
    colorAt: (angleDeg) => colorAt(angleDeg).rgb8,
    ticks: BAR_TICKS,
    formatTick: (value) => `${value}°`,
    maxSamples: BAR_SAMPLES,
  });

  section.append(label, bar.element);
  return section;
}

function buildChartPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '代表 3 方向の分光放射輝度(点線は大気圏外の太陽スペクトル)';

  chart = new SpectrumChart({
    lambdaMin: VISIBLE_LAMBDA_MIN,
    lambdaMax: VISIBLE_LAMBDA_MAX,
    xTicks: CHART_X_TICKS,
  });

  section.append(label, chart.element);
  return section;
}

function buildResultPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel sky-result';

  const make = (): HTMLElement => {
    const swatch = document.createElement('div');
    swatch.className = 'sky-result__swatch';
    return swatch;
  };
  swatches = { zenith: make(), sun: make(), opposite: make() };

  const row = document.createElement('div');
  row.className = 'sky-result__swatches';
  row.append(
    captioned('天頂', swatches.zenith),
    captioned('太陽の方向', swatches.sun),
    captioned('太陽の反対側', swatches.opposite),
  );

  values = new ValueList([
    { key: 'zenith', term: '天頂' },
    { key: 'sun', term: '太陽の方向' },
    { key: 'opposite', term: '太陽の反対側' },
    { key: 'share', term: '多重散乱の寄与' },
  ]);

  notes = document.createElement('div');
  notes.className = 'sky-result__notes';

  // 注記は値の下、スウォッチの右側に置く。パネルの下に敷くと、注記の増減で
  // パネルの高さが変わってページ全体が動いてしまう。
  const side = document.createElement('div');
  side.className = 'sky-result__side';
  side.append(values.element, notes);

  const layout = document.createElement('div');
  layout.className = 'sky-result__layout';
  layout.append(row, side);

  section.append(layout);
  return section;
}

function captioned(caption: string, swatch: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'sky-result__swatch-wrapper';

  const label = document.createElement('span');
  label.className = 'sky-result__caption';
  label.textContent = caption;

  wrapper.append(swatch, label);
  return wrapper;
}

function buildModePanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'radio-group-row';

  modeGroups = [
    createRadioGroup<'single' | 'multiple'>(
      'scattering-order',
      '散乱の次数',
      [
        {
          value: 'single',
          label: '単散乱のみ',
          hint: '1 回だけ散乱された光。閉じた形で解ける代わり、色相が天頂を挟んで左右対称になる。',
        },
        {
          value: 'multiple',
          label: '多重散乱を含む',
          hint: '2 回以上散乱された光を等方な成分として足す。全体が明るくなり、太陽側と反対側の差が出る。',
        },
      ],
      () => (state.multipleScattering ? 'multiple' : 'single'),
      (value) => {
        state.multipleScattering = value === 'multiple';
        scheduleRender();
      },
    ),
    createRadioGroup<BrightnessMode>(
      'brightness-mode',
      '明るさの決め方',
      [
        {
          value: 'scene',
          label: 'その空で正規化',
          hint: 'いちばん明るい方向(必ず地平線)を基準にする。どの高度でも空らしい明るさで見える。',
        },
        {
          value: 'absolute',
          label: '高度によらない共通スケール',
          hint: '太陽が低いほど実際に暗くなる。日没に向けて空が暗くなっていく様子が見える。',
        },
      ],
      () => state.brightness,
      (value) => {
        state.brightness = value;
        scheduleRender();
      },
    ),
  ];

  panel.append(...modeGroups.map((group) => group.element));
  return panel;
}

// --- 描画 --------------------------------------------------------------------

function renderNotes(zenith: ColorResult): void {
  const messages: string[] = [];

  if (state.multipleScattering && state.sunAltitudeDeg <= 0) {
    messages.push(
      '太陽が地平線以下では多重散乱の見積もりが 0 になります(平行平面の収支が使えないため)。実際の薄明の明るさは大半が多重散乱です。',
    );
  }
  if (zenith.outOfGamut) {
    const ratio = zenith.whiteAdded / (zenith.whiteAdded + Math.max(zenith.xyz[1], 1e-12));
    messages.push(
      `天頂の色は sRGB の色域外です。白を約 ${(ratio * 100).toFixed(0)}% 混ぜて彩度を落としてあります。`,
    );
  }
  if (zenith.clipped) {
    messages.push('明るさが表示の上限を超えています(白飛び)。');
  }
  // 何も問題がないときも同じ場所に文章を出す。空にしておくと、確保した余白が
  // ただの隙間に見えてしまう。
  if (messages.length === 0) {
    messages.push('天頂の色は sRGB の色域内に収まっており、表示色は忠実です。');
  }

  notes.replaceChildren(
    ...messages.map((message) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'sky-result__note';
      paragraph.textContent = message;
      return paragraph;
    }),
  );
}

/**
 * 401 点の分光放射輝度の表を、波長を受ける関数に変える。
 *
 * グラフは画素ごとに値を要るので、表のまま渡して**ここで線形補間する**。
 * スペクトルはプランク曲線 × exp(−τ(λ)m) で 1nm の刻みに対して十分滑らかなので、
 * 補間の誤差は相対 1e-6 程度 — 縦 300px の図では見えない。
 *
 * 表で受け渡すのは、ワーカーへ移すときに `Float64Array` がそのまま転送できるのと、
 * 解放の要るハンドルを増やさずに済むため(`cmfAt` の補間と同じ形にしてある)。
 */
function samplerFromTable(table: Float64Array): (lambdaNm: number) => number {
  return (lambdaNm) => {
    const position = lambdaNm - SPECTRUM_TABLE_LAMBDA_MIN;
    if (!(position >= 0) || position > table.length - 1) return 0;
    const index = Math.floor(position);
    const fraction = position - index;
    const value = table[index]!;
    if (fraction === 0 || index + 1 >= table.length) return value;
    return value + (table[index + 1]! - value) * fraction;
  };
}

function renderChart(sunAngle: number): void {
  // 方向ごとに球殻の行進は 1 度だけ。曲線は画素ごとに呼ばれるので、
  // ここで表に焼いておかないと幾何を毎画素で解き直すことになる。
  const directions = [
    { angle: 0, label: '天頂', sample: samplerFromTable(model().spectrumTable(0)) },
    {
      angle: sunAngle,
      label: '太陽の方向',
      sample: samplerFromTable(model().spectrumTable(sunAngle)),
    },
    {
      angle: -sunAngle,
      label: '太陽の反対側',
      sample: samplerFromTable(model().spectrumTable(-sunAngle)),
    },
  ] as const;

  // 3 方向のうち最も大きい放射輝度を 1 とする。方向ごとに正規化すると
  // 「どの方向がどれだけ明るいか」が図から消えてしまう。
  let peak = 0;
  for (const { sample } of directions) {
    for (let lambdaNm = VISIBLE_LAMBDA_MIN; lambdaNm <= VISIBLE_LAMBDA_MAX; lambdaNm += 5) {
      peak = Math.max(peak, sample(lambdaNm));
    }
  }
  const scale = peak > 0 ? 1 / peak : 0;

  // 入射スペクトルは形を比べるためのものなので、可視域のピークを 1 に合わせる。
  let solarPeak = 0;
  for (let lambdaNm = VISIBLE_LAMBDA_MIN; lambdaNm <= VISIBLE_LAMBDA_MAX; lambdaNm += 5) {
    solarPeak = Math.max(solarPeak, normalizedSpectrum(lambdaNm, state.temperatureK));
  }
  const solarScale = solarPeak > 0 ? 1 / solarPeak : 0;

  const curves: ChartCurve[] = directions.map(({ angle, sample }) => ({
    valueAt: (lambdaNm) => sample(lambdaNm) * scale,
    color: colorAt(angle).hex,
    fill: false,
  }));
  curves.push({
    valueAt: (lambdaNm) => normalizedSpectrum(lambdaNm, state.temperatureK) * solarScale,
    color: xyzToColor(blackbodyXYZ(state.temperatureK), 'max').hex,
    dashed: true,
    width: 1.5,
  });

  chart?.setState({
    axis: { kind: 'linear', max: 1, ticks: CHART_Y_TICKS },
    axisTitle: '最も明るい方向のピークを 1 とした比',
    curves,
    legend: [
      ...directions.map(({ angle, label }) => ({ label, color: colorAt(angle).hex })),
      {
        label: '大気圏外の太陽',
        color: xyzToColor(blackbodyXYZ(state.temperatureK), 'max').hex,
        dashed: true,
      },
    ],
  });
}

function renderNow(): void {
  const { sunAltitudeDeg, temperatureK } = state;
  // 太陽が沈むと空の角度が 90° を超えるので、代表方向は地平線で止める。
  const sunAngle = representativeAngle(sunAltitudeDeg);

  // wasm 実装ではハンドルなので、作り直す前に必ず解放する。
  currentModel?.free();
  currentModel = backend().createModel(currentConditions());
  // 覚え書きはモデルと一対一。作り直したら必ず捨てる。
  xyzCache = new Map<number, XYZ>();

  // 帯が要る全方向を **1 回の呼び出しで** 解いて覚え書きに詰める。方向ごとに
  // 呼ぶと wasm との境界を 363 回跨ぐことになり、まとめた意味がなくなる。
  const primed = Float64Array.from([...barSampleAngles(), 0, sunAngle, -sunAngle]);
  const flat = currentModel.xyzMany(primed);
  for (let i = 0; i < primed.length; i += 1) {
    xyzCache.set(primed[i]!, [flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!]);
  }

  currentScale =
    state.brightness === 'absolute'
      ? absoluteScale()
      : ((): number => {
          const peak = scenePeak(sunAltitudeDeg);
          return peak > 0 ? 1 / peak : 1;
        })();

  altitudeSlider.value = String(altitudeToPosition(sunAltitudeDeg));
  if (document.activeElement !== altitudeNumber) {
    altitudeNumber.value = sunAltitudeDeg.toFixed(1);
  }
  temperatureSlider.value = String(
    Math.round(temperatureToPosition(temperatureK) * TEMPERATURE_SLIDER_STEPS),
  );
  if (document.activeElement !== temperatureNumber) {
    temperatureNumber.value = String(temperatureK);
  }

  aerosolCheckbox.checked = state.aerosolEnabled;
  aerosolSlider.value = String(Math.round(state.aerosolOpticalDepth / AEROSOL_STEP));
  if (document.activeElement !== aerosolNumber) {
    aerosolNumber.value = state.aerosolOpticalDepth.toFixed(2);
  }
  // 量は覚えたまま、無効なあいだは触れないようにする。
  aerosolSlider.disabled = !state.aerosolEnabled;
  aerosolNumber.disabled = !state.aerosolEnabled;

  const zenith = colorAt(0);
  const sun = colorAt(sunAngle);
  const opposite = colorAt(-sunAngle);

  swatches.zenith.style.backgroundColor = zenith.hex;
  swatches.sun.style.backgroundColor = sun.hex;
  swatches.opposite.style.backgroundColor = opposite.hex;

  values.set('zenith', zenith.hex);
  values.set('sun', `${sun.hex}(西 ${sunAngle.toFixed(0)}°)`, sun.hex);
  values.set('opposite', `${opposite.hex}(東 ${sunAngle.toFixed(0)}°)`, opposite.hex);

  const share = currentModel.multipleScatteringShare();
  values.set('share', `${(share * 100).toFixed(1)} %`, share.toFixed(6));

  renderNotes(zenith);
  for (const group of modeGroups) group.sync();

  // マーカーには丸めていない太陽の角度を渡す。地平線より下へ回ると帯の範囲外に
  // なり、GradientBar 側で描かれなくなる — 太陽が沈めば縦線も消える、が正しい。
  bar?.setMarkers([{ value: sunSkyAngleDeg(sunAltitudeDeg) }]);
  // 帯の色は状態で変わるので、作り直しを明示的に指示する。
  bar?.recolor();
  renderChart(sunAngle);
}

// --- ライフサイクル -----------------------------------------------------------

export function mount(root: HTMLElement): void {
  mounted = true;

  const container = document.createElement('div');
  container.className = 'sky';

  const lead = document.createElement('p');
  lead.className = 'sky__lead';
  lead.textContent =
    '大気にばらまかれた光が空を満たします。ある方向の明るさは、視線に沿って直達光が散乱された分を足し合わせたものです。大気は球殻として扱い、視線を行進しながら各点が地球の影に入っていないかを判定しています — 平行平面には地球の影が存在せず、日没直前でも東の地平線が西とまったく同じ色になってしまうためです。散乱は 2 種類で、空気分子によるレイリー散乱(前後対称、λ⁻⁴ に近い)と、エアロゾルによる Mie 散乱(強く前方に偏り、波長にはあまり依らない)。多重散乱は「2 回以上散乱された光は等方に散らばる」という 1 つの仮定を置き、平行平面のエネルギー収支の残差から見積もっています。オゾンの吸収、地面の反射、大気による屈折、エアロゾルの吸収は入れていません。';

  // 並び順の意図: スライダーを動かしながら帯と図の変化を見たいので、操作するものを
  // 上に固め、その直後に帯と図を置く(黒体放射ページ以来の判断)。
  container.append(
    lead,
    buildControlPanel(),
    buildBarPanel(),
    // 図と結果は帯より下。スライダーを動かしながら見るのは帯なので、
    // 操作部と帯の距離を詰めることを優先している。
    buildChartPanel(),
    buildResultPanel(),
    buildModePanel(),
  );
  root.append(container);

  // ここだけは同期で描く。直後の refresh() が状態の書き込み済みを前提にしている。
  renderNow();
  // DOM に入って幅が確定してから描く(ResizeObserver の初回通知には頼らない)。
  bar?.refresh();
  chart?.refresh();

  /*
   * wasm 実装は **既定では使わない**。URL に `wasm=1` を付けたときだけ読む。
   *
   * デスクトップ (V8) で実測すると wasm のほうが 1.8 倍**遅い**。この計算は
   * ほぼ全部が exp(1 描画あたり 450 万回)で、wasm には exp 命令が無いため
   * Rust の f64::exp はソフトウェア実装になる — 実測 6.6ns/回 に対して
   * V8 の Math.exp は 3.9ns/回。表引き方式を自前で書いても 6.2ns 止まりで、
   * 差は埋まらなかった。
   *
   * ただし測れたのはデスクトップだけで、**このページが重いのはスマートフォン**。
   * モバイルでは JIT の暖機や GC の効き方が違うので、結論が変わりうる。
   * そこを実機で比べられるよう、切り替えだけ残してある:
   *
   *   ?wasm=1#/sky   … wasm 実装
   *   #/sky          … TypeScript 実装(既定)
   *
   * 読み込みは待たない。初回描画を取得と instantiate に待たせる理由がないし、
   * 待たない作りなら取得に失敗しても「遅いが動くページ」に落ちる。
   */
  if (wasmRequested()) {
    void initWasmBackend().then((ready) => {
      if (ready && mounted) scheduleRender();
    });
  }
}

export function unmount(): void {
  mounted = false;
  // DOM の外にぶら下がるものを先に解除する。予約したまま破棄すると、
  // 破棄済みの帯や図に対してコールバックが走る。
  if (renderHandle !== 0) {
    cancelAnimationFrame(renderHandle);
    renderHandle = 0;
  }
  // 予約を外してから解放する。逆にすると、キューに残ったコールバックが
  // 解放済みのモデルを触りにいく。
  currentModel?.free();
  currentModel = null;
  bar?.destroy();
  bar = null;
  chart?.destroy();
  chart = null;
  values.destroy();
  modeGroups = [];
}
