import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // tsconfig 里 jsx 是 "preserve"（Next.js 需要），这里显式开启自动运行时。
  // Vite 7 默认用 oxc 做转换，esbuild 的 jsx 选项会被忽略。
  oxc: { jsx: { runtime: "automatic" } } as never,
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist", ".next"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      // 覆盖率防回退闸门：取当前实测值向下取整约 1-2 个点，
      // 低于该线说明新增代码没带测试或删了用例。
      thresholds: {
        statements: 52,
        branches: 55,
        functions: 54,
        lines: 53,
      },
      // 只统计业务源码，排除测试本身、类型声明、自动生成的 IDL
      include: ["src/lib/**", "src/i18n/**", "src/components/**", "src/hooks/**"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/idl/**",
        "src/lib/program.ts",
        "src/lib/send.ts",
        "src/components/providers.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
