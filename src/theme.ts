export type VisualTheme = 'metal' | 'default' | 'forest';

export const THEME_STORAGE_KEY = 'lodgeMusicTheme';

const THEME_META_COLORS: Record<VisualTheme, string> = {
  metal: '#0b0e14',
  default: '#0f141c',
  forest: '#0c140e'
};

export function normalizeTheme(value: string | null | undefined): VisualTheme {
  if (value === 'default') return 'default';
  if (value === 'forest' || value === 'pastel') return 'forest';
  return 'metal';
}

export function getStoredTheme(): VisualTheme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'metal';
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
  if (resolved === 'metal') {
    document.documentElement.setAttribute('data-theme', 'metal');
  } else if (resolved === 'forest') {
    document.documentElement.setAttribute('data-theme', 'forest');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  const metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.content = THEME_META_COLORS[resolved];
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
