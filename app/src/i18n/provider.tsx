"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getLocale, hydrateLocale, setLocale, subscribe, t, type Locale, type Vars } from "./store";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type I18nContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, vars?: Vars) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useIsomorphicLayoutEffect(() => {
    hydrateLocale();
    setLocaleState(getLocale());
    return subscribe(() => setLocaleState(getLocale()));
  }, []);

  const tLocale = useCallback((key: string, vars?: Vars) => t(key, vars, locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: tLocale }),
    [locale, tLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside LocaleProvider");
  return ctx;
}

export function useT(): (key: string, vars?: Vars) => string {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
