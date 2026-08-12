/**
 * 「値 → 色」のグラデーション帯(共有コンポーネント)。
 *
 * 横軸にひとつの量を取り、各画素列をその量に対応する色で塗る。任意個のマーカーを
 * 重ねられ、`onSelect` を渡したときだけクリック / ドラッグで値を選べるようになる。
 *
 * もとは可視光スペクトル帯の専用実装だった。色温度帯という 2 人目の利用者が
 * 現れたので、色の決め方(colorAt)と軸の取り方(valueAt / positionOf)を
 * 外から渡す形に一般化してある。波長軸に固定した薄いラッパが spectrum-bar.ts。
 */

import './gradient-bar.css';
import type { RGB8 } from '../color/index.ts';

export interface GradientMarker {
  readonly value: number;
  /**
   * 線の高さ (0..1)。省略時は 1(全高)。
   * 合成ページで各成分の強度を高さとして見せるために使う。
   */
  readonly weight?: number;
}

export interface GradientBarOptions {
  readonly min: number;
  readonly max: number;
  /** 帯の各点の色。 */
  readonly colorAt: (value: number) => RGB8;
  /** 目盛りを打つ値。 */
  readonly ticks: readonly number[];
  /** 目盛りの表示。既定は値をそのまま文字列化する。 */
  readonly formatTick?: (value: number) => string;
  /**
   * 位置 t (0..1) → 値。既定は min..max の線形補間。
   *
   * 非線形な軸(色温度帯は 1/T について線形に並べる)を作るためのフック。
   * `positionOf` とは互いに逆関数の関係になければならず、片方だけ渡すと例外を投げる。
   */
  readonly valueAt?: (t: number) => number;
  /** 値 → 位置 t (0..1)。`valueAt` の逆関数。 */
  readonly positionOf?: (value: number) => number;
  /**
   * 色を求める回数の上限。既定は画素列ごとに 1 回。
   *
   * colorAt が重い場合(色温度帯は 1 点ごとに分光分布を積分する)に、
   * 少ない標本を引き伸ばして描くためのもの。帯は滑らかな勾配なので、
   * 数百点もあれば画素単位で求めたものと見分けがつかない。
   */
  readonly maxSamples?: number;
  /**
   * 帯の上で値が選ばれたときに呼ばれる。丸めは呼び出し側の責任。
   * 省略すると帯は表示専用になる。
   */
  readonly onSelect?: (value: number) => void;
}

export class GradientBar {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: GradientBarOptions;
  private readonly valueAt: (t: number) => number;
  private readonly positionOf: (value: number) => number;
  private readonly resizeObserver: ResizeObserver;

  /**
   * 帯そのものの画素データ。色は幅にしか依存しないので、
   * 幅が変わらない限り作り直さずマーカーだけ描き替える。
   */
  private baseImage: ImageData | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;
  private markers: readonly GradientMarker[] = [];

  constructor(options: GradientBarOptions) {
    if ((options.valueAt === undefined) !== (options.positionOf === undefined)) {
      throw new Error('valueAt と positionOf は両方揃えて渡してください');
    }

    this.options = options;
    const span = options.max - options.min;
    this.valueAt = options.valueAt ?? ((t) => options.min + t * span);
    this.positionOf = options.positionOf ?? ((value) => (value - options.min) / span);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gradient-bar__canvas';
    // 同じ操作はスライダーでもできるので、支援技術にはスライダーだけを見せる。
    this.canvas.setAttribute('aria-hidden', 'true');

    const context = this.canvas.getContext('2d', { willReadFrequently: false });
    if (context === null) {
      throw new Error('2D コンテキストを取得できませんでした');
    }
    this.context = context;

    this.element = document.createElement('div');
    this.element.className = 'gradient-bar';
    this.element.append(this.canvas, this.buildTicks());

    if (options.onSelect !== undefined) {
      this.canvas.classList.add('gradient-bar__canvas--interactive');
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
      this.baseImage = this.renderGradient(width, height);
    }
    this.paint();
  }

  /**
   * `colorAt` の返す色が変わったときに呼ぶ。帯を作り直して描き直す。
   *
   * `refresh()` が幅と高さしか見ないのは、スペクトル帯も色温度帯も色が状態に
   * 依存しない(波長 → 色、温度 → 色 が固定)ため。空の色の帯は太陽高度と
   * 温度で全体の色が変わるので、こちらから明示的に無効化する。
   */
  recolor(): void {
    this.baseImage = null;
    this.renderedWidth = 0;
    this.renderedHeight = 0;
    this.refresh();
  }

  setMarkers(markers: readonly GradientMarker[]): void {
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
    ticks.className = 'gradient-bar__ticks';
    ticks.setAttribute('aria-hidden', 'true');

    const format = this.options.formatTick ?? String;
    for (const value of this.options.ticks) {
      const tick = document.createElement('span');
      tick.className = 'gradient-bar__tick';
      tick.style.left = `${this.positionOf(value) * 100}%`;
      tick.textContent = format(value);
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

    const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    this.options.onSelect?.(this.valueAt(t));
  }

  // --- 描画 ---

  /** 帯本体を作る。列ごとの色は 1 度だけ求め、あとは縦方向にコピーする。 */
  private renderGradient(width: number, height: number): ImageData {
    const image = this.context.createImageData(width, height);

    const sampleCount = Math.max(1, Math.min(width, this.options.maxSamples ?? width));
    const palette = new Uint8ClampedArray(sampleCount * 3);
    for (let i = 0; i < sampleCount; i += 1) {
      const [r, g, b] = this.options.colorAt(this.valueAt((i + 0.5) / sampleCount));
      palette[i * 3] = r;
      palette[i * 3 + 1] = g;
      palette[i * 3 + 2] = b;
    }

    // 列 → 標本の対応。sampleCount === width なら列と標本が 1 対 1 に戻る。
    const columnIndex = new Uint32Array(width);
    for (let x = 0; x < width; x += 1) {
      columnIndex[x] = Math.min(sampleCount - 1, Math.floor(((x + 0.5) / width) * sampleCount));
    }

    const data = image.data;
    for (let y = 0; y < height; y += 1) {
      let offset = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const base = (columnIndex[x] ?? 0) * 3;
        data[offset] = palette[base] ?? 0;
        data[offset + 1] = palette[base + 1] ?? 0;
        data[offset + 2] = palette[base + 2] ?? 0;
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
    const dpr = window.devicePixelRatio || 1;
    const halfWidth = Math.max(1, dpr);

    for (const marker of this.markers) {
      const ratio = this.positionOf(marker.value);
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;

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
