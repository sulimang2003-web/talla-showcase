// Interface language: Arabic (default) or English. Interface text in the code is wrapped in T('…');
// shop names, menus and anything people typed stay as they are. Switching reloads the page.
import EN from './i18n-en.js';

const read = () => { try { return localStorage.getItem('lang') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; } };
export const LANG = read();
export const T = (s) => (LANG === 'en' && Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s);
export function setLang(l) {
  try { localStorage.setItem('lang', l === 'en' ? 'en' : 'ar'); } catch { /* storage unavailable */ }
  location.reload();
}
export const LANGS = [['ar', 'العربية'], ['en', 'English']];
// The two-bubble "e / ع" icon.
export const LANG_ICON = '<svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true"><rect x="1" y="1" width="15" height="13" rx="3.5" fill="currentColor"/><path d="M12 14l4 3v-3z" fill="currentColor"/><text x="8.5" y="11" text-anchor="middle" font-size="10" font-weight="800" font-family="Arial,sans-serif" fill="var(--lang-ic-fg,#fff)">e</text><rect x="11" y="13" width="15" height="13" rx="3.5" fill="currentColor" stroke="var(--lang-ic-fg,#fff)" stroke-width="1.6"/><path d="M15 26l-4 1.5 1-3.5z" fill="currentColor"/><text x="18.5" y="23.5" text-anchor="middle" font-size="10" font-weight="800" font-family="Arial,sans-serif" fill="var(--lang-ic-fg,#fff)">ع</text></svg>';
