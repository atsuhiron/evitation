/**
 * 可視光スペクトル帯(共有コンポーネント)。
 *
 * 横軸に波長を取り、各画素列をその波長の色で塗る。任意個のマーカーを重ねられる。
 * `onSelect` を渡したときだけクリック / ドラッグで波長を選べるようになる。
 */

import './spectrum-bar.css';
import { wavelengthToColor } from '../color/index.ts';

export interface SpectrumMarker {
  readonly lambdaNm: number;
  /**
   * 線の高さ (0..1)。省略時は 1(全高)。
   * 合成ページで各成分の強度を高さとして見せるために使う。
   */
  readonly weight?: number;
}

export interface SpectrumBarOptions {
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /**
   * 帯の上で波長が選ばれたときに呼ばれる。値は整数 nm に丸めて渡す。
   * 省略すると帯は表示専用になる(成分が複数ある画面では、帯のどこを掴んでも
   * どれを動かすべきか決まらないため)。
   */
  readonly onSelect?: (lambdaNm: number) => void;
}

export class SpectrumBar {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: SpectrumBarOptions;
  private readonly resizeObserver: ResizeObserver;

  /**
   * 帯そのものの画素データ。波長は幅にしか依存しないので、
   * 幅が変わらない限り作り直さずマーカーだけ描き替える。
   */
  private baseImage: ImageData | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;
  private markers: readonly SpectrumMarker[] = [];

  constructor(options: SpectrumBarOptions) {
    this.options = options;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-bar__canvas';
    // 同じ操作はスライダーでもできるので、支援技術にはスライダーだけを見せる。
    this.canvas.setAttribute('aria-hidden', 'true');

    const context = this.canvas.getContext('2d', { willReadFrequently: false });
    if (context === null) {
      throw new Error('2D コンテキストを取得できませんでした');
    }
    this.context = context;

    this.element = document.createElement('div');
    this.element.className = 'spectrum-bar';
    this.element.append(this.canvas, this.buildTicks());

    if (options.onSelect !== undefined) {
      this.canvas.classList.add('spectrum-bar__canvas--interactive');
      this.canvas.addEventListener('pointerdown', this.handlePointerDown);
      this.canvas.addEventListener('pointermove', this.handlePointerMove);
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.refresh();
    });
    this.resizeObserver.observe(this.canvas);
  }

  /**
   * 現在のサイズに合わせて描き直す。
   *
   * DOM に挿入した直後は呼び出し側から明示的に呼ぶこと。ResizeObserver の通知は
   * 描画ライフサイクルの一部として配られるので、フレームが生成されるまで届かず、
   * これに初回描画を任せると帯が空白のままになりうる。
   */
  refresh(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));

    if (width !== this.renderedWidth || height !== this.renderedHeight) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderedWidth = width;
      this.renderedHeight = height;
      this.baseImage = this.renderSpectrum(width, height);
    }
    this.paint();
  }

  setMarkers(markers: readonly SpectrumMarker[]): void {
    this.markers = markers;
    this.paint();
  }

  /** DOM の外にぶら下がるものを解除する。DOM 自体はルータ側が破棄する。 */
  destroy(): void {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
  }

  // --- 目盛り ---

  private buildTicks(): HTMLElement {
    const ticks = document.createElement('div');
    ticks.className = 'spectrum-bar__ticks';
    ticks.setAttribute('aria-hidden', 'true');

    const span = this.options.lambdaMax - this.options.lambdaMin;
    for (let lambda = 400; lambda <= this.options.lambdaMax; lambda += 50) {
      const tick = document.createElement('span');
      tick.className = 'spectrum-bar__tick';
      tick.style.left = `${((lambda - this.options.lambdaMin) / span) * 100}%`;
      tick.textContent = String(lambda);
      ticks.append(tick);
    }
    return ticks;
  }

  // --- 入力 ---

  private readonly handlePointerDown = (event: PointerEvent): void => {
    // ドラッグ中にカーソルが帯の外へ出ても追従させる。
    this.canvas.setPointerCapture(event.pointerId);
    this.selectFromPointer(event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.canvas.hasPointerCapture(event.pointerId)) return;
    this.selectFromPointer(event);
  };

  private selectFromPointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const { lambdaMin, lambdaMax } = this.options;
    this.options.onSelect?.(Math.round(lambdaMin + ratio * (lambdaMax - lambdaMin)));
  }

  // --- 描画 ---

  /**
   * 帯本体を作る。
   *
   * 明るさは常に最大成分正規化(`max`)で描く。相対輝度で描くと両端が真っ黒に沈んで
   * 「どこがどの波長か」が読めなくなり、目盛りとして機能しなくなるため。
   * 各ページの表示モードとは意図的に独立させている。
   */
  private renderSpectrum(width: number, height: number): ImageData {
    const image = this.context.createImageData(width, height);
    const { lambdaMin, lambdaMax } = this.options;
    const span = lambdaMax - lambdaMin;

    // 列ごとの色は 1 度だけ求め、あとは縦方向にコピーする。
    const columns = new Uint8ClampedArray(width * 3);
    for (let x = 0; x < width; x += 1) {
      const lambda = lambdaMin + ((x + 0.5) / width) * span;
      const [r, g, b] = wavelengthToColor(lambda, 'max').rgb8;
      columns[x * 3] = r;
      columns[x * 3 + 1] = g;
      columns[x * 3 + 2] = b;
    }

    const data = image.data;
    for (let y = 0; y < height; y += 1) {
      let offset = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        data[offset] = columns[x * 3] ?? 0;
        data[offset + 1] = columns[x * 3 + 1] ?? 0;
        data[offset + 2] = columns[x * 3 + 2] ?? 0;
        data[offset + 3] = 255;
        offset += 4;
      }
    }
    return image;
  }

  private paint(): void {
    if (this.baseImage === null) return;

    this.context.putImageData(this.baseImage, 0, 0);

    // putImageData は変換行列の影響を受けないので、マーカーもデバイス画素で描く。
    const { lambdaMin, lambdaMax } = this.options;
    const dpr = window.devicePixelRatio || 1;
    const halfWidth = Math.max(1, dpr);

    for (const marker of this.markers) {
      const ratio = (marker.lambdaNm - lambdaMin) / (lambdaMax - lambdaMin);
      if (ratio < 0 || ratio > 1) continue;

      const x = ratio * this.renderedWidth;
      const weight = Math.min(1, Math.max(0, marker.weight ?? 1));
      // 弱い成分や強度 0 の成分も「そこに居る」ことは示したいので下限を設ける。
      // 比を素直に高さにすると、例えば輝度寄与 1% の成分が 1px 未満になり
      // 存在ごと見えなくなってしまう。
      const barHeight = Math.max(this.renderedHeight * weight, halfWidth * 6);
      const top = this.renderedHeight - barHeight;

      // 明るい帯の上でも暗い帯の上でも見えるよう、黒枠付きの白線にする。
      this.context.fillStyle = '#000';
      this.context.fillRect(x - halfWidth * 2, top, halfWidth * 4, barHeight);
      this.context.fillStyle = '#fff';
      this.context.fillRect(x - halfWidth, top, halfWidth * 2, barHeight);
    }
  }
}
