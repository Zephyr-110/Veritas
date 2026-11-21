import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// 与被测模块使用同一个 buffer 实现，避免 jsdom 下原生 Buffer
// 与 polyfill 混用导致 .equals 抛 "Argument must be a Buffer"
import { Buffer as Buf } from "buffer";
import {
  parseOcr2State,
  parseOcr2Transmit,
  areReportsAdjacent,
  decodeChainlinkFeed,
} from "@/lib/chainlink";
import { FEEDS } from "@/lib/feeds";

/**
 * 金标准测试：直接用后端 contracts 测试抓下来的真实链上字节，
 * 而不是手工构造 buffer。这样能发现"前后端对同一账户布局理解不一致"的问题。
 *
 * 数据来自 programs/prediction_market/tests/fixtures/（只读，不修改）。
 */
const FIXTURES = path.resolve(
  process.cwd(),
  "../programs/prediction_market/tests/fixtures"
);

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

type ManifestRow = {
  file: string;
  epoch: number;
  round: number;
  ts: number;
  median: number;
  nsig: number;
  nbytes: number;
};

const manifest: ManifestRow[] = JSON.parse(
  readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")
);

describe("parseOcr2Transmit（真实 transmit 指令字节）", () => {
  it("manifest 里的每一条 report 都能被解出正确的 epoch/round/时间戳/中位数", () => {
    expect(manifest.length).toBeGreaterThan(0);
    for (const row of manifest) {
      const raw = fixture(row.file);
      expect(raw.length, `${row.file} 长度`).toBe(row.nbytes);

      const parsed = parseOcr2Transmit(raw);
      expect(parsed, `${row.file} 应能解析`).not.toBeNull();
      expect(parsed!.epoch, `${row.file} epoch`).toBe(row.epoch);
      expect(parsed!.round, `${row.file} round`).toBe(row.round);
      expect(parsed!.observationsTimestamp, `${row.file} 时间戳`).toBe(row.ts);
      expect(Number(parsed!.median), `${row.file} median`).toBe(row.median);
      // 签名数 = f + 1；observerCount 是参与观察的预言机数，必须严格大于 f
      const f = row.nsig - 1;
      expect(parsed!.observerCount, `${row.file} observerCount 必须 > f`).toBeGreaterThan(f);
    }
  });

  it("expectedF 与签名数不符时应拒绝（防止接受无效报告）", () => {
    const raw = fixture(manifest[0].file);
    // 真实数据是 2 个签名（f=1），用 f=2 必须被拒绝
    expect(parseOcr2Transmit(raw, undefined, 2)).toBeNull();
    expect(parseOcr2Transmit(raw, undefined, 1)).not.toBeNull();
  });

  it("configDigest 不匹配时应拒绝", () => {
    const raw = fixture(manifest[0].file);
    const wrong = Buf.alloc(32, 0x01);
    expect(parseOcr2Transmit(raw, wrong, 1)).toBeNull();
  });

  it("长度非法（截断 / 非 65 的整数倍）时返回 null", () => {
    const raw = fixture(manifest[0].file);
    expect(parseOcr2Transmit(raw.subarray(0, 100))).toBeNull();
    expect(parseOcr2Transmit(Buffer.concat([raw, Buffer.alloc(1)]))).toBeNull();
  });
});

describe("parseOcr2State（真实 OCR2 state 账户）", () => {
  const states = ["btc_state.bin", "eth_state.bin"];

  it("能解出 f / round / epoch / digest / rMax，且取值范围合法", () => {
    for (const file of states) {
      const data = fixture(file);
      const state = parseOcr2State(data);
      expect(state.f, `${file} f`).toBeGreaterThanOrEqual(0);
      expect(state.round, `${file} round`).toBeGreaterThanOrEqual(1);
      expect(state.epoch, `${file} epoch`).toBeGreaterThan(0);
      expect(state.latestConfigDigest.length, `${file} digest 长度`).toBe(32);
      expect(state.rMax, `${file} rMax`).toBeGreaterThanOrEqual(1);
      expect(state.rMax, `${file} rMax`).toBeLessThanOrEqual(255);
    }
  });

  it("BTC state 与全部真实 BTC 报告属于同一个 config", () => {
    // findStraddlingReports 的隐含前提：若 digest 对不上，报告会被全部过滤，
    // 市场永远无法裁决。
    const stateRaw = fixture("btc_state.bin");
    const state = parseOcr2State(stateRaw);

    // 布局锚点：digest 必须真的位于 offset 320（防止字段偏移被改坏）
    expect(stateRaw.indexOf(state.latestConfigDigest)).toBe(320);
    // f=1 与 fixture 中 2 个签名（f+1）自洽
    expect(state.f).toBe(1);

    const reports = manifest.map((row) => parseOcr2Transmit(fixture(row.file))!);
    expect(reports.length).toBe(14);
    expect(reports.every((r) => r.configDigest.equals(state.latestConfigDigest))).toBe(true);
    // fixture 覆盖到 round 6，rMax 不能小于 6
    expect(state.rMax).toBeGreaterThanOrEqual(6);
  });

  it("不同 feed 的 configDigest 必须不同（防止解析读到错误字段）", () => {
    const btc = parseOcr2State(fixture("btc_state.bin"));
    const eth = parseOcr2State(fixture("eth_state.bin"));
    expect(btc.latestConfigDigest.equals(eth.latestConfigDigest)).toBe(false);
    expect(eth.latestConfigDigest.length).toBe(32);
  });
});

describe("areReportsAdjacent（真实相邻报告）", () => {
  const epoch = 7190799;
  const rows = manifest
    .filter((r) => r.epoch === epoch)
    .sort((a, b) => a.round - b.round);

  it("同 epoch 内连续 round 判定为相邻", () => {
    for (let i = 0; i < rows.length - 1; i += 1) {
      const pre = rows[i];
      const post = rows[i + 1];
      if (post.round === pre.round + 1) {
        expect(areReportsAdjacent(pre, post, 6), `r${pre.round}→r${post.round}`).toBe(true);
      }
    }
  });

  it("跳过 round 不算相邻（否则会用错误的区间取价）", () => {
    expect(areReportsAdjacent({ epoch, round: 1 }, { epoch, round: 3 }, 6)).toBe(false);
    expect(areReportsAdjacent({ epoch, round: 2 }, { epoch, round: 4 }, 6)).toBe(false);
  });

  it("rMax 处跨 epoch 回卷算相邻", () => {
    expect(areReportsAdjacent({ epoch, round: 6 }, { epoch: epoch + 1, round: 1 }, 6)).toBe(true);
    expect(areReportsAdjacent({ epoch, round: 5 }, { epoch: epoch + 1, round: 1 }, 6)).toBe(false);
  });

  it("真实 fixture 中 7190799_r6 → 7190800_r1 也是相邻", () => {
    const last = rows[rows.length - 1];
    expect(last.round).toBe(6);
    const next = manifest.find((r) => r.epoch === epoch + 1 && r.round === 1);
    expect(next).toBeDefined();
    expect(areReportsAdjacent(last, next!, 6)).toBe(true);
  });
});

describe("decodeChainlinkFeed（真实 feed 账户）", () => {
  it("能解出 8 位小数、正价格与有效的 publishTime", () => {
    const print = decodeChainlinkFeed(fixture("btc_feed.bin"));
    expect(print).not.toBeNull();
    expect(print!.decimals).toBe(8);
    expect(print!.publishTime).toBeGreaterThan(1_600_000_000);
    expect(print!.price).toBeGreaterThan(0);
    expect(Number.isFinite(print!.price)).toBe(true);
  });

  it("短于最小长度的数据返回 null（而不是抛错）", () => {
    expect(decodeChainlinkFeed(Buffer.alloc(10))).toBeNull();
  });

  it("FEEDS 白名单里的 decimals 与真实账户一致", () => {
    const print = decodeChainlinkFeed(fixture("btc_feed.bin"));
    const preset = FEEDS.find((f) => f.key === "btc")!;
    expect(print!.decimals).toBe(preset.decimals);
  });
});
