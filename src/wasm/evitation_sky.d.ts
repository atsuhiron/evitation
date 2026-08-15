/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript から見える唯一のハンドル。
 *
 * **これがクレート唯一の `#[wasm_bindgen] pub struct`。**ほかは `f64` と
 * `Vec<f64>` でしか渡さないので、手動で解放が要るものがこの 1 つに閉じる。
 * 呼ぶ側は描画のたびに作り直すので、**作り直す前に必ず `free()` すること**。
 *
 * 返り値の `Vec<f64>` は wasm-bindgen が JavaScript 側の `Float64Array` へ
 * コピーする。線形メモリへのビューを渡さないのは、アロケータがメモリを
 * 伸ばした瞬間にビューが detach されるため。
 */
export class SkyModel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 天頂で、輝度 Y のうち多重散乱が占める割合 (0..1)。
     */
    multipleScatteringShare(): number;
    constructor(sun_altitude_deg: number, temperature_k: number, multiple_scattering: boolean, aerosol_optical_depth: number);
    /**
     * 380–780nm を 1nm 刻みで並べた 401 点の分光放射輝度。
     */
    spectrumTable(angle_deg: number): Float64Array;
    /**
     * 単発の三刺激値(長さ 3)。
     */
    xyzAt(angle_deg: number): Float64Array;
    /**
     * 角度の配列 → 3N の三刺激値。帯の全方向をこれ 1 回で解く。
     */
    xyzMany(angles: Float64Array): Float64Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_skymodel_free: (a: number, b: number) => void;
    readonly skymodel_multipleScatteringShare: (a: number) => number;
    readonly skymodel_new: (a: number, b: number, c: number, d: number) => number;
    readonly skymodel_spectrumTable: (a: number, b: number, c: number) => void;
    readonly skymodel_xyzAt: (a: number, b: number, c: number) => void;
    readonly skymodel_xyzMany: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
