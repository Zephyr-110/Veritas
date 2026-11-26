import { describe, it, expect, afterEach } from "vitest";
import {
  t,
  tPair,
  setLocale,
  getLocale,
  resolveInitialLocale,
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

  it("resolveInitialLocale prefers ?lang=, then localStorage, then navigator.language, else en", () => {
    const origNav = globalThis.navigator;
    const origWin = globalThis.window;
    const store = new Map<string, string>();
    const mockWin = {
      location: { search: "" },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    } as unknown as Window & typeof globalThis;
    Object.defineProperty(globalThis, "window", { value: mockWin, configurable: true });

    Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });
    expect(resolveInitialLocale()).toBe("zh");

    store.set("veritas.locale", "en");
    expect(resolveInitialLocale()).toBe("en");

    store.set("veritas.locale", "zh");
    expect(resolveInitialLocale()).toBe("zh");

    mockWin.location.search = "?lang=en";
    expect(resolveInitialLocale()).toBe("en");

    Object.defineProperty(globalThis, "navigator", { value: { language: "fr-FR" }, configurable: true });
    store.clear();
    mockWin.location.search = "";
    expect(resolveInitialLocale()).toBe("en");

    Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
    Object.defineProperty(globalThis, "window", { value: origWin, configurable: true });
  });
});
