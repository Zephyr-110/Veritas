"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getLocale, hydrateLocale, setLocale, subscribe, t, type Locale } from "./store";

type I18nContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: typeof t;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getLocale);

  useEffect(() => {
    hydrateLocale();
    setLocaleState(getLocale());
    return subscribe(() => setLocaleState(getLocale()));
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside LocaleProvider");
  return ctx;
}

export function useT(): typeof t {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
