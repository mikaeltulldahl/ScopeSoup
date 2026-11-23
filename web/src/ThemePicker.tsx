// The theme picker on the Settings page. The choice is this viewer's own and stays in this browser.

import { THEMES, THEME_IDS, setTheme } from "./theme.ts";
import { useThemeId } from "./useTheme.ts";

export function ThemePicker() {
  const picked = useThemeId();
  return (
    <fieldset class="panel theme-picker">
      <legend><b>Theme</b>: the words and look of the board, for you only (kept in this browser)</legend>
      {THEME_IDS.map((id) => (
        <label key={id} class="theme-choice">
          <input type="radio" name="theme" value={id} checked={picked === id} onChange={() => setTheme(id)} />
          <span><b>{THEMES[id].words.name}</b> <span class="muted">{THEMES[id].words.about}</span></span>
        </label>
      ))}
    </fieldset>
  );
}
