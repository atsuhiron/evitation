import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相対パスで出力しておくと、GitHub Pages のようなサブパス配信でもそのまま動く。
  base: './',
  test: {
    // 色計算は純粋な数値コードなので DOM は要らない。
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
