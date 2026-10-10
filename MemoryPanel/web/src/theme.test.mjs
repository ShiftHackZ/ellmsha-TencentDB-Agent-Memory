import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMemoryTheme,
  buildThemeTokens,
  resolveMemoryTheme,
  startMemoryThemeBridge,
} from './theme.ts';

const isHex = (value) => /^#[0-9a-f]{3,8}$/i.test(value);

test('maps a live Aion palette onto Tea surfaces, forms and errors', () => {
  const theme = resolveMemoryTheme(
    {
      appearance: 'dark',
      palette: {
        background: '#07090c',
        surface: '#0d1116',
        text: '#f2f6f8',
        brand: '#c5ff5a',
        error: '#f76560',
      },
    },
    false,
    isHex,
  );
  const tokens = buildThemeTokens(theme);

  assert.equal(tokens['--tea-color-bg-page-default'], '#07090c');
  assert.equal(tokens['--tea-form-color-text-primary'], '#f2f6f8');
  assert.equal(tokens['--tea-color-bg-brand-default'], '#c5ff5a');
  assert.equal(tokens['--tea-color-text-link-default'], '#c5ff5a');
  assert.equal(tokens['--tea-color-function-brand-default'], '#c5ff5a');
  assert.equal(tokens['--tea-color-bg-error-default'], '#f76560');
  assert.match(tokens['--tea-color-function-error-hover'], /^color-mix/);
});

test('rejects invalid palette values and falls back to the current system appearance', () => {
  const theme = resolveMemoryTheme(
    { appearance: 'sepia', palette: { brand: 'url(javascript:alert(1))' } },
    true,
    isHex,
  );

  assert.deepEqual(theme, { appearance: 'dark' });
  assert.deepEqual(buildThemeTokens(theme), {});
});

const fakeRoot = () => {
  const attributes = new Map();
  const classes = new Set();
  const properties = new Map();
  return {
    attributes,
    classes,
    properties,
    root: {
      setAttribute: (name, value) => attributes.set(name, value),
      classList: {
        toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)),
      },
      style: {
        colorScheme: '',
        setProperty: (name, value) => properties.set(name, value),
        removeProperty: (name) => properties.delete(name),
      },
    },
  };
};

test('applies and then clears a custom palette when returning to a plain light theme', () => {
  const state = fakeRoot();
  applyMemoryTheme(
    { appearance: 'dark', palette: { background: '#07090c', brand: '#c5ff5a' } },
    false,
    state.root,
    isHex,
  );
  assert.equal(state.attributes.get('theme-mode'), 'dark');
  assert.equal(state.classes.has('dark'), true);
  assert.equal(state.properties.get('--tea-color-bg-brand-default'), '#c5ff5a');

  applyMemoryTheme('light', true, state.root);
  assert.equal(state.attributes.get('theme-mode'), 'light');
  assert.equal(state.classes.has('dark'), false);
  assert.equal(state.properties.has('--tea-color-bg-brand-default'), false);
});

test('bridges initial OS fallback, custom events and parent messages live', () => {
  const target = new EventTarget();
  const media = new EventTarget();
  Object.assign(media, { matches: true });
  Object.assign(target, {
    location: { href: 'http://memory.local/' },
    parent: target,
    matchMedia: () => media,
  });
  const state = fakeRoot();
  const stop = startMemoryThemeBridge(target, state.root, isHex);
  assert.equal(state.attributes.get('theme-mode'), 'dark');

  target.dispatchEvent(new CustomEvent('ellmsha-theme', { detail: 'light' }));
  assert.equal(state.attributes.get('theme-mode'), 'light');

  const message = new Event('message');
  Object.defineProperties(message, {
    source: { value: target },
    data: {
      value: {
        type: 'ellmsha-theme',
        detail: { appearance: 'dark', palette: { brand: '#c5ff5a' } },
      },
    },
  });
  target.dispatchEvent(message);
  assert.equal(state.properties.get('--tea-color-bg-brand-default'), '#c5ff5a');
  stop();
});
