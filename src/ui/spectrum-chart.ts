/**
 * 波長を横軸に取ったグラフ(共有コンポーネント)。
 *
 * もとは黒体放射ページ専用で、プランクの法則を直接呼んで 1 本の曲線を描いていた。
 * レイリー散乱ページという 2 人目の利用者が現れたので、
 * **描くものを外から曲線のデータとして受け取る**形に一般化してある。
 * 一般化したのは今回必要になったところ(複数曲線・凡例・線スペクトルの縦棒・
 * 波長範囲と縦軸の可変)だけで、それ以上は広げていない。
 */

import './spectrum-chart.css';
import { VISIBLE_LAMBDA_MAX, VISIBLE_LAMBDA_MIN, wavelengthToColor } from '../color/index.ts';

/**
 * 縦軸の取り方。
 *
 * 「自身のピークで割って 0..1 にする」のは軸ではなくデータ側の正規化なので、
 * ここには入れていない。割り算は呼び出し側が `valueAt` の中で行う。
 */
export type ChartAxis =
  | { readonly kind: 'linear'; readonly max: number; readonly ticks: readonly number[] }
  | {
      readonly kind: 'log';
      readonly floor: number;
      readonly ceil: number;
      /** 何桁ごとに数字を振るか。既定は 1 桁ごと。 */
      readonly labelEvery?: number;
    };

export interface ChartCurve {
  /** 波長 [nm] → 縦軸の値。 */
  readonly valueAt: (lambdaNm: number) => number;
  readonly color: string;
  /** 曲線の下を薄く塗るか。どの波長にどれだけ出ているかを面で見せたいとき。 */
  readonly fill?: boolean;
  readonly dashed?: boolean;
  /** 線の太さ [CSS px]。既定は 2。 */
  readonly width?: number;
}

/**
 * 縦線。
 *
 * `height` を省くと全高の破線(黒体の λmax のような「位置」の指示)、
 * 与えると下から伸びる実線の縦棒(単色光の線スペクトル)になる。
 */
export interface ChartMarker {
  readonly lambdaNm: number;
  readonly label?: string;
  readonly color?: string;
  /** 縦棒の高さ (0..1)。 */
  readonly height?: number;
}

export interface ChartLegendEntry {
  readonly label: string;
  readonly color: string;
  readonly dashed?: boolean;
}

export interface SpectrumChartOptions {
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly xTicks: readonly number[];
}

export interface SpectrumChartState {
  readonly axis: ChartAxis;
  readonly axisTitle: string;
  readonly curves: readonly ChartCurve[];
  readonly markers?: readonly ChartMarker[];
  /** 曲線が 2 本以上あるときに渡す。図の上の余白へ横 1 行で描く。 */
  readonly legend?: readonly ChartLegendEntry[];
}

/** 目盛りとラベルのための余白 [CSS px]。凡例があるときだけ上を広げる。 */
const PADDING = { top: 16, topWithLegend: 28, right: 30, bottom: 26, left: 54 } as const;

const DEFAULT_STATE: SpectrumChartState = {
  axis: { kind: 'linear', max: 1, ticks: [0, 0.5, 1] },
  axisTitle: '',
  curves: [],
};

export class SpectrumChart {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: SpectrumChartOptions;
  private readonly resizeObserver: ResizeObserver;

  private state: SpectrumChartState = DEFAULT_STATE;

  constructor(options: SpectrumChartOptions) {
    this.options = options;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-chart__canvas';
    // 数値は結果パネルと図の注記で読めるので、支援技術には図そのものを見せない。
    this.canvas.setAttribute('aria-hidden', 'true');

    const context = this.canvas.getContext('2d');
    if (context === null) {
      throw new Error('2D コンテキストを取得できませんでした');
    }
    this.context = context;

    this.element = document.createElement('div');
    this.element.className = 'spectrum-chart';
    this.element.append(this.canvas);

    this.resizeObserver = new ResizeObserver(() => {
      this.refresh();
    });
    this.resizeObserver.observe(this.canvas);
  }

  setState(state: SpectrumChartState): void {
    this.state = state;
    this.refresh();
  }

  /**
   * 描き直す。DOM に挿入した直後は呼び出し側から明示的に呼ぶこと
   * (ResizeObserver の初回通知はフレームが生成されるまで届かない)。
   */
  refresh(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    const ctx = this.context;
    // 以降は CSS ピクセルで考える。GradientBar と違い文字を描くので、
    // ImageData ではなく変換行列を使うほうが素直。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const top = this.state.legend === undefined ? PADDING.top : PADDING.topWithLegend;
    const plot = {
      left: PADDING.left,
      top,
      width: width - PADDING.left - PADDING.right,
      height: height - top - PADDING.bottom,
    };
    if (plot.width <= 0 || plot.height <= 0) return;

    const style = getComputedStyle(document.documentElement);
    const dim = style.getPropertyValue('--text-dim').trim() || '#9aa1ae';
    const border = style.getPropertyValue('--border').trim() || '#2d323d';

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    this.drawVisibleBand(plot);
    this.drawGrid(plot, dim, border);
    for (const curve of this.state.curves) this.drawCurve(plot, curve);
    for (const marker of this.state.markers ?? []) this.drawMarker(plot, marker, dim);
    if (this.state.legend !== undefined) this.drawLegend(plot, this.state.legend, dim);

    // 枠は最後に描いて、曲線のはみ出しを縁で締める。
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.width - 1, plot.height - 1);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
  }

  // --- 座標変換 ---

  private xOf(plot: Plot, lambdaNm: number): number {
    const { lambdaMin, lambdaMax } = this.options;
    return plot.left + ((lambdaNm - lambdaMin) / (lambdaMax - lambdaMin)) * plot.width;
  }

  /** 縦軸の値 → 縦位置 (0..1、下が 0)。表示範囲の外なら null。 */
  private heightOf(value: number): number | null {
    const { axis } = this.state;
    if (!Number.isFinite(value)) return null;

    if (axis.kind === 'log') {
      if (!(value > 0)) return null;
      const floor = Math.log10(axis.floor);
      const ratio = (Math.log10(value) - floor) / (Math.log10(axis.ceil) - floor);
      return ratio < 0 ? null : Math.min(1, ratio);
    }
    if (!(axis.max > 0)) return null;
    return Math.min(1, Math.max(0, value / axis.max));
  }

  // --- 描画 ---

  /** 可視域を、その波長のスペクトル色で塗る。色は他ページの帯と同じ経路で求める。 */
  private drawVisibleBand(plot: Plot): void {
    const ctx = this.context;
    const left = this.xOf(plot, VISIBLE_LAMBDA_MIN);
    const right = this.xOf(plot, VISIBLE_LAMBDA_MAX);

    const gradient = ctx.createLinearGradient(left, 0, right, 0);
    for (let lambdaNm = VISIBLE_LAMBDA_MIN; lambdaNm <= VISIBLE_LAMBDA_MAX; lambdaNm += 5) {
      const stop = (lambdaNm - VISIBLE_LAMBDA_MIN) / (VISIBLE_LAMBDA_MAX - VISIBLE_LAMBDA_MIN);
      gradient.addColorStop(stop, wavelengthToColor(lambdaNm, 'max').hex);
    }

    ctx.save();
    // 曲線と目盛りを覆い隠さない濃さに留める。ここは背景であって主役ではない。
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = gradient;
    ctx.fillRect(left, plot.top, right - left, plot.height);
    ctx.restore();

    this.drawLabel('可視域', (left + right) / 2, plot.top + 9, 'center');
  }

  /**
   * 図の中に置く文字。下に敷き板を入れる。
   *
   * 曲線もスペクトル帯も明るいので、白抜きのままだと重なった位置で読めなくなる
   * (λmax のラベルは温度によってはピークの真上に来る)。
   */
  private drawLabel(text: string, x: number, y: number, align: CanvasTextAlign): void {
    const ctx = this.context;
    const width = ctx.measureText(text).width;
    const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;

    ctx.save();
    ctx.fillStyle = 'rgb(16 18 22 / 78%)';
    ctx.fillRect(left - 4, y - 8, width + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawGrid(plot: Plot, dim: string, border: string): void {
    const ctx = this.context;
    const bottom = plot.top + plot.height;
    const { xTicks } = this.options;

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = dim;

    for (const lambdaNm of xTicks) {
      const x = Math.round(this.xOf(plot, lambdaNm)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      // 単位は最後の目盛りにだけ添える。軸のタイトルを別に置くと目盛りと重なる。
      const last = lambdaNm === xTicks.at(-1);
      ctx.textAlign = last ? 'right' : 'center';
      ctx.fillText(last ? `${lambdaNm} nm` : String(lambdaNm), last ? x + 24 : x, bottom + 13);
    }

    ctx.textAlign = 'right';
    const { axis } = this.state;
    if (axis.kind === 'log') {
      const floor = Math.log10(axis.floor);
      const decades = Math.log10(axis.ceil) - floor;
      const labelEvery = axis.labelEvery ?? 1;
      for (let e = floor; e <= Math.log10(axis.ceil); e += 1) {
        const y = Math.round(bottom - ((e - floor) / decades) * plot.height) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.left + plot.width, y);
        ctx.stroke();
        // 全部の桁に数字を振ると潰れるので、必要なら間引く。
        if (e % labelEvery === 0) ctx.fillText(`1e${e}`, plot.left - 6, y);
      }
    } else {
      for (const value of axis.ticks) {
        const y = Math.round(bottom - (value / axis.max) * plot.height) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.left + plot.width, y);
        ctx.stroke();
        ctx.fillText(value.toFixed(2), plot.left - 6, y);
      }
    }

    ctx.save();
    ctx.translate(11, plot.top + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(this.state.axisTitle, 0, 0);
    ctx.restore();
  }

  private drawCurve(plot: Plot, curve: ChartCurve): void {
    const ctx = this.context;
    const bottom = plot.top + plot.height;
    const { lambdaMin, lambdaMax } = this.options;

    // 縦位置が範囲外に出る区間は線を切る(対数目盛で床を割ったとき)。
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];

    for (let px = 0; px <= plot.width; px += 1) {
      const lambdaNm = lambdaMin + (px / plot.width) * (lambdaMax - lambdaMin);
      const height = this.heightOf(curve.valueAt(lambdaNm));
      if (height === null) {
        if (current.length > 1) segments.push(current);
        current = [];
        continue;
      }
      current.push([plot.left + px, bottom - height * plot.height]);
    }
    if (current.length > 1) segments.push(current);

    for (const points of segments) {
      const path = new Path2D();
      path.moveTo(points[0]![0], points[0]![1]);
      for (const [x, y] of points.slice(1)) path.lineTo(x, y);

      ctx.save();
      ctx.strokeStyle = curve.color;
      ctx.lineWidth = curve.width ?? 2;
      ctx.lineJoin = 'round';
      if (curve.dashed === true) ctx.setLineDash([5, 4]);
      ctx.stroke(path);
      ctx.setLineDash([]);

      // 面で見せたほうが「どの波長にどれだけ出ているか」が掴みやすい。
      if (curve.fill === true) {
        const fill = new Path2D(path);
        fill.lineTo(points.at(-1)![0], bottom);
        fill.lineTo(points[0]![0], bottom);
        fill.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = curve.color;
        ctx.fill(fill);
      }
      ctx.restore();
    }
  }

  /** 縦線。位置だけを示す破線と、高さを持つ実線の縦棒の 2 通り。 */
  private drawMarker(plot: Plot, marker: ChartMarker, dim: string): void {
    const { lambdaMin, lambdaMax } = this.options;
    if (marker.lambdaNm < lambdaMin || marker.lambdaNm > lambdaMax) return;

    const ctx = this.context;
    const x = this.xOf(plot, marker.lambdaNm);
    const bottom = plot.top + plot.height;

    ctx.save();
    if (marker.height === undefined) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = marker.color ?? dim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    } else {
      const height = Math.min(1, Math.max(0, marker.height)) * plot.height;
      ctx.strokeStyle = marker.color ?? dim;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, bottom);
      ctx.lineTo(x, bottom - height);
      ctx.stroke();
    }
    ctx.restore();

    if (marker.label === undefined) return;
    const width = ctx.measureText(marker.label).width;
    // 右端に寄ったときはラベルを内側へ折り返す。
    const flip = x + width + 12 > plot.left + plot.width;
    this.drawLabel(marker.label, flip ? x - 6 : x + 6, plot.top + 28, flip ? 'right' : 'left');
  }

  /**
   * 凡例。図の上の余白に横 1 行で描く。
   *
   * 枠の中に置くと、曲線の走り方によって必ずどこかで重なる — AM や温度を動かすと
   * 曲線は上端から下端まで移動するので、空いている隅というものが存在しない。
   */
  private drawLegend(plot: Plot, entries: readonly ChartLegendEntry[], dim: string): void {
    const ctx = this.context;
    const y = plot.top - 12;
    const sample = 14;

    ctx.save();
    ctx.textAlign = 'left';
    let x = plot.left;
    for (const entry of entries) {
      ctx.strokeStyle = entry.color;
      ctx.lineWidth = 2;
      if (entry.dashed === true) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + sample, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = dim;
      ctx.fillText(entry.label, x + sample + 5, y);
      x += sample + 5 + ctx.measureText(entry.label).width + 14;
    }
    ctx.restore();
  }
}

interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
