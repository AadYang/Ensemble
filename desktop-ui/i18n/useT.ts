"use client";

import { useCallback } from "react";
import { useStore } from "@/store/agents";
import { DICTS, interpolate, type Locale } from "./dict";

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export function useT(): TranslateFn {
  const locale = useStore((s) => s.locale);
  return useCallback<TranslateFn>(
    (key, params) => {
      const dict = DICTS[locale] ?? DICTS.en;
      const template = dict[key] ?? DICTS.en[key] ?? key;
      return interpolate(template, params);
    },
    [locale],
  );
}

export const SUPPORTED_LOCALES: Locale[] = ["en", "zh"];
