import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import Play from '../src/renderer/src/screens/Play';
import type { LauncherState } from '../src/shared/types';

function launcherState(patch: Partial<LauncherState> = {}): LauncherState {
  return {
    phase: 'ready',
    statusLine: 'Ready.',
    errorDetails: null,
    resolvedHost: '127.0.0.1',
    serverName: 'Commonwealth',
    serverChoices: [{ id: 'built-in', name: 'Commonwealth' }],
    selectedServerId: 'built-in',
    serverStatus: 'online',
    gamePathValid: true,
    validatedGameExePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
    linuxRuntimeStatus: null,
    resolvedLinuxPrefix: '',
    gameModeAvailable: null,
    dxvk: {
      status: 'native',
      version: '2.6.2',
      rendererSetting: 'directx-9',
      detail: 'Native Direct3D is active.',
      canRestore: false
    },
    launchCoolingDown: false,
    activeGameInstances: 0,
    developerMode: false,
    progress: null,
    launcherVersion: '0.1.0',
    launcherUpdate: 'up-to-date',
    launcherUpdateVersion: null,
    launcherUpdateError: null,
    clientPatches: [],
    gameProfiles: [
      {
        id: '7dc38cb8-6514-4e23-9b31-56fe2f81703d',
        name: 'Competitive',
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:00:00.000Z',
        fileCount: 4
      },
      {
        id: '45ad3c7b-cf16-4212-a539-e8b287f632d3',
        name: 'High Quality',
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T13:00:00.000Z',
        fileCount: 5
      }
    ],
    selectedGameProfileId: '7dc38cb8-6514-4e23-9b31-56fe2f81703d',
    serverCommits: [],
    serverCommitsStatus: 'ready',
    agendaStatsText: null,
    agendaStatsStatus: 'error',
    platform: 'win32',
    accountTabEnabled: false,
    ...patch
  };
}

function render(state: LauncherState): string {
  return renderToStaticMarkup(
    <Play
      state={state}
      onOpenGameSettings={vi.fn()}
      onOpenInfo={vi.fn()}
      onOpenProfiles={vi.fn()}
    />
  );
}

describe('Play page', () => {
  it('renders numbered profile buttons with full hover names and the active selection', () => {
    const markup = render(launcherState());

    expect(markup).toContain('title="Competitive"');
    expect(markup).toContain('title="High Quality"');
    expect(markup).toContain('aria-label="Profile 1: Competitive, active"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Applied before patches when Play starts');
  });

  it('labels the information shortcut as FAQ', () => {
    const markup = render(launcherState());

    expect(markup).toContain('aria-label="Open frequently asked questions"');
    expect(markup).toContain('<strong>FAQ</strong>');
    expect(markup).not.toContain('Player Info');
  });

  it('locks every numbered selector while a launcher-started game remains open', () => {
    const markup = render(launcherState({ activeGameInstances: 1 }));

    expect(markup).toMatch(/title="Competitive"[^>]*disabled/);
    expect(markup).toMatch(/title="High Quality"[^>]*disabled/);
    expect(markup).toContain('Locked while game is running');
  });
});
