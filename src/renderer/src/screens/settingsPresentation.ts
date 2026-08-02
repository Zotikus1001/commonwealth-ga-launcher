import type { ActionResult, DlcStatus, LauncherState } from '@shared/types';

export type GameClientDllNoticeTone = 'active' | 'managed' | 'warning' | 'error' | 'idle';

export function gameClientDllNoticeCopy(
  dll: LauncherState['gameClientDll'],
  localMode: boolean
): {
  tone: GameClientDllNoticeTone;
  label: string;
  title: string;
  detail: string;
} {
  if (dll.status === 'local' && localMode) {
    return {
      tone: 'active',
      label: 'LOCAL OVERRIDE ACTIVE',
      title: 'Developer DLL validated',
      detail:
        `${dll.detail} It applies to Play and Dev Launch. ` +
        'The launcher will never update, replace, rename, or remove this file.'
    };
  }
  if (dll.status === 'local') {
    return {
      tone: 'warning',
      label: 'UNMANAGED DLL DETECTED',
      title: 'Play will reconcile this DLL',
      detail:
        `${dll.detail} With Local DLL Override off, Play will replace or remove this file ` +
        'to match the Game Client Patch setting. Enable Local DLL Override before Play to keep it.'
    };
  }
  if (dll.status === 'managed') {
    return {
      tone: 'managed',
      label: 'MANAGED RELEASE VERIFIED',
      title: 'Launcher-owned DLL detected',
      detail: dll.detail
    };
  }
  if (dll.status === 'invalid') {
    return {
      tone: 'error',
      label: 'DLL REJECTED',
      title: 'Play will try to repair this state',
      detail:
        `${dll.detail} With Local DLL Override off, Play will replace or remove a regular DLL ` +
        'to match the Game Client Patch setting.'
    };
  }
  if (dll.status === 'missing') {
    return {
      tone: localMode ? 'error' : 'idle',
      label: localMode ? 'LOCAL OVERRIDE BROKEN' : 'NO CLIENT DLL',
      title: localMode ? 'The validated local file is no longer available' : 'No DLL detected',
      detail: localMode
        ? `${dll.detail} Copy a valid 32-bit x86 local build back before launching.`
        : dll.detail
    };
  }
  return {
    tone: 'idle',
    label: 'INSTALL NOT READY',
    title: 'Client DLL cannot be inspected yet',
    detail: dll.detail
  };
}

export function gameClientPatchPresentation(
  preferred: boolean,
  localMode: boolean,
  dll: LauncherState['gameClientDll']
): {
  tone: 'applied' | 'pending' | 'removed';
  enabled: boolean;
  actionLabel: 'APPLY' | 'REMOVE' | 'LOCAL';
  actionDisabled: boolean;
  actionTitle: string;
  nextPreference: boolean;
} {
  const enabled =
    (localMode && dll.status === 'local') ||
    (!localMode && preferred && dll.status === 'managed');
  if (localMode) {
    return {
      tone: enabled ? 'applied' : 'pending',
      enabled,
      actionLabel: 'LOCAL',
      actionDisabled: true,
      actionTitle: 'Managed patch controls are paused while Local DLL Mode is enabled.',
      nextPreference: preferred
    };
  }
  const unmanagedOrInvalid = dll.status === 'local' || dll.status === 'invalid';
  const removeInstalled = dll.status === 'managed' || (!preferred && unmanagedOrInvalid);
  return {
    tone: enabled ? 'applied' : preferred || removeInstalled ? 'pending' : 'removed',
    enabled,
    actionLabel: removeInstalled ? 'REMOVE' : 'APPLY',
    actionDisabled: false,
    actionTitle: `${removeInstalled ? 'Remove' : 'Apply'} Game Client Patch`,
    nextPreference: !removeInstalled
  };
}

export function manualPatchErrorMessage(result: ActionResult): string | null {
  return result.ok ? null : result.message;
}

type IniPatchCardTone = 'applied' | 'pending' | 'removed';

export function iniPatchCardPresentation(
  preferred: boolean,
  applied: boolean | null
): {
  tone: IniPatchCardTone;
  enabled: boolean;
  actionLabel: 'APPLY' | 'REMOVE';
  nextPreference: boolean;
} {
  const enabled = applied === true;
  return {
    tone: enabled ? (preferred ? 'applied' : 'pending') : preferred ? 'pending' : 'removed',
    enabled,
    actionLabel: enabled ? 'REMOVE' : 'APPLY',
    nextPreference: !enabled
  };
}

type DlcCardTone = 'installed' | 'pending' | 'idle' | 'problem';

export function dlcCardPresentation(
  preferred: boolean,
  status: DlcStatus['status']
): {
  tone: DlcCardTone;
  enabled: boolean;
  actionLabel: 'INSTALL' | 'REMOVE';
  nextPreference: boolean;
  actionDisabled: boolean;
  statusLabel: string;
} {
  const enabled = status === 'installed';
  const statusLabel: Record<DlcStatus['status'], string> = {
    unavailable: 'GAME LOCATION REQUIRED',
    missing: 'NOT INSTALLED',
    partial: 'REPAIR REQUIRED',
    installed: 'INSTALLED // VERIFIED',
    modified: 'FILE CONFLICT',
    installing: 'INSTALLING',
    removing: 'REMOVING',
    error: 'DLC ERROR'
  };
  return {
    tone:
      status === 'installed'
        ? 'installed'
        : status === 'modified' || status === 'error'
          ? 'problem'
          : status === 'installing' ||
              status === 'removing' ||
              (preferred && status !== 'unavailable')
            ? 'pending'
            : 'idle',
    enabled,
    actionLabel: enabled ? 'REMOVE' : 'INSTALL',
    nextPreference: !enabled,
    actionDisabled:
      status === 'unavailable' ||
      status === 'installing' ||
      status === 'removing' ||
      status === 'modified',
    statusLabel: statusLabel[status]
  };
}
