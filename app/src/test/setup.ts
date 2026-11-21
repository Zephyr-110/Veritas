import "@testing-library/jest-dom/vitest";
import { Buffer } from "buffer";

// 全局 Buffer：lib 层直接用 Buffer 做二进制解码
if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

// jsdom 不暴露 crypto.getRandomValues，补一个（format.randomMarketId 依赖）
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, "crypto", {
    value: require("node:crypto").webcrypto,
    configurable: true,
  });
}
