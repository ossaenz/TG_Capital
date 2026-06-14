'use strict';

// ════════════════════════════════════════════════════════
// THEME — dark / light mode (persisted to localStorage)
// ════════════════════════════════════════════════════════
const THEME_KEY = 'tgcapital_theme';

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}

function applyTheme(theme) {
  // theme: 'dark' | 'light' | null (null = follow system preference)
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  updateThemeToggleLabel();
}

function effectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeToggleLabel() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = effectiveTheme() === 'dark';
  const ico = btn.querySelector('.theme-ico');
  const lbl = btn.querySelector('.theme-label');
  if (ico) ico.textContent = isDark ? '☀' : '☾'; // sun when dark, moon when light
  if (lbl) lbl.textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  applyTheme(next);
}

// Apply persisted theme immediately (before paint where possible).
// Default to dark when no preference has been saved.
applyTheme(getStoredTheme() ?? 'dark');

// Keep label in sync once DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateThemeToggleLabel);
} else {
  updateThemeToggleLabel();
}
