import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DlcEnabledCheck,
  dlcCardPresentation
} from '../src/renderer/src/screens/Settings';

describe('DLC card feedback', () => {
  it('uses the verified installed state for Remove and the green check', () => {
    expect(dlcCardPresentation(true, 'installed')).toEqual({
      tone: 'installed',
      enabled: true,
      actionLabel: 'REMOVE',
      nextPreference: false,
      actionDisabled: false,
      statusLabel: 'INSTALLED // VERIFIED'
    });
    expect(renderToStaticMarkup(<DlcEnabledCheck enabled />)).toContain('DLC installed');
    expect(renderToStaticMarkup(<DlcEnabledCheck enabled={false} />)).toBe('');
  });

  it('shows enabled missing content as pending and allows repair', () => {
    expect(dlcCardPresentation(true, 'missing')).toMatchObject({
      tone: 'pending',
      enabled: false,
      actionLabel: 'APPLY',
      nextPreference: true,
      actionDisabled: false,
      statusLabel: 'NOT INSTALLED'
    });
    expect(dlcCardPresentation(true, 'partial')).toMatchObject({
      tone: 'pending',
      actionLabel: 'APPLY',
      actionDisabled: false,
      statusLabel: 'REPAIR REQUIRED'
    });
  });

  it('keeps a removed preference visually idle', () => {
    expect(dlcCardPresentation(false, 'missing')).toMatchObject({
      tone: 'idle',
      enabled: false,
      actionLabel: 'APPLY',
      nextPreference: true
    });
  });

  it('blocks unsafe or unavailable actions while explaining the state', () => {
    expect(dlcCardPresentation(true, 'modified')).toMatchObject({
      tone: 'problem',
      actionDisabled: true,
      statusLabel: 'FILE CONFLICT'
    });
    expect(dlcCardPresentation(true, 'unavailable')).toMatchObject({
      tone: 'idle',
      actionDisabled: true,
      statusLabel: 'GAME LOCATION REQUIRED'
    });
    expect(dlcCardPresentation(true, 'installing')).toMatchObject({
      tone: 'pending',
      actionDisabled: true,
      statusLabel: 'INSTALLING'
    });
  });
});
