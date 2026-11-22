export type VisualTheme = 'default' | 'ivory';

export const THEME_STORAGE_KEY = 'lodgeMusicTheme';

export function normalizeTheme(value: string | null | undefined): VisualTheme {
  return value === 'ivory' ? 'ivory' : 'default';
}

export function getStoredTheme(): VisualTheme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

export function syncThemeSwitcherButtons(theme: VisualTheme): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-theme-value]');
  buttons.forEach((btn) => {
    const isMatch = btn.dataset.themeValue === theme;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
  });
}

export function applyVisualTheme(theme: VisualTheme, persist = true): void {
  const resolved = normalizeTheme(theme);
  if (resolved === 'ivory') {
    document.documentElement.setAttribute('data-theme', 'ivory');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolved);
    } catch {
      // ignore storage failures
    }
  }

  syncThemeSwitcherButtons(resolved);
}

export function initThemeSwitcher(): void {
  const initial = getStoredTheme();
  applyVisualTheme(initial, false);

  document.querySelectorAll<HTMLButtonElement>('[data-theme-value]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = normalizeTheme(btn.dataset.themeValue);
      applyVisualTheme(target, true);
    });
  });

  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) {
      applyVisualTheme(normalizeTheme(e.newValue), false);
    }
  });
}
