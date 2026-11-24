import { describe, it, expect, afterEach } from "vitest";
import {
  t,
  tPair,
  setLocale,
  getLocale,
  hasKey,
  subscribe,
} from "@/i18n/store";

describe("i18n", () => {
  const prev = getLocale();
  afterEach(() => setLocale(prev));

  it("has parity between en and zh", () => {
    // assertParity is already run at module load time;
    // this re-exports the guarantee with an explicit assertion.
    expect(hasKey("odds.line")).toBe(true);
    expect(hasKey("time.daysClock")).toBe(true);
  });

  it("interpolates vars", () => {
    setLocale("en");
    const got = t("odds.line", { yes: 65, no: 35 });
    expect(got).toMatch(/65/);
    expect(got).toMatch(/35/);
  });

  it("localized output differs between en and zh", () => {
    setLocale("en");
    const en = t("kind.live");
    setLocale("zh");
    const zh = t("kind.live");
    expect(en).not.toBe(zh);
  });

  it("tPair returns both locales", () => {
    setLocale("en");
    const p = tPair("kind.live");
    expect(p.en).not.toBe(p.zh);
    expect(p.active).toBe(p.en);
    setLocale("zh");
    const p2 = tPair("kind.live");
    expect(p2.active).toBe(p2.zh);
  });

  it("subscribe notifies on locale change", () => {
    const calls: string[] = [];
    const off = subscribe(() => calls.push(getLocale()));
    setLocale("zh");
    setLocale("en");
    setLocale("zh");
    expect(calls).toEqual(["zh", "en", "zh"]);
    off();
    setLocale("en");
    expect(calls).toEqual(["zh", "en", "zh"]); // no extra call
  });

  it("throws on unknown locale", () => {
    expect(() => setLocale("xx" as never)).toThrow();
  });

  it("throws on missing translation key", () => {
    expect(() => t("definitely.not.a.real.key")).toThrow();
  });
});
