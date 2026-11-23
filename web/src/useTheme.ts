// The picked theme and its words, kept up to date when the viewer picks another.

import { useEffect, useState } from "preact/hooks";
import type { Theme, ThemeId } from "./theme.ts";
import { THEMES, currentTheme, onThemeChange, themeCss } from "./theme.ts";

export function useThemeId(): ThemeId {
  const [id, setState] = useState(currentTheme());
  useEffect(() => onThemeChange(setState), []);
  return id;
}

export function useTheme(): Theme {
  return THEMES[useThemeId()];
}

/** Puts the palettes in the page and keeps the root element's `data-theme` at the picked theme. Call once, before the first render. */
export function startThemes(): void {
  const style = document.createElement("style");
  style.id = "theme-palettes";
  style.textContent = themeCss();
  document.head.appendChild(style);
  const apply = (id: ThemeId) => void (document.documentElement.dataset.theme = id);
  apply(currentTheme());
  onThemeChange(apply);
}
