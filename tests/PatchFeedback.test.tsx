import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  GameClientDllStatusPanel,
  gameClientPatchPresentation,
  iniPatchCardPresentation,
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

describe('INI patch card presentation', () => {
  it('uses green and Remove only while the preferred patch is verified', () => {
    expect(iniPatchCardPresentation(true, true)).toEqual({
      tone: 'applied',
      enabled: true,
      actionLabel: 'REMOVE',
      nextPreference: false
    });
  });

  it('offers Apply when an enabled preference needs repair', () => {
    expect(iniPatchCardPresentation(true, false)).toEqual({
      tone: 'pending',
      enabled: false,
      actionLabel: 'APPLY',
      nextPreference: true
    });
    expect(iniPatchCardPresentation(true, null)).toMatchObject({
      tone: 'pending',
      enabled: false,
      actionLabel: 'APPLY'
    });
  });

  it('offers Remove when an installed patch remains after preference drift', () => {
    expect(iniPatchCardPresentation(false, true)).toEqual({
      tone: 'pending',
      enabled: true,
      actionLabel: 'REMOVE',
      nextPreference: false
    });
  });

  it('uses a neutral Apply state when the patch is disabled and absent', () => {
    expect(iniPatchCardPresentation(false, false)).toEqual({
      tone: 'removed',
      enabled: false,
      actionLabel: 'APPLY',
      nextPreference: true
    });
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

describe('Game Client Patch actual state', () => {
  it('shows green only when the preferred managed release is verified', () => {
    expect(
      gameClientPatchPresentation(true, false, {
        status: 'managed',
        detail: 'Managed release detected.',
        hasManagedMarker: true
      })
    ).toMatchObject({
      tone: 'applied',
      enabled: true,
      actionLabel: 'REMOVE',
      actionDisabled: false
    });
    expect(
      gameClientPatchPresentation(true, false, {
        status: 'missing',
        detail: 'No DLL detected.',
        hasManagedMarker: false
      })
    ).toMatchObject({
      tone: 'pending',
      enabled: false,
      actionLabel: 'APPLY',
      nextPreference: true
    });
  });

  it('offers removal when a managed release remains installed after preference drift', () => {
    expect(
      gameClientPatchPresentation(false, false, {
        status: 'managed',
        detail: 'Managed release detected.',
        hasManagedMarker: true
      })
    ).toMatchObject({
      tone: 'pending',
      enabled: false,
      actionLabel: 'REMOVE',
      nextPreference: false
    });
  });

  it('separates an active local override from the managed preference', () => {
    expect(
      gameClientPatchPresentation(false, true, {
        status: 'local',
        detail: 'Valid local DLL detected.',
        hasManagedMarker: false
      })
    ).toMatchObject({
      tone: 'applied',
      enabled: true,
      actionLabel: 'LOCAL',
      actionDisabled: true
    });
  });

  it('blocks managed controls for an unmanaged or invalid DLL', () => {
    for (const status of ['local', 'invalid'] as const) {
      expect(
        gameClientPatchPresentation(true, false, {
          status,
          detail: 'Unmanaged DLL needs attention.',
          hasManagedMarker: false
        })
      ).toMatchObject({
        tone: 'pending',
        enabled: false,
        actionLabel: 'BLOCKED',
        actionDisabled: true
      });
    }
  });
});

describe('local client DLL status panel', () => {
  it('warns that an unmanaged Windows DLL can load while local mode is off', () => {
    const markup = renderToStaticMarkup(
      <GameClientDllStatusPanel
        dll={{
          status: 'local',
          detail: 'Valid local x86 DLL detected.',
          hasManagedMarker: false
        }}
        localMode={false}
        platform="win32"
      />
    );

    expect(markup).toContain('UNMANAGED DLL CAN LOAD');
    expect(markup).toContain('Move or rename it manually');
    expect(markup).toContain('data-tone="warning"');
  });

  it('states that an active local override remains developer-owned', () => {
    const markup = renderToStaticMarkup(
      <GameClientDllStatusPanel
        dll={{
          status: 'local',
          detail: 'Valid local x86 DLL detected.',
          hasManagedMarker: false
        }}
        localMode
        platform="linux"
      />
    );

    expect(markup).toContain('LOCAL OVERRIDE ACTIVE');
    expect(markup).toContain('never update, replace, rename, or remove');
    expect(markup).toContain('data-tone="active"');
  });
});
