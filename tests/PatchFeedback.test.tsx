import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  iniPatchCardTone,
  manualPatchErrorMessage,
  PatchEnabledCheck
} from '../src/renderer/src/screens/Settings';

describe('manual patch feedback', () => {
  it('suppresses successful action text', () => {
    expect(manualPatchErrorMessage({ ok: true, message: 'Patch applied.' })).toBeNull();
    expect(manualPatchErrorMessage({ ok: true, message: 'Patch removed.' })).toBeNull();
  });

  it('keeps detailed failures visible', () => {
    expect(manualPatchErrorMessage({ ok: false, message: 'Could not write TgEngine.ini.' })).toBe(
      'Could not write TgEngine.ini.'
    );
  });
});

describe('INI patch card tone', () => {
  it('uses a removed neutral card when the preference is off despite stale applied inspection', () => {
    expect(iniPatchCardTone(false, true)).toBe('removed');
  });

  it('uses green only while the patch is enabled and verified', () => {
    expect(iniPatchCardTone(true, true)).toBe('applied');
  });

  it('uses amber while an enabled patch is not verified', () => {
    expect(iniPatchCardTone(true, false)).toBe('pending');
    expect(iniPatchCardTone(true, null)).toBe('pending');
  });
});

describe('patch enabled check', () => {
  it('renders a check marker only for enabled patches', () => {
    const enabled = renderToStaticMarkup(<PatchEnabledCheck enabled />);
    const disabled = renderToStaticMarkup(<PatchEnabledCheck enabled={false} />);

    expect(enabled).toContain('aria-label="Patch enabled"');
    expect(enabled).toContain('✓');
    expect(disabled).toBe('');
  });
});
