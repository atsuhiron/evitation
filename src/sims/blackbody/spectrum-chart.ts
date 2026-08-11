/**
 * 黒体放射のスペクトル曲線。
 *
 * src/ui/ には置いていない。可視域の色付き帯や λmax の注記など黒体に固有の要素を
 * 含むので、汎用のグラフ部品にするのは 2 人目の利用者が現れてからでよい
 * — スペクトル帯を単色光ページ専用に作り、合成ページが要るようになってから
 * src/ui/ へ昇格させたのと同じ判断。
 */

import './spectrum-chart.css';
import { VISIBLE_LAMBDA_MAX, VISIBLE_LAMBDA_MIN, wavelengthToColor } from '../../color/index.ts';
import { peakWavelengthNm, spectralRadiance } from './planck.ts';

/**
 * 縦軸の取り方。
 *
 * - `peak`: 各温度の曲線を自身のピークで正規化する。形だけを見るので、
 *   ウィーンの変位則(ピークが可視域を横切っていく)に集中できる
 * - `log`: 絶対値の対数目盛。曲線が交差せず高温が常に上に来るので、
 *   シュテファン・ボルツマン則(T⁴ で全体が持ち上がる)が同時に見える
 */
export type ChartScale = 'peak' | 'log';

export interface SpectrumChartState {
  readonly temperatureK: number;
  readonly scale: ChartScale;
  /** 曲線の色。その温度の黒体色を渡す。暗い背景の上でも常に見え、色との対応がつく。 */
  readonly curveColor: string;
}

/**
 * 描画する波長範囲 [nm]。
 *
 * 扱う温度 1000–20000K の λmax は 145–2898nm なので、ピークが窓の端から端まで
 * 掃引される。可視域だけを描くとピークが見えない温度がほとんどになってしまう。
 */
const LAMBDA_MIN_NM = 100;
const LAMBDA_MAX_NM = 3000;

/**
 * 対数目盛の範囲 [W·sr⁻¹·m⁻²·nm⁻¹]。
 *
 * 上端は 20000K のピーク (1.3e7) が収まる高さ、下端は 1000K でも可視域の赤側が
 * 見えている高さに取った。1000K の青側はこの床を大きく割るので描かれないが、
 * 「その温度では青い光が出ていない」という事実そのものなので、それでよい。
 */
const LOG_FLOOR = 1e-4;
const LOG_CEIL = 1e8;

/** 目盛りとラベルのための余白 [CSS px]。 */
const PADDING = { top: 16, right: 30, bottom: 26, left: 54 } as const;

const X_TICKS = [500, 1000, 1500, 2000, 2500, 3000];
const PEAK_TICKS = [0, 0.25, 0.5, 0.75, 1];

export class SpectrumChart {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;

  private state: SpectrumChartState = {
    temperatureK: 5778,
    scale: 'peak',
    curveColor: '#ffffff',
  };

  constructor() {
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

    const plot = {
      left: PADDING.left,
      top: PADDING.top,
      width: width - PADDING.left - PADDING.right,
      height: height - PADDING.top - PADDING.bottom,
    };
    if (plot.width <= 0 || plot.height <= 0) return;

    const style = getComputedStyle(document.documentElement);
    const dim = style.getPropertyValue('--text-dim').trim() || '#9aa1ae';
    const border = style.getPropertyValue('--border').trim() || '#2d323d';

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    this.drawVisibleBand(plot);
    this.drawGrid(plot, dim, border);
    this.drawCurve(plot);
    this.drawPeakMarker(plot, dim);

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
    return plot.left + ((lambdaNm - LAMBDA_MIN_NM) / (LAMBDA_MAX_NM - LAMBDA_MIN_NM)) * plot.width;
  }

  /**
   * 分光放射輝度 → 縦位置 (0..1、下が 0)。表示範囲の外なら null。
   *
   * @param peak ピーク正規化に使う分光放射輝度。列ごとに求め直さずに済むよう外から渡す。
   */
  private heightOf(value: number, peak: number): number | null {
    if (this.state.scale === 'log') {
      if (!(value > 0)) return null;
      const ratio =
        (Math.log10(value) - Math.log10(LOG_FLOOR)) / (Math.log10(LOG_CEIL) - Math.log10(LOG_FLOOR));
      return ratio < 0 ? null : Math.min(1, ratio);
    }
    return peak > 0 ? Math.min(1, value / peak) : null;
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

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = dim;

    for (const lambdaNm of X_TICKS) {
      const x = Math.round(this.xOf(plot, lambdaNm)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      // 単位は最後の目盛りにだけ添える。軸のタイトルを別に置くと目盛りと重なる。
      const last = lambdaNm === X_TICKS.at(-1);
      ctx.textAlign = last ? 'right' : 'center';
      ctx.fillText(last ? `${lambdaNm} nm` : String(lambdaNm), last ? x + 24 : x, bottom + 13);
    }

    ctx.textAlign = 'right';
    if (this.state.scale === 'log') {
      const decades = Math.log10(LOG_CEIL) - Math.log10(LOG_FLOOR);
      for (let e = Math.log10(LOG_FLOOR); e <= Math.log10(LOG_CEIL); e += 1) {
        const y = Math.round(bottom - ((e - Math.log10(LOG_FLOOR)) / decades) * plot.height) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.left + plot.width, y);
        ctx.stroke();
        // 全部の桁に数字を振ると潰れるので 1 つおきにする。
        if (e % 2 === 0) ctx.fillText(`1e${e}`, plot.left - 6, y);
      }
      ctx.save();
      ctx.translate(11, plot.top + plot.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText('分光放射輝度 [W·sr⁻¹·m⁻²·nm⁻¹]', 0, 0);
      ctx.restore();
      return;
    }

    for (const value of PEAK_TICKS) {
      const y = Math.round(bottom - value * plot.height) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.left + plot.width, y);
      ctx.stroke();
      ctx.fillText(value.toFixed(2), plot.left - 6, y);
    }
    ctx.save();
    ctx.translate(11, plot.top + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('ピークを 1 とした比', 0, 0);
    ctx.restore();
  }

  private drawCurve(plot: Plot): void {
    const ctx = this.context;
    const bottom = plot.top + plot.height;
    const { temperatureK } = this.state;
    const peak = spectralRadiance(peakWavelengthNm(temperatureK), temperatureK);

    // 縦位置が範囲外に出る区間は線を切る(対数目盛で床を割ったとき)。
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];

    for (let px = 0; px <= plot.width; px += 1) {
      const lambdaNm = LAMBDA_MIN_NM + (px / plot.width) * (LAMBDA_MAX_NM - LAMBDA_MIN_NM);
      const height = this.heightOf(spectralRadiance(lambdaNm, temperatureK), peak);
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
      ctx.strokeStyle = this.state.curveColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke(path);

      // 面で見せたほうが「どの波長にどれだけ出ているか」が掴みやすい。
      const fill = new Path2D(path);
      fill.lineTo(points.at(-1)![0], bottom);
      fill.lineTo(points[0]![0], bottom);
      fill.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = this.state.curveColor;
      ctx.fill(fill);
      ctx.restore();
    }
  }

  /** ウィーンの変位則の位置を破線で示す。温度を動かすとここが左右に走る。 */
  private drawPeakMarker(plot: Plot, dim: string): void {
    const lambdaNm = peakWavelengthNm(this.state.temperatureK);
    if (lambdaNm < LAMBDA_MIN_NM || lambdaNm > LAMBDA_MAX_NM) return;

    const ctx = this.context;
    const x = this.xOf(plot, lambdaNm);
    const bottom = plot.top + plot.height;

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();

    const label = `λmax ${lambdaNm.toFixed(0)} nm`;
    const width = ctx.measureText(label).width;
    // 右端に寄ったときはラベルを内側へ折り返す。
    const flip = x + width + 12 > plot.left + plot.width;
    this.drawLabel(label, flip ? x - 6 : x + 6, plot.top + 28, flip ? 'right' : 'left');
  }
}

interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
