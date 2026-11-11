import enDict from "@/locales/en.json";
import zhDict from "@/locales/zh.json";

export type Locale = "en" | "zh";

const STORAGE_KEY = "veritas.locale";
const LOCALES: Locale[] = ["en", "zh"];

type Dict = Record<string, unknown>;
type Vars = Record<string, string | number>;

function flatten(obj: Dict, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Dict, key));
    } else if (typeof v === "string") {
      out[key] = v;
    } else {
      throw new Error(`Invalid translation value at ${key}`);
    }
  }
  return out;
}

function assertParity(left: Record<string, string>, right: Record<string, string>, leftName: string, rightName: string) {
  const missingRight = Object.keys(left).filter((key) => !(key in right));
  const missingLeft = Object.keys(right).filter((key) => !(key in left));
  if (missingRight.length || missingLeft.length) {
    throw new Error(
      `Locale key mismatch. Missing in ${rightName}: ${missingRight.join(", ") || "—"}; missing in ${leftName}: ${missingLeft.join(", ") || "—"}`
    );
  }
}

const tables: Record<Locale, Record<string, string>> = {
  en: flatten(enDict as Dict),
  zh: flatten(zhDict as Dict),
};

assertParity(tables.en, tables.zh, "en", "zh");

let current: Locale = "en";
const listeners = new Set<() => void>();

function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "zh";
}

function applyDocumentLang(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}

export function getLocale(): Locale {
  return current;
}

export function dateLocale(): string {
  return current === "zh" ? "zh-CN" : "en-US";
}

export function hasKey(key: string): boolean {
  return key in tables.en;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function setLocale(next: Locale) {
  if (!LOCALES.includes(next)) throw new Error(`Unknown locale: ${next}`);
  current = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  applyDocumentLang(next);
  notify();
}

export function hydrateLocale() {
  if (typeof window === "undefined") return;
  const query = new URLSearchParams(window.location.search).get("lang");
  const stored = window.localStorage.getItem(STORAGE_KEY);
  current = isLocale(query) ? query : isLocale(stored) ? stored : "en";
  if (isLocale(query)) window.localStorage.setItem(STORAGE_KEY, query);
  applyDocumentLang(current);
}

export function t(key: string, vars?: Vars): string {
  const template = tables[current][key];
  if (template == null) throw new Error(`Missing translation: ${key} (${current})`);
  return template.replace(/\{([a-zA-Z]\w*)\}/g, (_, name: string) => {
    if (!vars || vars[name] == null) throw new Error(`Missing interpolation: ${name} in ${key}`);
    return String(vars[name]);
  });
}

