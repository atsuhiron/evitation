/**
 * 単色光の色シミュレータ。
 *
 * 可視光の波長を選ぶと、CIE 1931 等色関数を通して対応する sRGB の色を表示する。
 */

import './monochromatic.css';
import {
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  wavelengthToColor,
  type NormalizeMode,
  type WavelengthColor,
} from '../../color/index.ts';
import type { GradientBar } from '../../ui/gradient-bar.ts';
import { createRadioGroup } from '../../ui/radio-group.ts';
import { createSpectrumBar } from '../../ui/spectrum-bar.ts';
import { ValueList } from '../../ui/value-list.ts';

/** 初期波長。ナトリウム D 線 (589nm) は身近な単色光の代表例。 */
const DEFAULT_LAMBDA_NM = 589;

interface State {
  lambdaNm: number;
  mode: NormalizeMode;
}

const state: State = { lambdaNm: DEFAULT_LAMBDA_NM, mode: 'max' };

let spectrumBar: GradientBar | null = null;
let values: ValueList;

// mount 時に組み立て、render で中身を書き替える要素。
let slider: HTMLInputElement;
let numberInput: HTMLInputElement;
let swatch: HTMLElement;
let gamutNote: HTMLElement;

function clampLambda(value: number): number {
  return Math.min(VISIBLE_LAMBDA_MAX, Math.max(VISIBLE_LAMBDA_MIN, Math.round(value)));
}

function setLambda(value: number): void {
  const lambdaNm = clampLambda(value);
  if (lambdaNm === state.lambdaNm) return;
  state.lambdaNm = lambdaNm;
  render();
}

function setMode(mode: NormalizeMode): void {
  if (mode === state.mode) return;
  state.mode = mode;
  render();
}

// --- 部品の組み立て ---------------------------------------------------------

function buildWavelengthControl(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel mono__control';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = 'lambda-slider';
  label.textContent = `波長 λ(${VISIBLE_LAMBDA_MIN}–${VISIBLE_LAMBDA_MAX} nm)`;

  slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'lambda-slider';
  slider.className = 'mono__slider';
  slider.min = String(VISIBLE_LAMBDA_MIN);
  slider.max = String(VISIBLE_LAMBDA_MAX);
  slider.step = '1';

  numberInput = document.createElement('input');
  numberInput.type = 'number';
  numberInput.className = 'mono__number';
  numberInput.min = String(VISIBLE_LAMBDA_MIN);
  numberInput.max = String(VISIBLE_LAMBDA_MAX);
  numberInput.step = '1';
  numberInput.setAttribute('aria-label', '波長 (nm)');

  const unit = document.createElement('span');
  unit.className = 'mono__unit';
  unit.textContent = 'nm';

  const inputGroup = document.createElement('div');
  inputGroup.className = 'mono__number-group';
  inputGroup.append(numberInput, unit);

  const row = document.createElement('div');
  row.className = 'mono__control-row';
  row.append(slider, inputGroup);

  slider.addEventListener('input', () => {
    setLambda(Number(slider.value));
  });

  // 入力途中の値も反映するが、範囲外や空欄でその場では書き戻さない
  // (打ち込んでいる最中に勝手に値が変わると入力しづらいため)。
  numberInput.addEventListener('input', () => {
    const value = Number(numberInput.value);
    if (numberInput.value !== '' && Number.isFinite(value)) {
      setLambda(value);
    }
  });
  // 確定時にだけ、範囲内へ丸めた値を表示に反映する。
  numberInput.addEventListener('change', () => {
    numberInput.value = String(state.lambdaNm);
  });
  numberInput.addEventListener('blur', () => {
    numberInput.value = String(state.lambdaNm);
  });

  panel.append(label, row);
  return panel;
}

function buildModeControl(): HTMLElement {
  const group = createRadioGroup<NormalizeMode>(
    'normalize-mode',
    '明るさの決め方',
    [
      {
        value: 'max',
        label: '最大成分正規化',
        hint: 'どの波長も同じ明るさで表示する。色相の比較に向く。',
      },
      {
        value: 'luminance',
        label: '相対輝度',
        hint: '表示輝度を視感度 V(λ) に比例させる。555nm が最も明るい。',
      },
    ],
    () => state.mode,
    setMode,
  );
  // 群がひとつだけの画面なので、選択肢は横に並べる。
  group.element.classList.add('radio-group--inline');
  return group.element;
}

function buildSwatchArea(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel mono__result';

  swatch = document.createElement('div');
  swatch.className = 'mono__swatch';

  values = new ValueList([
    { key: 'rgb', term: 'RGB (8bit)' },
    { key: 'hex', term: 'HEX' },
    { key: 'linear', term: 'linear RGB' },
    { key: 'efficiency', term: '視感度 V(λ)' },
  ]);

  gamutNote = document.createElement('p');
  gamutNote.className = 'mono__gamut-note';

  // 注記は値の下、スウォッチの右側に置く。パネルの下に敷くと、文章の行数が
  // 変わったときにパネルの高さが変わってページ全体が動いてしまう。
  const side = document.createElement('div');
  side.className = 'mono__result-side';
  side.append(values.element, gamutNote);

  const layout = document.createElement('div');
  layout.className = 'mono__result-layout';
  layout.append(swatch, side);

  section.append(layout);
  return section;
}

function buildSpectrumSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel mono__spectrum';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '可視光スペクトル(クリックまたはドラッグで波長を選択)';

  spectrumBar = createSpectrumBar({
    lambdaMin: VISIBLE_LAMBDA_MIN,
    lambdaMax: VISIBLE_LAMBDA_MAX,
    onSelect: setLambda,
  });

  section.append(label, spectrumBar.element);
  return section;
}

// --- 描画 --------------------------------------------------------------------

function formatGamutNote(color: WavelengthColor): string {
  if (!color.outOfGamut) {
    return 'この波長は sRGB の色域内に収まっており、表示色は忠実です。';
  }
  // 白をどれだけ混ぜたかを、正規化後のスケールでの割合として示す。
  const ratio = color.whiteAdded / (color.whiteAdded + Math.max(color.xyz[1], 1e-12));
  return (
    `この単色光は sRGB の色域外です。白を約 ${(ratio * 100).toFixed(0)}% 混ぜて彩度を` +
    '落としてあり、実際はこれより鮮やかな色に見えます。'
  );
}

function render(): void {
  const color = wavelengthToColor(state.lambdaNm, state.mode);

  slider.value = String(state.lambdaNm);
  if (document.activeElement !== numberInput) {
    numberInput.value = String(state.lambdaNm);
  }

  swatch.style.backgroundColor = color.hex;

  const [r, g, b] = color.rgb8;
  values.set('rgb', `R ${r} / G ${g} / B ${b}`, `rgb(${r}, ${g}, ${b})`);
  values.set('hex', color.hex);

  const linear = color.linearRGB.map((v) => v.toFixed(4));
  values.set('linear', linear.join(' / '), linear.join(', '));

  values.set('efficiency', color.luminousEfficiency.toFixed(4), color.luminousEfficiency.toFixed(6));

  gamutNote.textContent = formatGamutNote(color);
  spectrumBar?.setMarkers([{ value: state.lambdaNm }]);
}

// --- ライフサイクル -----------------------------------------------------------

export function mount(root: HTMLElement): void {
  const container = document.createElement('div');
  container.className = 'mono';

  const lead = document.createElement('p');
  lead.className = 'mono__lead';
  lead.textContent =
    '単一の波長だけを持つ光(単色光)の色を求めます。波長から CIE 1931 等色関数で三刺激値 XYZ を得て、sRGB へ変換しています。';

  container.append(
    lead,
    buildWavelengthControl(),
    buildSwatchArea(),
    buildModeControl(),
    buildSpectrumSection(),
  );
  root.append(container);

  render();
  // DOM に入って幅が確定してから帯を描く(ResizeObserver の初回通知には頼らない)。
  spectrumBar?.refresh();
}

export function unmount(): void {
  spectrumBar?.destroy();
  spectrumBar = null;
  values.destroy();
}
