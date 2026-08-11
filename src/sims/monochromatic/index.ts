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
import { SpectrumBar } from './spectrum-bar.ts';

/** 初期波長。ナトリウム D 線 (589nm) は身近な単色光の代表例。 */
const DEFAULT_LAMBDA_NM = 589;

interface State {
  lambdaNm: number;
  mode: NormalizeMode;
}

const state: State = { lambdaNm: DEFAULT_LAMBDA_NM, mode: 'max' };

let spectrumBar: SpectrumBar | null = null;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

// mount 時に組み立て、render で中身を書き替える要素。
let slider: HTMLInputElement;
let numberInput: HTMLInputElement;
let swatch: HTMLElement;
let gamutNote: HTMLElement;
let valueCells: Record<'rgb' | 'hex' | 'linear' | 'efficiency', HTMLElement>;

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
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'mono__mode';

  const legend = document.createElement('legend');
  legend.className = 'field-label';
  legend.textContent = '明るさの決め方';
  fieldset.append(legend);

  const modes: Array<{ value: NormalizeMode; label: string; hint: string }> = [
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
  ];

  for (const mode of modes) {
    const option = document.createElement('label');
    option.className = 'mono__mode-option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'normalize-mode';
    radio.value = mode.value;
    radio.checked = state.mode === mode.value;
    radio.addEventListener('change', () => {
      if (radio.checked) setMode(mode.value);
    });

    const text = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'mono__mode-title';
    title.textContent = mode.label;
    const hint = document.createElement('span');
    hint.className = 'mono__mode-hint';
    hint.textContent = mode.hint;
    text.append(title, hint);

    option.append(radio, text);
    fieldset.append(option);
  }

  return fieldset;
}

/** クリックで内容をクリップボードへコピーできる値セルを作る。 */
function buildValueRow(term: string): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'mono__value-row';

  const dt = document.createElement('dt');
  dt.textContent = term;

  const dd = document.createElement('dd');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mono__value';
  button.title = 'クリックでコピー';
  button.addEventListener('click', () => {
    void copyToClipboard(button);
  });
  dd.append(button);

  row.append(dt, dd);
  return { row, value: button };
}

async function copyToClipboard(button: HTMLElement): Promise<void> {
  const text = button.dataset['copy'] ?? button.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボードが使えない環境(非セキュアコンテキストや権限拒否)では
    // 黙って何もしない。表示自体は読めているので機能上の支障はない。
    return;
  }

  if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
  button.classList.add('mono__value--copied');
  copyFeedbackTimer = setTimeout(() => {
    button.classList.remove('mono__value--copied');
    copyFeedbackTimer = null;
  }, 900);
}

function buildSwatchArea(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel mono__result';

  swatch = document.createElement('div');
  swatch.className = 'mono__swatch';

  const values = document.createElement('dl');
  values.className = 'mono__values';

  const rgb = buildValueRow('RGB (8bit)');
  const hex = buildValueRow('HEX');
  const linear = buildValueRow('linear RGB');
  const efficiency = buildValueRow('視感度 V(λ)');
  values.append(rgb.row, hex.row, linear.row, efficiency.row);

  valueCells = {
    rgb: rgb.value,
    hex: hex.value,
    linear: linear.value,
    efficiency: efficiency.value,
  };

  const layout = document.createElement('div');
  layout.className = 'mono__result-layout';
  layout.append(swatch, values);

  gamutNote = document.createElement('p');
  gamutNote.className = 'mono__gamut-note';

  section.append(layout, gamutNote);
  return section;
}

function buildSpectrumSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel mono__spectrum';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '可視光スペクトル(クリックまたはドラッグで波長を選択)';

  spectrumBar = new SpectrumBar({
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
    'この単色光は sRGB の色域外です。表示のために白を混ぜて彩度を落としてあり' +
    `(白の割合 約 ${(ratio * 100).toFixed(0)}%)、実際にはこれよりも鮮やかな色に見えます。`
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
  valueCells.rgb.textContent = `R ${r} / G ${g} / B ${b}`;
  valueCells.rgb.dataset['copy'] = `rgb(${r}, ${g}, ${b})`;

  valueCells.hex.textContent = color.hex;
  valueCells.hex.dataset['copy'] = color.hex;

  const linear = color.linearRGB.map((v) => v.toFixed(4));
  valueCells.linear.textContent = linear.join(' / ');
  valueCells.linear.dataset['copy'] = linear.join(', ');

  valueCells.efficiency.textContent = color.luminousEfficiency.toFixed(4);
  valueCells.efficiency.dataset['copy'] = color.luminousEfficiency.toFixed(6);

  gamutNote.textContent = formatGamutNote(color);
  spectrumBar?.setLambda(state.lambdaNm);
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

  if (copyFeedbackTimer !== null) {
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
}
