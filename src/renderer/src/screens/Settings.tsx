import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  DLC_SETTING_KEY_BY_ID,
  type ActionResult,
  type ClientPatchStatus,
  type DlcId,
  type DlcStatus,
  type GameProfileSummary,
  type LauncherState,
  type LinuxRuntimeOptions,
  type Settings as SettingsModel
} from '@shared/types';
import { isLoginMap, LOGIN_MAP_OPTIONS } from '@shared/loginMaps';
import { isFpsLimit, MAX_FPS_LIMIT, MIN_FPS_LIMIT } from '@shared/fpsLimit';
import { isUiScale, UI_SCALE_OPTIONS } from '@shared/uiScale';
import {
  GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE,
  LINUX_COMMAND_PLACEHOLDER,
  MAX_LINUX_COMMAND_TEMPLATE_LENGTH,
  validateLinuxCommandTemplate
} from '@shared/linuxCommandTemplate';
import {
  MAX_GAME_PROFILES,
  MAX_GAME_PROFILE_NAME_LENGTH,
  normalizeGameProfileName,
  validateGameProfileName
} from '@shared/gameProfiles';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import {
  DEFAULT_SERVER_ID,
  DEVELOPER_MAX_HEIGHT,
  DEVELOPER_MAX_WIDTH,
  DEVELOPER_MIN_HEIGHT,
  DEVELOPER_MIN_WIDTH,
  MAX_CUSTOM_SERVERS,
  validateServerSettings
} from '@shared/serverProfiles';
import styles from './Settings.module.css';

export type SettingsTab =
  | 'game'
  | 'profiles'
  | 'servers'
  | 'patches'
  | 'dlcs'
  | 'info'
  | 'account'
  | 'launcher'
  | 'dev'
  | 'diagnostics'
  | 'about';

export interface SettingsHandle {
  requestBack: () => void;
}

interface SettingsProps {
  state: LauncherState;
  initialTab?: SettingsTab;
  onBack: () => void;
}

type PendingNavigation =
  | { kind: 'tab'; tab: SettingsTab }
  | { kind: 'back' };

const DEV_UNLOCK_CLICKS = 10;
const DEV_UNLOCK_WINDOW_MS = 4_000;
const EMPTY_LINUX_RUNTIME_OPTIONS: LinuxRuntimeOptions = {
  wineRunners: [],
  protonRunners: [],
  umuPath: '',
  gameModePath: '',
  steamPrefixPath: ''
};

const PATCH_COPY: Record<ClientPatchStatus['id'], { title: string; description: string }> = {
  'high-fps-movement-stability': {
    title: 'High-FPS Movement Stability',
    description:
      'Fixes teleporting and harsh position corrections caused by running the game at high frame rates. ' +
      'Limiting FPS to your monitor refresh rate is still recommended to avoid other potential issues.'
  },
  'adaptive-client-performance': {
    title: 'Client Performance Stability',
    description:
      'Improves consistency in busy scenes and reduces avoidable loading stutters during play.'
  }
};

const Settings = forwardRef<SettingsHandle, SettingsProps>(function Settings(
  { state, initialTab = 'game', onBack },
  ref
): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [draft, setDraft] = useState<SettingsModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapSaveError, setMapSaveError] = useState<string | null>(null);
  const [uiScaleSaving, setUiScaleSaving] = useState(false);
  const [uiScaleError, setUiScaleError] = useState<string | null>(null);
  const [linuxRuntimeOptions, setLinuxRuntimeOptions] = useState<LinuxRuntimeOptions>(
    EMPTY_LINUX_RUNTIME_OPTIONS
  );
  const [linuxRuntimeScanning, setLinuxRuntimeScanning] = useState(false);
  const [prefixCreating, setPrefixCreating] = useState(false);
  const [prefixResult, setPrefixResult] = useState<ActionResult | null>(null);
  const [steamAction, setSteamAction] = useState<'store' | 'install' | null>(null);
  const [steamResult, setSteamResult] = useState<ActionResult | null>(null);
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [developerModeSaving, setDeveloperModeSaving] = useState(false);
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null);
  const [gameClientPatchSaving, setGameClientPatchSaving] = useState(false);
  const [gameClientPatchError, setGameClientPatchError] = useState<string | null>(null);
  const [dlcSaving, setDlcSaving] = useState<DlcId | null>(null);
  const [dlcError, setDlcError] = useState<{ id: DlcId; message: string } | null>(null);
  const [localClientDllSaving, setLocalClientDllSaving] = useState(false);
  const [localClientDllError, setLocalClientDllError] = useState<string | null>(null);
  const aboutClicks = useRef<number[]>([]);

  const isLinux = window.api.platform === 'linux';

  useEffect(() => {
    void window.api.getSettings().then(setDraft);
    if (isLinux) {
      void window.api.listLinuxRuntimeOptions().then(setLinuxRuntimeOptions);
    }
  }, [isLinux]);

  useEffect(() => {
    if (dirty || !state.validatedGameExePath) return;
    void window.api.getSettings().then(setDraft);
  }, [dirty, state.gamePathValid, state.validatedGameExePath]);

  const tabs = useMemo<{ id: SettingsTab; label: string }[]>(() => {
    const t: { id: SettingsTab; label: string }[] = [
      { id: 'game', label: 'Game' },
      { id: 'profiles', label: 'Profiles' },
      { id: 'servers', label: 'Servers' },
      { id: 'patches', label: 'Patches' },
      { id: 'dlcs', label: "DLC's" },
      { id: 'info', label: 'Info' }
    ];
    // Account tab is built but gated off until Phase 4 auto-login works (plan §11b decision #4).
    if (state.accountTabEnabled) t.push({ id: 'account', label: 'Account' });
    t.push(
      { id: 'launcher', label: 'Launcher' },
      ...((draft?.developer.enabled || devUnlocked) ? [{ id: 'dev' as const, label: 'Dev' }] : []),
      { id: 'diagnostics', label: 'Diagnostics' },
      { id: 'about', label: 'About' }
    );
    return t;
  }, [devUnlocked, draft?.developer.enabled, state.accountTabEnabled]);

  const edit = (fn: (d: SettingsModel) => SettingsModel): void => {
    setDraft((d) => (d ? fn(structuredClone(d)) : d));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    if (!draft || mapSaving || uiScaleSaving) return false;
    if (!isUiScale(draft.uiScale)) {
      setSaveError('Launcher UI scale is invalid.');
      return false;
    }
    if (!isFpsLimit(draft.fpsLimit.value)) {
      setSaveError(
        `FPS limit must be a whole number from ${MIN_FPS_LIMIT} to ${MAX_FPS_LIMIT}.`
      );
      return false;
    }
    const linuxCommandTemplateError = validateLinuxCommandTemplate(
      draft.linux.commandTemplate
    );
    if (linuxCommandTemplateError) {
      setSaveError(linuxCommandTemplateError);
      return false;
    }
    const validationError = validateServerSettings(
      draft.servers.builtInName,
      draft.servers.custom
    );
    if (validationError) {
      setSaveError(validationError);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await window.api.updateSettings(draft);
      setDraft(updated);
      setDirty(false);
      setMapSaveError(null);
      if (!updated.developer.enabled && tab === 'dev') {
        setDevUnlocked(false);
        setTab('game');
      }
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveLoginMap = async (loginMap: SettingsModel['loginMap']): Promise<void> => {
    if (!draft || mapSaving) return;
    const previous = draft.loginMap;
    setDraft((current) => (current ? { ...current, loginMap } : current));
    setMapSaving(true);
    setMapSaveError(null);
    try {
      const updated = await window.api.updateSettings({ loginMap });
      setDraft((current) => (current ? { ...current, loginMap: updated.loginMap } : current));
    } catch (error) {
      setDraft((current) =>
        current?.loginMap === loginMap ? { ...current, loginMap: previous } : current
      );
      setMapSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setMapSaving(false);
    }
  };

  const saveUiScale = async (uiScale: SettingsModel['uiScale']): Promise<void> => {
    if (!draft || uiScaleSaving || uiScale === draft.uiScale) return;
    const previous = draft.uiScale;
    setDraft((current) => (current ? { ...current, uiScale } : current));
    setUiScaleSaving(true);
    setUiScaleError(null);
    try {
      const updated = await window.api.updateSettings({ uiScale });
      setDraft((current) =>
        current ? { ...current, uiScale: updated.uiScale } : current
      );
    } catch (error) {
      setDraft((current) =>
        current?.uiScale === uiScale ? { ...current, uiScale: previous } : current
      );
      setUiScaleError(error instanceof Error ? error.message : String(error));
    } finally {
      setUiScaleSaving(false);
    }
  };

  const browse = async (): Promise<void> => {
    const p = await window.api.browseForGame(); // saved main-side immediately
    if (p) setDraft((d) => (d ? { ...d, gameExePath: p } : d));
  };

  const autoDetect = async (): Promise<void> => {
    const p = await window.api.autoDetectGame(); // saved main-side immediately
    if (p) setDraft((d) => (d ? { ...d, gameExePath: p } : d));
  };

  const openSteamStore = async (): Promise<void> => {
    if (steamAction) return;
    setSteamAction('store');
    setSteamResult(null);
    try {
      const result = await window.api.openSteamStore();
      if (!result.ok) setSteamResult(result);
    } catch (error) {
      setSteamResult({
        ok: false,
        message: `Could not open Steam: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setSteamAction(null);
    }
  };

  const openSteamInstall = async (): Promise<void> => {
    if (steamAction) return;
    setSteamAction('install');
    setSteamResult(null);
    try {
      const result = await window.api.openSteamInstall();
      if (!result.ok) setSteamResult(result);
    } catch (error) {
      setSteamResult({
        ok: false,
        message: `Could not open Steam: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setSteamAction(null);
    }
  };

  const createPrefix = async (): Promise<void> => {
    if (prefixCreating) return;
    if (dirty && !(await save())) return; // prefix creation uses SAVED settings
    setPrefixCreating(true);
    try {
      setPrefixResult({ ok: true, message: 'Creating prefix… (first boot can take minutes)' });
      setPrefixResult(await window.api.createWinePrefix());
    } finally {
      setPrefixCreating(false);
    }
  };

  const rescanLinuxRuntime = async (): Promise<void> => {
    if (linuxRuntimeScanning) return;
    setLinuxRuntimeScanning(true);
    try {
      setLinuxRuntimeOptions(await window.api.listLinuxRuntimeOptions());
    } finally {
      setLinuxRuntimeScanning(false);
    }
  };

  const saveDeveloperMode = async (enabled: boolean): Promise<void> => {
    if (!draft || developerModeSaving) return;
    const previous = draft.developer;
    setDraft((current) =>
      current
        ? {
            ...current,
            developer: {
              ...current.developer,
              enabled,
              useLocalClientDll: enabled ? current.developer.useLocalClientDll : false
            }
          }
        : current
    );
    setDeveloperModeSaving(true);
    setDeveloperModeError(null);
    try {
      const updated = await window.api.updateSettings({ developer: { enabled } });
      setDraft((current) =>
        current
          ? {
              ...current,
              developer: {
                ...current.developer,
                enabled: updated.developer.enabled,
                useLocalClientDll: updated.developer.useLocalClientDll
              }
            }
          : current
      );
      if (!updated.developer.enabled) {
        setDevUnlocked(false);
        if (tab === 'dev') setTab('game');
      }
    } catch (error) {
      setDraft((current) =>
        current
          ? { ...current, developer: { ...current.developer, ...previous } }
          : current
      );
      setDeveloperModeError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeveloperModeSaving(false);
    }
  };

  const saveGameClientPatch = async (enabled: boolean): Promise<void> => {
    if (!draft || gameClientPatchSaving) return;
    const previous = draft.patches.gameClientPatch;
    setDraft((current) =>
      current
        ? { ...current, patches: { ...current.patches, gameClientPatch: enabled } }
        : current
    );
    setGameClientPatchSaving(true);
    setGameClientPatchError(null);
    try {
      const updated = await window.api.setGameClientPatch(enabled);
      setDraft((current) =>
        current
          ? {
              ...current,
              patches: { ...current.patches, gameClientPatch: updated.patches.gameClientPatch }
            }
          : current
      );
    } catch (error) {
      setDraft((current) =>
        current
          ? { ...current, patches: { ...current.patches, gameClientPatch: previous } }
          : current
      );
      setGameClientPatchError(error instanceof Error ? error.message : String(error));
    } finally {
      setGameClientPatchSaving(false);
    }
  };

  const saveLocalClientDll = async (enabled: boolean): Promise<void> => {
    if (!draft || localClientDllSaving) return;
    const previous = draft.developer.useLocalClientDll;
    setDraft((current) =>
      current
        ? { ...current, developer: { ...current.developer, useLocalClientDll: enabled } }
        : current
    );
    setLocalClientDllSaving(true);
    setLocalClientDllError(null);
    try {
      const updated = await window.api.updateSettings({ developer: { useLocalClientDll: enabled } });
      setDraft((current) =>
        current
          ? {
              ...current,
              developer: {
                ...current.developer,
                useLocalClientDll: updated.developer.useLocalClientDll
              }
            }
          : current
      );
    } catch (error) {
      setDraft((current) =>
        current
          ? { ...current, developer: { ...current.developer, useLocalClientDll: previous } }
          : current
      );
      setLocalClientDllError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalClientDllSaving(false);
    }
  };

  const saveDlc = async (id: DlcId, enabled: boolean): Promise<void> => {
    if (!draft || dlcSaving) return;
    const settingKey = DLC_SETTING_KEY_BY_ID[id];
    const previous = draft.dlcs[settingKey];
    setDraft((current) =>
      current
        ? { ...current, dlcs: { ...current.dlcs, [settingKey]: enabled } }
        : current
    );
    setDlcSaving(id);
    setDlcError(null);
    try {
      const updated = await window.api.setDlcEnabled(id, enabled);
      setDraft((current) =>
        current
          ? {
              ...current,
              dlcs: {
                ...current.dlcs,
                [settingKey]: updated.dlcs[settingKey]
              }
            }
          : current
      );
    } catch (error) {
      setDraft((current) =>
        current
          ? { ...current, dlcs: { ...current.dlcs, [settingKey]: previous } }
          : current
      );
      setDlcError({
        id,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setDlcSaving(null);
    }
  };

  const commitTabSelection = (next: SettingsTab): void => {
    if (next === 'about' && draft && !draft.developer.enabled && !devUnlocked) {
      const now = Date.now();
      const recent = [...aboutClicks.current.filter((time) => now - time <= DEV_UNLOCK_WINDOW_MS), now];
      aboutClicks.current = recent;
      if (recent.length >= DEV_UNLOCK_CLICKS) {
        aboutClicks.current = [];
        setDevUnlocked(true);
        setTab('dev');
        return;
      }
    } else if (next !== 'about') {
      aboutClicks.current = [];
    }
    setTab(next);
  };

  const completeNavigation = (navigation: PendingNavigation): void => {
    setPendingNavigation(null);
    if (navigation.kind === 'back') onBack();
    else commitTabSelection(navigation.tab);
  };

  const requestNavigation = (navigation: PendingNavigation): void => {
    if (saving || discarding || mapSaving || developerModeSaving || pendingNavigation) return;
    if (!draft || !dirty) {
      completeNavigation(navigation);
      return;
    }
    setSaveError(null);
    setPendingNavigation(navigation);
  };

  const selectTab = (next: SettingsTab): void => {
    if (next === tab) {
      commitTabSelection(next);
      return;
    }
    requestNavigation({ kind: 'tab', tab: next });
  };

  const saveAndNavigate = async (): Promise<void> => {
    const navigation = pendingNavigation;
    if (!navigation) return;
    if (await save()) completeNavigation(navigation);
  };

  const discardAndNavigate = async (): Promise<void> => {
    const navigation = pendingNavigation;
    if (!navigation || discarding) return;
    setDiscarding(true);
    setSaveError(null);
    try {
      setDraft(await window.api.getSettings());
      setDirty(false);
      completeNavigation(navigation);
    } catch (error) {
      setSaveError(`Could not discard changes: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDiscarding(false);
    }
  };

  useImperativeHandle(
    ref,
    () => ({ requestBack: () => requestNavigation({ kind: 'back' }) })
  );

  useEffect(() => {
    if (!pendingNavigation) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving && !discarding) setPendingNavigation(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [discarding, pendingNavigation, saving]);

  if (!draft) return <div className={styles.loading}>Loading settings…</div>;

  const pathMatchesValidation = draft.gameExePath === state.validatedGameExePath;
  const gamePathStatus = !draft.gameExePath
    ? 'path required'
    : !pathMatchesValidation
      ? 'save to validate'
      : state.gamePathValid
        ? 'valid install'
        : 'invalid install';
  const gamePathIsValid = pathMatchesValidation && state.gamePathValid;
  const linuxCommandTemplateError = validateLinuxCommandTemplate(
    draft.linux.commandTemplate
  );

  return (
    <div className={styles.settings}>
      <nav className={styles.rail}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''} ${
              t.id === 'about' ? styles.aboutTab : ''
            }`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {tab === 'game' && (
          <section className={styles.section}>
            <div className="panel-title">Game Install</div>
            <div className={styles.fieldRow}>
              <label>GlobalAgenda.exe</label>
              <input
                type="text"
                value={draft.gameExePath}
                placeholder={
                  isLinux
                    ? '/path/to/Global Agenda/Binaries/GlobalAgenda.exe'
                    : '…\\Global Agenda\\Binaries\\GlobalAgenda.exe'
                }
                onChange={(e) => edit((d) => ({ ...d, gameExePath: e.target.value }))}
              />
              <div className={styles.inlineButtons}>
                <button onClick={() => void browse()}>Browse…</button>
                <button onClick={() => void autoDetect()}>Auto-detect</button>
                <button
                  className={`${styles.steamButton} ${styles.steamStoreButton}`}
                  disabled={steamAction !== null}
                  onClick={() => void openSteamStore()}
                >
                  {steamAction === 'store' ? 'Opening Steam…' : 'View on Steam'}
                </button>
                {!state.gamePathValid && (
                  <button
                    className={styles.steamButton}
                    disabled={steamAction !== null}
                    onClick={() => void openSteamInstall()}
                  >
                    {steamAction === 'install' ? 'Opening Steam…' : 'Install on Steam'}
                  </button>
                )}
              </div>
              {steamResult && (
                <span className={styles.invalid}>{steamResult.message}</span>
              )}
              <span className={gamePathIsValid ? styles.valid : styles.invalid}>
                {gamePathStatus}
              </span>
            </div>

            {isLinux && (
              <>
                <div className="panel-title">Linux Compatibility</div>
                <div className={styles.optionList}>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="linux-runner"
                      checked={draft.linux.runner === 'wine'}
                      onChange={() =>
                        edit((d) => ({ ...d, linux: { ...d.linux, runner: 'wine' } }))
                      }
                    />
                    <span>
                      <strong>Wine</strong>
                      <small>Use a system or Lutris Wine runner directly.</small>
                    </span>
                  </label>
                  <label className={styles.optionRow}>
                    <input
                      type="radio"
                      name="linux-runner"
                      checked={draft.linux.runner === 'proton'}
                      onChange={() =>
                        edit((d) => ({ ...d, linux: { ...d.linux, runner: 'proton' } }))
                      }
                    />
                    <span>
                      <strong>Proton via UMU</strong>
                      <small>Recommended when UMU and Proton are installed.</small>
                    </span>
                  </label>
                </div>

                {draft.linux.runner === 'wine' ? (
                  <div className={styles.fieldRow}>
                    <label>Wine Runner</label>
                    <select
                      value={draft.linux.winePath}
                      onChange={(event) =>
                        edit((d) => ({
                          ...d,
                          linux: { ...d.linux, winePath: event.target.value }
                        }))
                      }
                    >
                      <option value="">— pick a runner —</option>
                      {linuxRuntimeOptions.wineRunners.map((runner) => (
                        <option key={runner.path} value={runner.path}>
                          {runner.label}
                        </option>
                      ))}
                    </select>
                    <label>Custom Wine Binary</label>
                    <input
                      type="text"
                      value={draft.linux.winePath}
                      placeholder="/path/to/wine"
                      onChange={(event) =>
                        edit((d) => ({
                          ...d,
                          linux: { ...d.linux, winePath: event.target.value }
                        }))
                      }
                    />
                  </div>
                ) : (
                  <>
                    <div className={styles.fieldRow}>
                      <label>Proton Version</label>
                      <select
                        value={draft.linux.protonPath}
                        onChange={(event) =>
                          edit((d) => ({
                            ...d,
                            linux: { ...d.linux, protonPath: event.target.value }
                          }))
                        }
                      >
                        <option value="">— pick a Proton installation —</option>
                        {linuxRuntimeOptions.protonRunners.map((runner) => (
                          <option key={runner.path} value={runner.path}>
                            {runner.label}
                          </option>
                        ))}
                      </select>
                      <label>Custom Proton Directory</label>
                      <input
                        type="text"
                        value={draft.linux.protonPath}
                        placeholder="/path/to/GE-Proton"
                        onChange={(event) =>
                          edit((d) => ({
                            ...d,
                            linux: { ...d.linux, protonPath: event.target.value }
                          }))
                        }
                      />
                    </div>
                    <div className={styles.fieldRow}>
                      <label>UMU Launcher Override</label>
                      <input
                        type="text"
                        value={draft.linux.umuPath}
                        placeholder={linuxRuntimeOptions.umuPath || '/path/to/umu-run'}
                        onChange={(event) =>
                          edit((d) => ({
                            ...d,
                            linux: { ...d.linux, umuPath: event.target.value }
                          }))
                        }
                      />
                      <span className={linuxRuntimeOptions.umuPath ? styles.valid : styles.invalid}>
                        {linuxRuntimeOptions.umuPath
                          ? `UMU detected: ${linuxRuntimeOptions.umuPath}`
                          : 'UMU was not detected. Install umu-launcher or enter its executable path.'}
                      </span>
                    </div>
                  </>
                )}

                <div className={styles.fieldRow}>
                  <label>Compatibility Prefix</label>
                  <input
                    type="text"
                    value={draft.linux.winePrefix}
                    placeholder="/path/to/prefix or .../compatdata/17020"
                    onChange={(event) =>
                      edit((d) => ({
                        ...d,
                        linux: { ...d.linux, winePrefix: event.target.value }
                      }))
                    }
                  />
                  <span className={styles.featureDetail}>
                    Accepts a Wine prefix or a Proton compatibility-data folder. A nested pfx
                    prefix is found automatically.
                  </span>
                  <div className={styles.inlineButtons}>
                    {draft.linux.runner === 'wine' && (
                      <button
                        disabled={prefixCreating}
                        onClick={() => void createPrefix()}
                      >
                        {prefixCreating ? 'Creating…' : 'Create Prefix'}
                      </button>
                    )}
                    {linuxRuntimeOptions.steamPrefixPath &&
                      draft.linux.winePrefix !== linuxRuntimeOptions.steamPrefixPath && (
                        <button
                          onClick={() =>
                            edit((d) => ({
                              ...d,
                              linux: {
                                ...d.linux,
                                winePrefix: linuxRuntimeOptions.steamPrefixPath
                              }
                            }))
                          }
                        >
                          Use Steam Prefix
                        </button>
                      )}
                    <button
                      disabled={linuxRuntimeScanning}
                      onClick={() => void rescanLinuxRuntime()}
                    >
                      {linuxRuntimeScanning ? 'Scanning…' : 'Rescan Linux Tools'}
                    </button>
                  </div>
                  {prefixResult && (
                    <span className={prefixResult.ok ? styles.valid : styles.invalid}>
                      {prefixResult.message}
                    </span>
                  )}
                </div>

                <div className={styles.featureToggle}>
                  <input
                    id="linux-gamemode"
                    type="checkbox"
                    checked={draft.linux.gameMode}
                    disabled={!linuxRuntimeOptions.gameModePath && !draft.linux.gameMode}
                    onChange={(event) =>
                      edit((d) => ({
                        ...d,
                        linux: { ...d.linux, gameMode: event.target.checked }
                      }))
                    }
                  />
                  <label htmlFor="linux-gamemode">
                    <span className={styles.featureName}>Use Feral GameMode</span>
                    <span className={styles.featureDetail}>
                      {linuxRuntimeOptions.gameModePath
                        ? 'Temporarily asks Linux to prioritize game performance while Global Agenda runs. Normal system settings are restored after the game closes.'
                        : 'Optional. Feral GameMode was not detected; install it to let Linux temporarily prioritize the game while it runs.'}
                    </span>
                  </label>
                </div>

                <div className={`${styles.fieldRow} ${styles.commandWrapper}`}>
                  <div className={styles.commandWrapperHeading}>
                    <label htmlFor="linux-command-wrapper">Command Wrapper</label>
                    <span>advanced · Linux only</span>
                  </div>
                  <input
                    id="linux-command-wrapper"
                    className={styles.commandWrapperInput}
                    type="text"
                    value={draft.linux.commandTemplate}
                    maxLength={MAX_LINUX_COMMAND_TEMPLATE_LENGTH}
                    spellCheck={false}
                    aria-invalid={linuxCommandTemplateError !== null}
                    aria-describedby={
                      linuxCommandTemplateError
                        ? 'linux-command-wrapper-help linux-command-wrapper-error'
                        : 'linux-command-wrapper-help'
                    }
                    onChange={(event) =>
                      edit((d) => ({
                        ...d,
                        linux: { ...d.linux, commandTemplate: event.target.value }
                      }))
                    }
                  />
                  <div id="linux-command-wrapper-help" className={styles.commandWrapperHelp}>
                    <span>
                      Put exactly one standalone{' '}
                      <code>{LINUX_COMMAND_PLACEHOLDER}</code> where the launcher-managed
                      Wine or UMU command should run.
                    </span>
                    <span>
                      Arguments and quoted paths are supported. Shell operators are not.
                      Use <code>env KEY=value</code> to set child variables; Linux variables
                      such as <code>$HOME</code> are expanded. GameMode is already inside{' '}
                      <code>{LINUX_COMMAND_PLACEHOLDER}</code> when enabled above.
                    </span>
                  </div>
                  <div className={styles.commandWrapperExample}>
                    <div>
                      <span>Gamescope ultrawide example</span>
                      <code>{GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE}</code>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        edit((d) => ({
                          ...d,
                          linux: {
                            ...d.linux,
                            commandTemplate: GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE
                          }
                        }))
                      }
                    >
                      Use Example
                    </button>
                  </div>
                  {linuxCommandTemplateError && (
                    <span id="linux-command-wrapper-error" className={styles.invalid}>
                      {linuxCommandTemplateError}
                    </span>
                  )}
                </div>

                <div className={styles.checkRow}>
                  <input
                    id="winedebug"
                    type="checkbox"
                    checked={draft.linux.wineDebug}
                    onChange={(event) =>
                      edit((d) => ({
                        ...d,
                        linux: { ...d.linux, wineDebug: event.target.checked }
                      }))
                    }
                  />
                  <label htmlFor="winedebug">
                    Runtime debug output (captures compatibility-layer output in the launcher log;
                    the launcher stays attached to the game)
                  </label>
                </div>
              </>
            )}

            <div className="panel-title">Login Environment</div>
            <div className={`${styles.fieldRow} ${styles.mapPicker}`}>
              <label htmlFor="login-map">Login screen map</label>
              <select
                id="login-map"
                value={draft.loginMap}
                disabled={mapSaving || saving}
                onChange={(event) => {
                  const loginMap = event.currentTarget.value;
                  if (isLoginMap(loginMap)) {
                    void saveLoginMap(loginMap);
                  }
                }}
              >
                {LOGIN_MAP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {mapSaveError && (
                <p className={styles.invalid}>{`Could not save the login map: ${mapSaveError}`}</p>
              )}
            </div>

            <div className="panel-title">Graphics</div>
            <div className={styles.compactSetting}>
              <label htmlFor="game-gpu-adapter">
                <span className={styles.featureName}>GPU Adapter</span>
                <span className={styles.featureDetail}>
                  Selects which graphics adapter the game uses. Adapter 0 is the primary GPU.
                </span>
              </label>
              <input
                id="game-gpu-adapter"
                type="number"
                min={0}
                value={draft.launch.gpuAdapter}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    launch: {
                      ...current.launch,
                      gpuAdapter: Math.max(0, Number.parseInt(event.target.value, 10) || 0)
                    }
                  }))
                }
              />
            </div>

            <div className="panel-title">Frame Rate</div>
            <div className={styles.fpsLimitControl}>
              <input
                id="fps-limit-enabled"
                type="checkbox"
                checked={draft.fpsLimit.enabled}
                onChange={(event) =>
                  edit((settings) => ({
                    ...settings,
                    fpsLimit: { ...settings.fpsLimit, enabled: event.target.checked }
                  }))
                }
              />
              <label className={styles.fpsLimitDescription} htmlFor="fps-limit-enabled">
                <span className={styles.featureName}>FPS Limit</span>
                <span className={styles.featureDetail}>
                  Uses the game&apos;s frame smoothing limiter. Set it to your monitor refresh
                  rate to reduce avoidable movement and timing issues. Applied when you press
                  Play.
                </span>
              </label>
              <label className={styles.fpsLimitValue}>
                <span>Maximum FPS</span>
                <div>
                  <input
                    type="number"
                    min={MIN_FPS_LIMIT}
                    max={MAX_FPS_LIMIT}
                    step={1}
                    disabled={!draft.fpsLimit.enabled}
                    value={draft.fpsLimit.value}
                    onChange={(event) =>
                      edit((settings) => ({
                        ...settings,
                        fpsLimit: {
                          ...settings.fpsLimit,
                          value: Number.parseInt(event.target.value, 10) || 0
                        }
                      }))
                    }
                  />
                  <span>FPS</span>
                </div>
              </label>
            </div>

            <div className="panel-title">Combat Feedback</div>
            <div className={styles.featureToggle}>
              <input
                id="show-overhealing"
                type="checkbox"
                checked={draft.showOverhealing}
                onChange={(event) =>
                  edit((settings) => ({ ...settings, showOverhealing: event.target.checked }))
                }
              />
              <label htmlFor="show-overhealing">
                <span className={styles.featureName}>Show Overhealing</span>
                <span className={styles.featureDetail}>
                  Shows all healing and repair amounts even at full health, including self-heals
                  and environmental sources such as VR healing pads.
                </span>
              </label>
            </div>

            <div className="panel-title">Game Startup</div>
            <div className={styles.optionList}>
              <label className={styles.optionRow} htmlFor="nostartupmovies">
                <input
                  id="nostartupmovies"
                  type="checkbox"
                  checked={draft.launch.noStartupMovies}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      launch: { ...current.launch, noStartupMovies: event.target.checked }
                    }))
                  }
                />
                <span>
                  <strong>Skip Startup Movies</strong>
                  <small>Starts the game without playing its intro videos.</small>
                </span>
              </label>
              <label className={styles.optionRow} htmlFor="nosplash">
                <input
                  id="nosplash"
                  type="checkbox"
                  checked={draft.launch.noSplash}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      launch: { ...current.launch, noSplash: event.target.checked }
                    }))
                  }
                />
                <span>
                  <strong>Skip Splash Screen</strong>
                  <small>Starts the game without showing its initial splash window.</small>
                </span>
              </label>
            </div>

            <div className="panel-title">Advanced Game Launch</div>
            <div className={`${styles.fieldRow} ${styles.advancedLaunch}`}>
              <label htmlFor="extra-game-arguments">Extra Launch Arguments</label>
              <input
                id="extra-game-arguments"
                type="text"
                value={draft.launch.extraArgs}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    launch: { ...current.launch, extraArgs: event.target.value }
                  }))
                }
              />
              <span className={styles.hint}>Space-separated arguments passed directly to the game.</span>
            </div>
          </section>
        )}

        {tab === 'account' && (
          <section className={styles.section}>
            <div className="panel-title">Account</div>
            <p className={styles.hint}>Auto-login arrives in a later phase.</p>
          </section>
        )}

        {tab === 'profiles' && <ProfilesTab state={state} />}

        {tab === 'patches' && (
          <PatchesTab
            state={state}
            settings={draft}
            gameClientPatchSaving={gameClientPatchSaving}
            gameClientPatchError={gameClientPatchError}
            onGameClientPatchChange={(enabled) => void saveGameClientPatch(enabled)}
            onPatchPreferenceChange={(id, enabled) => {
              const preferenceKey =
                id === 'high-fps-movement-stability'
                  ? 'highFpsMovementStability'
                  : 'adaptiveClientPerformance';
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      patches: { ...current.patches, [preferenceKey]: enabled }
                    }
                  : current
              );
            }}
          />
        )}

        {tab === 'dlcs' && (
          <DlcsTab
            state={state}
            settings={draft}
            saving={dlcSaving}
            error={dlcError}
            onChange={(id, enabled) => void saveDlc(id, enabled)}
          />
        )}

        {tab === 'info' && <InfoTab />}

        {tab === 'servers' && <ServersTab settings={draft} edit={edit} />}

        {tab === 'launcher' && (
          <section className={styles.section}>
            <div className="panel-title">Launcher Interface</div>
            <div className={styles.launcherScaleSetting}>
              <div className={styles.launcherScaleCopy}>
                <span className={styles.featureName}>Launcher UI Scale</span>
                <span className={styles.featureDetail}>
                  Changes the size of launcher text and controls.
                </span>
              </div>
              <div className={styles.launcherScaleControl}>
                <select
                  id="launcher-ui-scale"
                  aria-label="Launcher UI Scale"
                  value={draft.uiScale}
                  disabled={uiScaleSaving || saving}
                  onChange={(event) => {
                    const scale = Number(event.currentTarget.value);
                    if (isUiScale(scale)) void saveUiScale(scale);
                  }}
                >
                  {UI_SCALE_OPTIONS.map((scale) => (
                    <option key={scale} value={scale}>
                      {Math.round(scale * 100)}%
                    </option>
                  ))}
                </select>
                {uiScaleError && <span className={styles.invalid}>{uiScaleError}</span>}
              </div>
            </div>

            <div className="panel-title">After Game Launch</div>
            <div className={styles.featureToggle}>
              <input
                id="close-after-launch"
                type="checkbox"
                checked={draft.launch.closeAfterLaunch}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    launch: { ...current.launch, closeAfterLaunch: event.target.checked }
                  }))
                }
              />
              <label htmlFor="close-after-launch">
                <span className={styles.featureName}>Automatically Close Launcher After Launching Game</span>
                <span className={styles.featureDetail}>
                  Closes the launcher five seconds after it starts the game.
                </span>
              </label>
            </div>
          </section>
        )}

        {tab === 'dev' && (
          <DeveloperTab
            state={state}
            settings={draft}
            edit={edit}
            modeSaving={developerModeSaving}
            modeError={developerModeError}
            onModeChange={(enabled) => void saveDeveloperMode(enabled)}
            localClientDllSaving={localClientDllSaving}
            localClientDllError={localClientDllError}
            onLocalClientDllChange={(enabled) => void saveLocalClientDll(enabled)}
          />
        )}

        {tab === 'diagnostics' && <DiagnosticsTab state={state} settings={draft} />}

        {tab === 'about' && <AboutTab state={state} />}

        {tab !== 'diagnostics' &&
          tab !== 'patches' &&
          tab !== 'dlcs' &&
          tab !== 'profiles' &&
          tab !== 'info' &&
          tab !== 'account' &&
          tab !== 'about' &&
          dirty && (
          <footer className={styles.saveBar}>
            <span className={saveError ? styles.invalid : styles.saveState}>
              {saveError ?? 'Unsaved changes'}
            </span>
            <button
              className={styles.saveButton}
              disabled={
                saving ||
                mapSaving ||
                uiScaleSaving ||
                developerModeSaving ||
                gameClientPatchSaving ||
                dlcSaving !== null ||
                localClientDllSaving
              }
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save & Re-check'}
            </button>
          </footer>
        )}
      </div>

      {pendingNavigation && (
        <div className={styles.confirmBackdrop}>
          <section
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-title"
            aria-describedby="unsaved-description"
          >
            <span className={styles.confirmEyebrow}>Unsaved configuration</span>
            <h2 id="unsaved-title">Save your changes?</h2>
            <p id="unsaved-description">
              You have changes that have not been saved. Save them before leaving this page?
            </p>
            {saveError && <p className={styles.confirmError}>{saveError}</p>}
            <div className={styles.confirmActions}>
              <button
                disabled={saving || discarding || mapSaving || uiScaleSaving}
                onClick={() => setPendingNavigation(null)}
              >
                Cancel
              </button>
              <button
                className={styles.discardButton}
                disabled={saving || discarding || mapSaving || uiScaleSaving}
                onClick={() => void discardAndNavigate()}
              >
                {discarding ? 'Discarding…' : "Don't save"}
              </button>
              <button
                autoFocus
                className={styles.confirmSaveButton}
                disabled={saving || discarding || mapSaving || uiScaleSaving}
                onClick={() => void saveAndNavigate()}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
});

export default Settings;

type ProfileConfirmation = { kind: 'update' | 'delete'; id: string };

function profileSavedLabel(profile: GameProfileSummary): string {
  const saved = new Date(profile.updatedAt);
  if (!Number.isFinite(saved.getTime())) return 'Saved configuration';
  return `Saved ${saved.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })} at ${saved.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function ProfilesTab({ state }: { state: LauncherState }): JSX.Element {
  const [newName, setNewName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [action, setAction] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirmation, setConfirmation] = useState<ProfileConfirmation | null>(null);
  const profilesLocked = state.activeGameInstances > 0;
  const launcherBusy =
    action !== null ||
    state.phase === 'checking' ||
    state.phase === 'launching' ||
    state.launchCoolingDown ||
    state.launcherUpdate === 'downloading' ||
    state.launcherUpdate === 'installing';
  const controlsDisabled = profilesLocked || launcherBusy;
  const createNameError = newName ? validateGameProfileName(newName) : null;
  const profileLimitReached = state.gameProfiles.length >= MAX_GAME_PROFILES;

  useEffect(() => {
    setNames((current) =>
      Object.fromEntries(
        state.gameProfiles.map((profile) => [profile.id, current[profile.id] ?? profile.name])
      )
    );
  }, [state.gameProfiles]);

  const runAction = async (
    key: string,
    operation: () => Promise<ActionResult>
  ): Promise<ActionResult | null> => {
    if (controlsDisabled || actionInFlight.current) return null;
    actionInFlight.current = true;
    setAction(key);
    setResult(null);
    try {
      const next = await operation();
      setResult(next);
      return next;
    } catch (error) {
      const failure = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
      setResult(failure);
      return failure;
    } finally {
      actionInFlight.current = false;
      setAction(null);
    }
  };

  const createProfile = async (): Promise<void> => {
    const validationError = validateGameProfileName(newName);
    if (validationError || profileLimitReached || !state.gamePathValid) {
      setResult({
        ok: false,
        message:
          validationError ??
          (profileLimitReached
            ? `You can save up to ${MAX_GAME_PROFILES} profiles.`
            : 'Set a valid Global Agenda installation first.')
      });
      return;
    }
    const created = await runAction('create', () => window.api.createGameProfile(newName));
    if (created?.ok) setNewName('');
  };

  const renameProfile = async (profile: GameProfileSummary): Promise<void> => {
    const name = names[profile.id] ?? profile.name;
    const validationError = validateGameProfileName(name);
    if (validationError) {
      setResult({ ok: false, message: validationError });
      return;
    }
    const renamed = await runAction(`rename:${profile.id}`, () =>
      window.api.renameGameProfile(profile.id, name)
    );
    if (renamed?.ok) {
      setNames((current) => ({
        ...current,
        [profile.id]: normalizeGameProfileName(name)
      }));
    } else {
      setNames((current) => ({ ...current, [profile.id]: profile.name }));
    }
  };

  const selectProfile = async (profile: GameProfileSummary): Promise<void> => {
    if (
      profile.id === state.selectedGameProfileId ||
      controlsDisabled ||
      actionInFlight.current
    ) {
      return;
    }
    actionInFlight.current = true;
    setAction(`select:${profile.id}`);
    setResult(null);
    try {
      await window.api.selectGameProfile(profile.id);
      setResult({ ok: true, message: `Profile ${profile.name} is now active.` });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      actionInFlight.current = false;
      setAction(null);
    }
  };

  const confirmProfileAction = async (): Promise<void> => {
    if (!confirmation) return;
    const profile = state.gameProfiles.find((candidate) => candidate.id === confirmation.id);
    if (!profile) {
      setConfirmation(null);
      return;
    }
    const key = `${confirmation.kind}:${profile.id}`;
    const completed = await runAction(key, () =>
      confirmation.kind === 'update'
        ? window.api.updateGameProfile(profile.id)
        : window.api.deleteGameProfile(profile.id)
    );
    if (completed?.ok) setConfirmation(null);
  };

  return (
    <section className={`${styles.section} ${styles.profileSection}`}>
      <div className={styles.profileHeading}>
        <div>
          <div className="panel-title">Game Settings Profiles</div>
          <p className={styles.hint}>
            Save the game&apos;s current graphics, audio, controls, interface, and gameplay
            configuration. The active profile is restored when you press Play, before launcher
            patches and compatibility settings are applied. In-game changes are not saved back
            automatically; close the game and use Update Snapshot when you want to keep them.
          </p>
        </div>
        <span className={styles.profileCapacity}>
          {state.gameProfiles.length} / {MAX_GAME_PROFILES}
        </span>
      </div>

      {profilesLocked && (
        <div className={styles.profileLock} role="status">
          <span className={styles.profileLockSignal} aria-hidden="true" />
          <div>
            <strong>Profiles locked while the game is running</strong>
            <small>
              Close {state.activeGameInstances === 1 ? 'the game instance' : 'all game instances'}
              {' '}started by this launcher before changing saved configurations.
            </small>
          </div>
        </div>
      )}

      <div className={styles.profileCapturePanel}>
        <div className={styles.profileCaptureCopy}>
          <span className={styles.profileEyebrow}>New snapshot</span>
          <strong>Save the settings currently on disk</strong>
          <small>Close the game first so every configuration file is fully written.</small>
        </div>
        <div className={styles.profileCaptureControls}>
          <input
            type="text"
            maxLength={MAX_GAME_PROFILE_NAME_LENGTH}
            value={newName}
            placeholder="Profile name"
            aria-label="New profile name"
            disabled={controlsDisabled || profileLimitReached || !state.gamePathValid}
            onChange={(event) => setNewName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createProfile();
            }}
          />
          <button
            className={styles.profileCreateButton}
            disabled={
              controlsDisabled ||
              profileLimitReached ||
              !state.gamePathValid ||
              !normalizeGameProfileName(newName) ||
              createNameError !== null
            }
            onClick={() => void createProfile()}
          >
            {action === 'create' ? 'Saving…' : 'Save Profile'}
          </button>
        </div>
        {!state.gamePathValid && (
          <span className={styles.profileCaptureNote}>A valid game location is required.</span>
        )}
        {profileLimitReached && (
          <span className={styles.profileCaptureNote}>All five profile slots are in use.</span>
        )}
      </div>

      <div className={styles.gameProfiles}>
        {state.gameProfiles.map((profile, index) => {
          const active = profile.id === state.selectedGameProfileId;
          const name = names[profile.id] ?? profile.name;
          const nameError = validateGameProfileName(name);
          const confirming = confirmation?.id === profile.id ? confirmation.kind : null;
          return (
            <article
              className={`${styles.gameProfile} ${active ? styles.gameProfileActive : ''}`}
              key={profile.id}
            >
              <div className={styles.gameProfileIndex}>{String(index + 1).padStart(2, '0')}</div>
              <div className={styles.gameProfileBody}>
                <div className={styles.gameProfileTitleRow}>
                  <span>{active ? 'Active profile' : `Profile ${index + 1}`}</span>
                  {active && <span className={styles.gameProfileActiveBadge}>Selected</span>}
                </div>
                <div className={styles.gameProfileNameRow}>
                  <input
                    type="text"
                    maxLength={MAX_GAME_PROFILE_NAME_LENGTH}
                    value={name}
                    aria-label={`Name for profile ${index + 1}`}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setNames((current) => ({
                        ...current,
                        [profile.id]: event.currentTarget.value
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void renameProfile(profile);
                    }}
                  />
                  <button
                    disabled={
                      controlsDisabled ||
                      nameError !== null ||
                      normalizeGameProfileName(name) === profile.name
                    }
                    onClick={() => void renameProfile(profile)}
                  >
                    {action === `rename:${profile.id}` ? 'Saving…' : 'Save Name'}
                  </button>
                </div>
                <div className={styles.gameProfileMeta}>
                  <span>
                    {profile.fileCount} configuration {profile.fileCount === 1 ? 'file' : 'files'}
                  </span>
                  <span aria-hidden="true">/</span>
                  <span>{profileSavedLabel(profile)}</span>
                </div>
                {confirming && (
                  <div
                    className={styles.profileInlineConfirm}
                    role="group"
                    aria-label={
                      confirming === 'update'
                        ? `Update ${profile.name} snapshot`
                        : `Remove ${profile.name}`
                    }
                  >
                    <span>
                      {confirming === 'update'
                        ? 'Replace this snapshot with the current game settings?'
                        : `Permanently remove ${profile.name}?`}
                    </span>
                    <div>
                      <button disabled={action !== null} onClick={() => setConfirmation(null)}>
                        Cancel
                      </button>
                      <button
                        className={
                          confirming === 'delete'
                            ? styles.profileDeleteConfirm
                            : styles.profileUpdateConfirm
                        }
                        disabled={action !== null}
                        onClick={() => void confirmProfileAction()}
                      >
                        {action === `${confirming}:${profile.id}`
                          ? confirming === 'update'
                            ? 'Updating…'
                            : 'Removing…'
                          : confirming === 'update'
                            ? 'Replace Snapshot'
                            : 'Remove Profile'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.gameProfileActions}>
                <button
                  className={styles.profileSelectButton}
                  disabled={controlsDisabled || active}
                  onClick={() => void selectProfile(profile)}
                >
                  {action === `select:${profile.id}` ? 'Selecting…' : active ? 'Active' : 'Make Active'}
                </button>
                <button
                  disabled={controlsDisabled || confirmation !== null}
                  onClick={() => setConfirmation({ kind: 'update', id: profile.id })}
                >
                  Update Snapshot
                </button>
                <button
                  className={styles.profileRemoveButton}
                  disabled={controlsDisabled || confirmation !== null}
                  onClick={() => setConfirmation({ kind: 'delete', id: profile.id })}
                >
                  Remove
                </button>
              </div>
            </article>
          );
        })}

        {state.gameProfiles.length === 0 && (
          <div className={styles.emptyProfiles}>
            <span className={styles.emptyProfilesIndex}>01—05</span>
            <strong>No saved profiles</strong>
            <small>Close the game, choose a name above, and save your current settings.</small>
          </div>
        )}
      </div>

      {result && (
        <p className={result.ok ? styles.valid : styles.invalid} role="status">
          {result.message}
        </p>
      )}
    </section>
  );
}

function ServersTab({
  settings,
  edit
}: {
  settings: SettingsModel;
  edit: (fn: (settings: SettingsModel) => SettingsModel) => void;
}): JSX.Element {
  const customServers = settings.servers.custom;
  const hasIncompleteServer = customServers.some(
    (server) => !server.name.trim() || !server.host.trim()
  );

  const addServer = (): void => {
    if (customServers.length >= MAX_CUSTOM_SERVERS || hasIncompleteServer) return;
    edit((current) => {
      if (
        current.servers.custom.length >= MAX_CUSTOM_SERVERS ||
        current.servers.custom.some((server) => !server.name.trim() || !server.host.trim())
      ) {
        return current;
      }
      return {
        ...current,
        servers: {
          ...current.servers,
          custom: [
            ...current.servers.custom,
            { id: crypto.randomUUID(), name: '', host: '' }
          ]
        }
      };
    });
  };

  const removeServer = (id: string): void => {
    edit((current) => ({
      ...current,
      servers: {
        ...current.servers,
        selectedServerId:
          current.servers.selectedServerId === id
            ? DEFAULT_SERVER_ID
            : current.servers.selectedServerId,
        custom: current.servers.custom.filter((server) => server.id !== id)
      }
    }));
  };

  return (
    <section className={styles.section}>
      <div className="panel-title">Servers</div>
      <p className={styles.hint}>
        Rename the built-in server or add other servers to choose from before launching.
      </p>

      <div className={styles.serverProfiles}>
        <article className={`${styles.serverProfile} ${styles.builtInServerProfile}`}>
          <span className={styles.serverProfileIndex}>01</span>
          <div className={styles.serverProfileFields}>
            <label>
              <span>Name</span>
              <input
                type="text"
                maxLength={48}
                value={settings.servers.builtInName}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    servers: { ...current.servers, builtInName: event.target.value }
                  }))
                }
              />
            </label>
            <div className={styles.serverManagedField}>
              <span>Address</span>
              <input
                type="text"
                value="Managed by Launcher"
                disabled
                aria-label="Built-in server address managed by launcher"
              />
            </div>
          </div>
        </article>

        {customServers.map((server, index) => (
          <article className={styles.serverProfile} key={server.id}>
            <span className={styles.serverProfileIndex}>
              {String(index + 2).padStart(2, '0')}
            </span>
            <div className={styles.serverProfileFields}>
              <label>
                <span>Name</span>
                <input
                  type="text"
                  maxLength={48}
                  value={server.name}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      servers: {
                        ...current.servers,
                        custom: current.servers.custom.map((candidate) =>
                          candidate.id === server.id
                            ? { ...candidate, name: event.target.value }
                            : candidate
                        )
                      }
                    }))
                  }
                />
              </label>
              <label>
                <span>IP Address or Hostname</span>
                <input
                  type="text"
                  value={server.host}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      servers: {
                        ...current.servers,
                        custom: current.servers.custom.map((candidate) =>
                          candidate.id === server.id
                            ? { ...candidate, host: event.target.value }
                            : candidate
                        )
                      }
                    }))
                  }
                />
              </label>
            </div>
            <button
              className={styles.removeServerButton}
              aria-label={`Remove ${server.name || `server ${index + 2}`}`}
              onClick={() => removeServer(server.id)}
            >
              Remove
            </button>
          </article>
        ))}

        {customServers.length === 0 && (
          <p className={styles.emptyServers}>No additional servers added.</p>
        )}
      </div>

      <button
        className={styles.addServerButton}
        disabled={customServers.length >= MAX_CUSTOM_SERVERS || hasIncompleteServer}
        title={
          hasIncompleteServer
            ? 'Finish or remove the current server before adding another.'
            : undefined
        }
        onClick={addServer}
      >
        + Add Server
      </button>
    </section>
  );
}

function DxvkVulkanPanel({
  state,
  settings,
  edit
}: {
  state: LauncherState;
  settings: SettingsModel;
  edit: (fn: (settings: SettingsModel) => SettingsModel) => void;
}): JSX.Element {
  const rendererLabel =
    state.dxvk.rendererSetting === 'directx-10'
      ? 'DirectX 10 — Switches Automatically'
      : state.dxvk.rendererSetting === 'directx-9'
        ? 'DirectX 9'
        : 'Not Detected — Will Configure';
  const detail =
    state.dxvk.rendererSetting === 'directx-10' &&
    state.dxvk.status !== 'needs-restore' &&
    state.dxvk.status !== 'error'
      ? 'DirectX 10 is temporarily disabled while DXVK/Vulkan is enabled and restored when disabled.'
      : state.dxvk.rendererSetting === 'unknown' && state.dxvk.status !== 'error'
        ? 'The launcher preserves the current renderer state before configuring DXVK/Vulkan.'
        : state.dxvk.detail;
  const statusLabel: Record<LauncherState['dxvk']['status'], string> = {
    unsupported: 'Windows Only',
    native: 'Native Direct3D',
    preparing: 'Preparing DXVK/Vulkan',
    active: `DXVK/Vulkan ${state.dxvk.version} Active`,
    external: 'Existing Graphics Wrapper',
    'needs-restore': 'Recovery Required',
    error: 'Inspection Failed'
  };

  return (
    <>
      <div className="panel-title">Graphics Renderer</div>
      <div
        className={`${styles.dxvkPanel} ${
          state.dxvk.status === 'needs-restore' || state.dxvk.status === 'error'
            ? styles.dxvkProblem
            : state.dxvk.status === 'active'
              ? styles.dxvkActive
              : ''
        }`}
      >
        <div className={styles.featureToggle}>
          <input
            id="developer-dxvk-vulkan"
            type="checkbox"
            checked={settings.developer.useDxvk}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                developer: { ...current.developer, useDxvk: event.target.checked }
              }))
            }
          />
          <label htmlFor="developer-dxvk-vulkan">
            <span className={styles.featureName}>Enable Experimental DXVK/Vulkan</span>
            <span className={styles.featureDetail}>
              Uses Vulkan for all game launches. Depending on hardware and drivers, it may improve
              performance by roughly 10–40%, reduce CPU overhead and stuttering, and improve
              stability.
            </span>
          </label>
        </div>
        <div className={styles.dxvkReadout}>
          <div>
            <span>Game Setting</span>
            <strong>{rendererLabel}</strong>
          </div>
          <div>
            <span>Graphics Files</span>
            <strong>{statusLabel[state.dxvk.status]}</strong>
          </div>
        </div>
        <p className={styles.dxvkDetail}>{detail}</p>
        <p className={styles.dxvkDriverTip}>
          <strong>Driver Tip</strong>
          If the game does not launch correctly with DXVK/Vulkan enabled, update your GPU drivers
          and try again.
        </p>
      </div>
    </>
  );
}

type GameClientDllNoticeTone = 'active' | 'managed' | 'warning' | 'error' | 'idle';

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

export function GameClientDllStatusPanel({
  dll,
  localMode
}: {
  dll: LauncherState['gameClientDll'];
  localMode: boolean;
}): JSX.Element {
  const copy = gameClientDllNoticeCopy(dll, localMode);
  const toneClass: Record<GameClientDllNoticeTone, string> = {
    active: styles.clientDllActive,
    managed: styles.clientDllManaged,
    warning: styles.clientDllWarning,
    error: styles.clientDllError,
    idle: styles.clientDllIdle
  };
  return (
    <div
      className={`${styles.clientDllState} ${toneClass[copy.tone]}`}
      data-tone={copy.tone}
      aria-live="polite"
    >
      <span className={styles.clientDllStateLabel}>{copy.label}</span>
      <div className={styles.clientDllStateBody}>
        <strong>{copy.title}</strong>
        <p>{copy.detail}</p>
      </div>
    </div>
  );
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

function DeveloperTab({
  state,
  settings,
  edit,
  modeSaving,
  modeError,
  onModeChange,
  localClientDllSaving,
  localClientDllError,
  onLocalClientDllChange
}: {
  state: LauncherState;
  settings: SettingsModel;
  edit: (fn: (settings: SettingsModel) => SettingsModel) => void;
  modeSaving: boolean;
  modeError: string | null;
  onModeChange: (enabled: boolean) => void;
  localClientDllSaving: boolean;
  localClientDllError: string | null;
  onLocalClientDllChange: (enabled: boolean) => void;
}): JSX.Element {
  return (
    <section className={styles.section}>
      <div className="panel-title">Developer Mode</div>
      <div className={`${styles.featureToggle} ${styles.developerToggle}`}>
        <input
          id="developer-mode"
          type="checkbox"
          checked={settings.developer.enabled}
          disabled={modeSaving}
          onChange={(event) => onModeChange(event.target.checked)}
        />
        <label htmlFor="developer-mode">
          <span className={styles.featureName}>Enable Developer Mode</span>
          <span className={styles.featureDetail}>
            Allows multiple game instances and enables Dev Launch display settings.
          </span>
        </label>
      </div>
      {modeError && <p className={styles.invalid}>{`Could not save Developer mode: ${modeError}`}</p>}

      {settings.developer.enabled && (
        <>
          <div className="panel-title">Dev Launch Display</div>
          <div className={styles.developerDisplayGrid}>
            <div className={styles.featureToggle}>
              <input
                id="developer-windowed"
                type="checkbox"
                checked={settings.developer.windowed}
                onChange={(event) =>
                  edit((current) => ({
                    ...current,
                    developer: { ...current.developer, windowed: event.target.checked }
                  }))
                }
              />
              <label htmlFor="developer-windowed">
                <span className={styles.featureName}>Windowed Mode</span>
                <span className={styles.featureDetail}>
                  Dev Launch uses a movable window instead of fullscreen.
                </span>
              </label>
            </div>
            <div className={styles.developerResolution}>
              <label>
                <span>Width</span>
                <input
                  type="number"
                  min={DEVELOPER_MIN_WIDTH}
                  max={DEVELOPER_MAX_WIDTH}
                  step={1}
                  value={settings.developer.resolutionWidth}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      developer: {
                        ...current.developer,
                        resolutionWidth: Number.parseInt(event.target.value, 10) || 0
                      }
                    }))
                  }
                />
              </label>
              <span className={styles.resolutionBy}>×</span>
              <label>
                <span>Height</span>
                <input
                  type="number"
                  min={DEVELOPER_MIN_HEIGHT}
                  max={DEVELOPER_MAX_HEIGHT}
                  step={1}
                  value={settings.developer.resolutionHeight}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      developer: {
                        ...current.developer,
                        resolutionHeight: Number.parseInt(event.target.value, 10) || 0
                      }
                    }))
                  }
                />
              </label>
            </div>
          </div>

          {state.platform === 'win32' && (
            <DxvkVulkanPanel state={state} settings={settings} edit={edit} />
          )}

          <div className="panel-title">Local Client Patch Testing</div>
          <div className={styles.featureToggle}>
            <input
              id="developer-local-client-dll"
              type="checkbox"
              checked={settings.developer.useLocalClientDll}
              disabled={
                localClientDllSaving ||
                state.phase === 'launching' ||
                state.launchCoolingDown
              }
              onChange={(event) => onLocalClientDllChange(event.target.checked)}
            />
            <label htmlFor="developer-local-client-dll">
              <span className={styles.featureName}>Use Local Client DLL Override</span>
              <span className={styles.featureDetail}>
                Validates and uses a developer-supplied 32-bit x86 dinput8.dll for every launch.
                This is separate from the managed Game Client Patch, and the launcher never changes
                or removes the local file.
              </span>
            </label>
          </div>
          <GameClientDllStatusPanel
            dll={state.gameClientDll}
            localMode={settings.developer.useLocalClientDll}
          />
          {localClientDllError && (
            <p className={styles.invalid}>{`Could not change the local client DLL: ${localClientDllError}`}</p>
          )}

        </>
      )}
    </section>
  );
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

export function PatchEnabledCheck({ enabled }: { enabled: boolean }): JSX.Element | null {
  if (!enabled) return null;
  return (
    <span className={styles.patchEnabledCheck} role="img" aria-label="Patch enabled">
      ✓
    </span>
  );
}

function PatchesTab({
  state,
  settings,
  gameClientPatchSaving,
  gameClientPatchError,
  onGameClientPatchChange,
  onPatchPreferenceChange
}: {
  state: LauncherState;
  settings: SettingsModel;
  gameClientPatchSaving: boolean;
  gameClientPatchError: string | null;
  onGameClientPatchChange: (enabled: boolean) => void;
  onPatchPreferenceChange: (id: ClientPatchStatus['id'], enabled: boolean) => void;
}): JSX.Element {
  const [changing, setChanging] = useState<{
    id: ClientPatchStatus['id'];
    enabled: boolean;
  } | null>(null);
  const [resultError, setResultError] = useState<
    { id: ClientPatchStatus['id']; message: string } | null
  >(null);

  const changePatch = async (
    id: ClientPatchStatus['id'],
    enabled: boolean
  ): Promise<void> => {
    if (changing || gameClientPatchSaving) return;
    setChanging({ id, enabled });
    setResultError(null);
    try {
      const value = enabled
        ? await window.api.applyClientPatch(id)
        : await window.api.removeClientPatch(id);
      const message = manualPatchErrorMessage(value);
      setResultError(message ? { id, message } : null);
      if (value.ok) onPatchPreferenceChange(id, enabled);
    } catch (error) {
      setResultError({
        id,
        message:
          `Could not ${enabled ? 'apply' : 'remove'} patch: ` +
          (error instanceof Error ? error.message : String(error))
      });
    } finally {
      setChanging(null);
    }
  };

  const gameClientPatchEnabled = settings.patches.gameClientPatch;
  const gameClientPatch = gameClientPatchPresentation(
    gameClientPatchEnabled,
    settings.developer.useLocalClientDll,
    state.gameClientDll
  );
  const gameClientPatchTone =
    gameClientPatch.tone === 'applied'
      ? styles.patchApplied
      : gameClientPatch.tone === 'pending'
        ? styles.patchPending
        : styles.patchUnknown;
  const gameClientPatchBusy =
    gameClientPatchSaving ||
    changing !== null ||
    state.phase === 'launching' ||
    state.launchCoolingDown;
  return (
    <section className={styles.section}>
      <div className="panel-title">Game Patches</div>
      <p className={styles.hint}>
        All patches are enabled by default. Apply or remove each one independently to compare the
        game with and without it; your choice is kept for future launches.
      </p>
      <div className={styles.patchList}>
        <article className={`${styles.patchCard} ${gameClientPatchTone}`}>
          <button
            className={`${styles.patchIcon} ${styles.patchApplyButton} ${
              gameClientPatch.actionLabel === 'REMOVE' ? styles.patchRemoveButton : ''
            } ${
              gameClientPatch.actionDisabled ? styles.patchBlockedButton : ''
            }`}
            disabled={gameClientPatchBusy || gameClientPatch.actionDisabled}
            aria-label={gameClientPatch.actionTitle}
            title={
              state.phase === 'launching' || state.launchCoolingDown
                ? 'Wait for launch to finish.'
                : gameClientPatch.actionTitle
            }
            onClick={() => onGameClientPatchChange(gameClientPatch.nextPreference)}
          >
            {gameClientPatchSaving ? '…' : gameClientPatch.actionLabel}
          </button>
          <div className={styles.patchBody}>
            <div className={styles.patchTitle}>Game Client Patch</div>
            <p className={styles.patchDescription}>
              Installs and owns the verified release DLL, then checks for updates on Play. Local
              DLLs remain untouched only while Local DLL Override is enabled.
            </p>
            <GameClientDllStatusPanel
              dll={state.gameClientDll}
              localMode={settings.developer.useLocalClientDll}
            />
            <div className={styles.patchFixDetails}>
              <div className={styles.patchFixHeader}>
                <span>Current fixes</span>
                <span>1 shipped fix</span>
              </div>
              <ul className={styles.patchFixList}>
                <li>
                  <span className={styles.patchFixIndex} aria-hidden="true">
                    01
                  </span>
                  <span className={styles.patchFixCopy}>
                    <strong>Smoother scope transitions</strong>
                    <small>Fixes client stutters when scoping in or out.</small>
                  </span>
                </li>
              </ul>
            </div>
            {gameClientPatchError && (
              <p className={styles.patchResultError}>
                {`Could not change Game Client Patch: ${gameClientPatchError}`}
              </p>
            )}
          </div>
          <PatchEnabledCheck enabled={gameClientPatch.enabled} />
        </article>

        {state.clientPatches.map((patch) => {
          const copy = PATCH_COPY[patch.id];
          const preferenceKey =
            patch.id === 'high-fps-movement-stability'
              ? 'highFpsMovementStability'
              : 'adaptiveClientPerformance';
          const preferred = settings.patches[preferenceKey];
          const patchChanging = changing?.id === patch.id;
          const presentation = iniPatchCardPresentation(preferred, patch.applied);
          const tone =
            presentation.tone === 'applied'
              ? styles.patchApplied
              : presentation.tone === 'pending'
                ? styles.patchPending
                : styles.patchUnknown;
          return (
            <article key={patch.id} className={`${styles.patchCard} ${tone}`}>
              <button
                className={`${styles.patchIcon} ${styles.patchApplyButton} ${
                  presentation.actionLabel === 'REMOVE' ? styles.patchRemoveButton : ''
                }`}
                disabled={changing !== null || gameClientPatchSaving || state.launchCoolingDown}
                aria-label={`${presentation.actionLabel === 'REMOVE' ? 'Remove' : 'Apply'} ${copy.title} patch`}
                title={
                  state.launchCoolingDown
                    ? 'Wait for launch to finish.'
                    : `${presentation.actionLabel === 'REMOVE' ? 'Remove' : 'Apply'} patch`
                }
                onClick={() => void changePatch(patch.id, presentation.nextPreference)}
              >
                {patchChanging ? '…' : presentation.actionLabel}
              </button>
              <div className={styles.patchBody}>
                <div className={styles.patchTitle}>{copy.title}</div>
                <p className={styles.patchDescription}>{copy.description}</p>
                {resultError?.id === patch.id && (
                  <p className={styles.patchResultError}>{resultError.message}</p>
                )}
              </div>
              <PatchEnabledCheck enabled={presentation.enabled} />
            </article>
          );
        })}
      </div>
    </section>
  );
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

export function DlcOperationProgress({
  status,
  progressPhase,
  progressPercent
}: Pick<DlcStatus, 'status' | 'progressPhase' | 'progressPercent'>): JSX.Element | null {
  if (status !== 'installing' && status !== 'removing') return null;
  const determinate = typeof progressPercent === 'number' && progressPercent >= 0;
  const percent = determinate
    ? Math.min(100, Math.max(0, Math.round(progressPercent)))
    : -1;
  const operation =
    progressPhase === 'download'
      ? 'Downloading DLC'
      : status === 'removing'
        ? 'Removing DLC'
        : 'Installing DLC';
  return (
    <div className={styles.dlcProgress}>
      <div
        className={styles.dlcProgressTrack}
        role="progressbar"
        aria-label={operation}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
      >
        <span
          className={`${styles.dlcProgressFill} ${
            determinate ? '' : styles.dlcProgressIndeterminate
          }`}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      <span className={styles.dlcProgressLabel}>
        {determinate ? `${percent}%` : 'WORKING'}
      </span>
    </div>
  );
}

export function DlcEnabledCheck({ enabled }: { enabled: boolean }): JSX.Element | null {
  if (!enabled) return null;
  return (
    <span className={styles.patchEnabledCheck} role="img" aria-label="DLC installed">
      ✓
    </span>
  );
}

type ChatCommandCopyState = 'idle' | 'copying' | 'copied' | 'failed';

export function ChatCommandCopy({
  command,
  detail
}: {
  command: string;
  detail?: string;
}): JSX.Element {
  const [copyState, setCopyState] = useState<ChatCommandCopyState>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    []
  );

  const copyCommand = async (): Promise<void> => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    setCopyState('copying');
    try {
      const result = await window.api.copyChatCommand(command);
      setCopyState(result.ok ? 'copied' : 'failed');
    } catch {
      setCopyState('failed');
    }
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      setCopyState('idle');
    }, 1_600);
  };

  const feedback =
    copyState === 'copying'
      ? 'COPYING'
      : copyState === 'copied'
        ? 'COPIED'
        : copyState === 'failed'
          ? 'FAILED'
          : 'COPY';

  return (
    <button
      type="button"
      className={`${styles.chatCommandCopy} ${
        copyState === 'copied'
          ? styles.chatCommandCopied
          : copyState === 'failed'
            ? styles.chatCommandFailed
            : ''
      }`}
      data-copy-state={copyState}
      aria-busy={copyState === 'copying'}
      aria-label={`Copy ${command} to clipboard`}
      title={
        copyState === 'copied'
          ? 'Copied to clipboard'
          : copyState === 'failed'
            ? 'Could not copy command'
            : 'Copy command to clipboard'
      }
      onClick={() => void copyCommand()}
    >
      <span className={styles.chatCommandText}>
        <code>{command}</code>
        {detail && <small>{detail}</small>}
      </span>
      <span className={styles.chatCommandCopyState} aria-live="polite">
        {feedback}
      </span>
    </button>
  );
}

export function DlcActivationTip({ id }: { id: DlcId }): JSX.Element {
  return (
    <div className={styles.dlcActivationTip}>
      <div className={styles.dlcActivationIntro}>
        <span>In-game map access</span>
        <p>
          Install controls the files. Use these chat commands to include or exclude this pack's
          maps from matchmaking.
        </p>
      </div>
      <div className={styles.dlcActivationCommands}>
        <ChatCommandCopy command={`-enabledlc ${id}`} detail="Include these maps in matchmaking" />
        <ChatCommandCopy
          command={`-disabledlc ${id}`}
          detail="Exclude these maps from matchmaking"
        />
      </div>
    </div>
  );
}

function DlcsTab({
  state,
  settings,
  saving,
  error,
  onChange
}: {
  state: LauncherState;
  settings: SettingsModel;
  saving: DlcId | null;
  error: { id: DlcId; message: string } | null;
  onChange: (id: DlcId, enabled: boolean) => void;
}): JSX.Element {
  const activeGame = state.activeGameInstances > 0;
  return (
    <section className={`${styles.section} ${styles.dlcSection}`}>
      <div className="panel-title">Optional Game Content</div>
      <p className={styles.hint}>
        DLC downloads are enabled by default. The launcher verifies their exact files at startup
        and before every Play, while your Remove choice prevents automatic reinstallation. Install
        and Remove manage local files; the chat commands on each card control whether its maps can
        be selected in-game.
      </p>

      <div className={styles.patchList}>
        {state.dlcs.map((dlc) => {
          const definition = LAUNCHER_CONFIG.dlcs.find((candidate) => candidate.id === dlc.id);
          const preferred = settings.dlcs[DLC_SETTING_KEY_BY_ID[dlc.id]];
          const presentation = dlcCardPresentation(preferred, dlc.status);
          const operationBusy = dlc.status === 'installing' || dlc.status === 'removing';
          const operationStatusLabel =
            dlc.progressPhase === 'download'
              ? 'DOWNLOADING'
              : dlc.progressPhase === 'install'
                ? 'INSTALLING'
                : dlc.progressPhase === 'remove'
                  ? 'REMOVING'
                  : presentation.statusLabel;
          const tone =
            presentation.tone === 'installed'
              ? styles.patchApplied
              : presentation.tone === 'pending'
                ? styles.patchPending
                : presentation.tone === 'problem'
                  ? styles.dlcProblem
                  : styles.patchUnknown;
          const busy =
            saving !== null ||
            state.phase === 'launching' ||
            state.launchCoolingDown ||
            activeGame;
          const actionDisabled = busy || presentation.actionDisabled;
          const actionTitle =
            activeGame
              ? 'Close the game before changing installed DLCs.'
              : dlc.status === 'modified'
                ? 'A target file differs from this DLC and was left untouched.'
                : dlc.status === 'unavailable'
                  ? 'Set a valid game location first.'
                  : `${presentation.actionLabel === 'REMOVE' ? 'Remove' : 'Install'} ${dlc.name}`;
          const downloadSize = definition
            ? `${(definition.archiveSize / (1024 * 1024)).toFixed(1)} MiB download`
            : 'Verified download';
          const installLocation = definition?.files.some(
            (file) => 'targetRoot' in file && file.targetRoot === 'binaries'
          )
            ? 'CookedPC + Binaries'
            : 'CookedPC / DLC / Maps';

          return (
            <article
              key={dlc.id}
              className={`${styles.patchCard} ${styles.dlcCard} ${tone}`}
              aria-busy={saving === dlc.id || operationBusy}
            >
              <button
                className={`${styles.patchIcon} ${styles.patchApplyButton} ${
                  presentation.actionLabel === 'REMOVE' ? styles.patchRemoveButton : ''
                }`}
                disabled={actionDisabled}
                aria-label={actionTitle}
                title={actionTitle}
                onClick={() => onChange(dlc.id, presentation.nextPreference)}
              >
                {saving === dlc.id || operationBusy
                  ? '…'
                  : presentation.actionLabel}
              </button>

              <div className={styles.patchBody}>
                <div className={styles.dlcHeading}>
                  <div>
                    <span className={styles.dlcEyebrow}>
                      {definition?.mode ?? 'Map'} map pack // optional
                    </span>
                    <div className={styles.patchTitle}>{dlc.name}</div>
                  </div>
                  <span className={styles.dlcFileCount}>
                    {(definition?.mapCount ?? 0).toString().padStart(2, '0')}{' '}
                    {definition?.mapCount === 1 ? 'map' : 'maps'} ·{' '}
                    {dlc.totalFiles.toString().padStart(2, '0')}{' '}
                    {dlc.totalFiles === 1 ? 'file' : 'files'}
                  </span>
                </div>
                <p className={styles.patchDescription}>
                  {definition?.description ?? 'Additional verified game content.'}
                </p>

                <div
                  className={`${styles.dlcStatusPanel} ${
                    presentation.enabled
                      ? styles.dlcStatusInstalled
                      : presentation.tone === 'problem'
                        ? styles.dlcStatusProblem
                        : presentation.tone === 'pending'
                          ? styles.dlcStatusPending
                          : ''
                  }`}
                >
                  <div className={styles.dlcStatusReadout}>
                    <span>{operationStatusLabel}</span>
                    <strong>
                      {dlc.installedFiles}/{dlc.totalFiles}
                    </strong>
                  </div>
                  <p>{dlc.detail}</p>
                  <DlcOperationProgress
                    status={dlc.status}
                    progressPhase={dlc.progressPhase}
                    progressPercent={dlc.progressPercent}
                  />
                </div>

                <DlcActivationTip id={dlc.id} />

                <div className={styles.dlcMetaStrip}>
                  <span>{downloadSize}</span>
                  <code>{installLocation}</code>
                </div>

                {error?.id === dlc.id && (
                  <p className={styles.patchResultError}>{error.message}</p>
                )}
              </div>
              <DlcEnabledCheck enabled={presentation.enabled} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function InfoTab(): JSX.Element {
  return (
    <section
      className={`${styles.section} ${styles.infoSection}`}
      aria-labelledby="player-info-title"
    >
      <header className={styles.infoHero}>
        <div className={styles.infoHeroCopy}>
          <span className={styles.infoEyebrow}>Player field guide // quick reference</span>
          <h1 id="player-info-title">Useful info before you play</h1>
          <p>Fast answers for performance, graphics, first login, and useful in-game commands.</p>
        </div>
        <div className={styles.infoReadout} aria-label="Four guide entries">
          <strong>04</strong>
          <span>Guide entries</span>
        </div>
      </header>

      <div className={styles.infoFaqGrid}>
        <article className={`${styles.infoCard} ${styles.infoPerformance}`}>
          <div className={styles.infoCardHead}>
            <span className={styles.infoIndex}>Q01</span>
            <span className={styles.infoTopic}>Performance</span>
          </div>
          <h2>Why does the game stutter on fast hardware?</h2>
          <p>
            Global Agenda&apos;s older engine can stutter even when your hardware has plenty of
            headroom. The game itself can be the bottleneck, not your PC.
          </p>
          <div className={styles.infoRecommendation}>
            <span>Try this first</span>
            <strong>Disable “High Character Detail” in the in-game graphics settings.</strong>
            <small>
              If stuttering remains, lower the other graphics options until frame pacing improves.
            </small>
          </div>
        </article>

        <article className={`${styles.infoCard} ${styles.infoRenderer}`}>
          <div className={styles.infoCardHead}>
            <span className={styles.infoIndex}>Q02</span>
            <span className={styles.infoTopic}>Graphics</span>
          </div>
          <h2>Should I use DirectX 9 or DirectX 10?</h2>
          <p>
            Select DirectX 9 instead of DirectX 10 in the in-game graphics settings. DX9 is the
            more stable renderer for this game and should be your default choice.
          </p>
          <div className={styles.infoRendererReadout}>
            <span>Recommended renderer</span>
            <strong>DirectX 9</strong>
            <small>Preferred for game stability</small>
          </div>
        </article>

        <article className={`${styles.infoCard} ${styles.infoAccount}`}>
          <div className={styles.infoCardHead}>
            <span className={styles.infoIndex}>Q03</span>
            <span className={styles.infoTopic}>Account</span>
          </div>
          <h2>How do I register an in-game account?</h2>
          <p className={styles.infoAccountIntro}>
            There is no separate registration form. Your account is created automatically the
            first time you log in.
          </p>
          <ol className={styles.infoSteps}>
            <li>
              <span>01</span>
              <div>
                <strong>Choose your account name</strong>
                <p>
                  It also becomes your visible display name. Special characters are not allowed.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Enter the password you want to keep</strong>
                <p>Your first-login password becomes the password for future login attempts.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Use the same details next time</strong>
                <p>
                  Return with that account name and the password you entered on your first login.
                </p>
              </div>
            </li>
          </ol>
        </article>

        <article className={`${styles.infoCard} ${styles.infoCommands}`}>
          <div className={styles.infoCardHead}>
            <span className={styles.infoIndex}>Q04</span>
            <span className={styles.infoTopic}>In-game chat</span>
          </div>
          <h2>Which commands can I use in chat?</h2>
          <p>
            Select any command to copy it, then paste it into the in-game chat. A value of 1
            explicitly enables an option; 0 explicitly disables it.
          </p>

          <div className={styles.infoCommandList}>
            <div className={styles.infoCommand}>
              <div className={styles.infoCommandIdentity}>
                <ChatCommandCopy command="-togglesolomode" />
                <span>Mission queue</span>
              </div>
              <div className={styles.infoCommandBody}>
                <p>
                  Run this before queueing to guarantee a solo mission. Without a number it toggles
                  the current mode; use an explicit value when you do not want to toggle.
                </p>
                <div className={styles.infoCommandVariants}>
                  <ChatCommandCopy command="-togglesolomode 1" detail="Enable solo mode" />
                  <ChatCommandCopy command="-togglesolomode 0" detail="Disable solo mode" />
                </div>
              </div>
            </div>

            <div className={styles.infoCommand}>
              <div className={styles.infoCommandIdentity}>
                <ChatCommandCopy command="-classes" />
                <span>Team readout</span>
              </div>
              <div className={styles.infoCommandBody}>
                <p>Shows how many players of each class are currently on each side.</p>
              </div>
            </div>

            <section
              className={styles.infoCommandSection}
              aria-labelledby="performance-commands-title"
            >
              <header className={styles.infoCommandSectionHead}>
                <h3 id="performance-commands-title">Performance commands</h3>
                <p>Suit cosmetic controls that may improve performance or reduce stuttering.</p>
              </header>

              <div className={styles.infoCommandSectionList}>
                <div className={styles.infoCommand}>
                  <div className={styles.infoCommandIdentity}>
                    <ChatCommandCopy command="-toggleallsuits" />
                    <span>Other players only</span>
                  </div>
                  <div className={styles.infoCommandBody}>
                    <p>
                      Disables or restores every suit and helmet cosmetic on other players. When
                      disabled, other players appear without suits or helmets, which may improve
                      performance.
                    </p>
                  </div>
                </div>

                <div className={styles.infoCommand}>
                  <div className={styles.infoCommandIdentity}>
                    <ChatCommandCopy command="-togglebrokensuits" />
                    <span>Self + other players</span>
                  </div>
                  <div className={styles.infoCommandBody}>
                    <p>
                      Enables or disables custom unreleased suits on your character and other
                      players. Disabling them may improve performance or fix stuttering issues.
                      This preference is saved per player, so you only need to set it once. Without
                      a number, the command toggles that choice.
                    </p>
                    <div className={styles.infoCommandVariants}>
                      <ChatCommandCopy
                        command="-togglebrokensuits 1"
                        detail="Enable custom unreleased suits"
                      />
                      <ChatCommandCopy
                        command="-togglebrokensuits 0"
                        detail="Disable custom unreleased suits"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <div className={styles.infoCommand}>
              <div className={styles.infoCommandIdentity}>
                <ChatCommandCopy command="-spawnfriend" />
                <span>PvE only</span>
              </div>
              <div className={styles.infoCommandBody}>
                <p>Spawns a friendly AI bot that attacks enemies.</p>
              </div>
            </div>

            <div className={styles.infoCommand}>
              <div className={styles.infoCommandIdentity}>
                <ChatCommandCopy command="-spawnhenchman" />
                <span>PvE only</span>
              </div>
              <div className={styles.infoCommandBody}>
                <p>
                  Spawns a friendly AI bot that attacks enemies, treats you as its leader, and
                  tries to follow you.
                </p>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function AboutTab({ state }: { state: LauncherState }): JSX.Element {
  const updateBusy =
    state.launcherUpdate === 'checking' ||
    state.launcherUpdate === 'downloading' ||
    state.launcherUpdate === 'installing';
  const development = state.launcherUpdate === 'disabled';
  const updateStatus =
    state.launcherUpdate === 'up-to-date'
      ? { text: 'Launcher is up to date.', tone: styles.aboutOk }
      : state.launcherUpdate === 'checking'
        ? { text: 'Checking both stable release channels…', tone: styles.aboutDim }
        : state.launcherUpdate === 'downloading'
          ? {
              text: `Downloading${state.launcherUpdateVersion ? ` v${state.launcherUpdateVersion}` : ' update'}…`,
              tone: styles.aboutWarn
            }
          : state.launcherUpdate === 'installing'
            ? { text: 'Installing update and restarting…', tone: styles.aboutWarn }
            : state.launcherUpdate === 'check-failed'
              ? {
                  text: 'Update check failed. The launcher remains available; try again.',
                  tone: styles.aboutWarn
                }
              : state.launcherUpdate === 'error'
                ? { text: 'Launcher update failed. Try again.', tone: styles.aboutWarn }
              : development
                ? {
                    text: 'Development build — online update checks are disabled.',
                    tone: styles.aboutDim
                  }
                : { text: 'Ready to check for updates.', tone: styles.aboutDim };
  const platform =
    state.platform === 'win32' ? 'Windows' : state.platform === 'linux' ? 'Linux' : 'macOS';
  const checkDisabled = development || updateBusy || state.launchCoolingDown;

  return (
    <section className={styles.section}>
      <div className={styles.aboutHero}>
        <span className={styles.aboutMark}>CGA</span>
        <div>
          <div className={styles.aboutTitle}>Commonwealth GA Launcher</div>
          <p className={styles.aboutTagline}>
            Private server access, game patches, and automatic updates.
          </p>
        </div>
      </div>

      <dl className={styles.aboutGrid}>
        <div>
          <dt>Version</dt>
          <dd>v{state.launcherVersion}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{platform}</dd>
        </div>
        <div>
          <dt>Update channel</dt>
          <dd>Stable · {LAUNCHER_CONFIG.stableBranch}</dd>
        </div>
      </dl>

      <div className={styles.aboutUpdate}>
        <div>
          <div className="panel-title">Launcher Updates</div>
          <p className={`${styles.aboutStatus} ${updateStatus.tone}`}>{updateStatus.text}</p>
          {state.launchCoolingDown && (
            <p className={styles.aboutStatus}>Wait for the current game launch to finish.</p>
          )}
        </div>
        <button
          className={styles.aboutUpdateButton}
          disabled={checkDisabled}
          onClick={() => void window.api.checkLauncherUpdates()}
        >
          {updateBusy ? 'Checking…' : 'Check for launcher updates'}
        </button>
      </div>
    </section>
  );
}

function DiagnosticsTab({
  state,
  settings
}: {
  state: LauncherState;
  settings: SettingsModel;
}): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    void window.api.getLogTail().then(setLines);
    const unsubscribe = window.api.onLogLine((line) =>
      setLines((prev) => [...prev.slice(-499), line])
    );
    return unsubscribe;
  }, []);

  const resetLauncher = async (): Promise<void> => {
    if (resetting) return;
    setResetting(true);
    setResetResult(null);
    try {
      const result = await window.api.resetLauncher();
      setResetResult(result);
      if (!result.ok) setResetting(false);
    } catch (error) {
      setResetResult({
        ok: false,
        message: `Could not reset the launcher: ${error instanceof Error ? error.message : String(error)}`
      });
      setResetting(false);
    }
  };

  const localDevelopment = state.launcherUpdate === 'disabled';
  const launcherBusy =
    state.launchCoolingDown ||
    state.launcherUpdate === 'checking' ||
    state.launcherUpdate === 'downloading' ||
    state.launcherUpdate === 'installing';
  const gameRunning = state.activeGameInstances > 0;
  const updateStatus = localDevelopment
    ? 'local out/ · online checks off'
    : state.launcherUpdate === 'up-to-date'
      ? `up to date · v${state.launcherVersion}`
      : state.launcherUpdate === 'check-failed'
        ? `update check failed · v${state.launcherVersion}`
        : `${state.launcherUpdate}${state.launcherUpdateVersion ? ` · v${state.launcherUpdateVersion}` : ''}`;
  const updateStatusClass =
    state.launcherUpdate === 'error' || state.launcherUpdate === 'check-failed'
      ? styles.invalid
      : localDevelopment || state.launcherUpdate === 'up-to-date'
        ? styles.valid
        : undefined;
  const serverAddressStatus = state.resolvedHost ? 'configured' : 'unavailable';
  const linuxRuntimeStatus =
    state.linuxRuntimeStatus === 'ready'
      ? `${settings.linux.runner} ready`
      : state.linuxRuntimeStatus === 'wine-runner-missing'
        ? 'Wine runner missing'
        : state.linuxRuntimeStatus === 'wine-prefix-missing'
          ? 'prefix missing'
          : state.linuxRuntimeStatus === 'umu-missing'
            ? 'UMU missing'
            : state.linuxRuntimeStatus === 'proton-missing'
              ? 'Proton missing'
              : 'not applicable';

  return (
    <section className={styles.section}>
      <div className="panel-title">Runtime Checks</div>
      <dl className={styles.diagnosticGrid}>
        <div>
          <dt>Launcher status</dt>
          <dd className={updateStatusClass}>{updateStatus}</dd>
        </div>
        <div>
          <dt>Game install</dt>
          <dd className={state.gamePathValid ? styles.valid : styles.invalid}>
            {state.gamePathValid ? 'valid' : 'invalid or unset'}
          </dd>
        </div>
        <div>
          <dt>Server address</dt>
          <dd className={state.resolvedHost ? styles.valid : styles.invalid}>{serverAddressStatus}</dd>
        </div>
        <div>
          <dt>Server probe</dt>
          <dd
            className={
              state.serverStatus === 'online'
                ? styles.valid
                : state.serverStatus === 'checking'
                  ? undefined
                  : styles.invalid
            }
          >
            {state.serverStatus}
          </dd>
        </div>
        {state.platform === 'linux' && (
          <>
            <div>
              <dt>Linux runtime</dt>
              <dd
                className={
                  state.linuxRuntimeStatus === 'ready' ? styles.valid : styles.invalid
                }
              >
                {linuxRuntimeStatus}
              </dd>
            </div>
            <div>
              <dt>GameMode</dt>
              <dd className={state.gameModeAvailable ? styles.valid : undefined}>
                {state.gameModeAvailable ? 'available' : 'not detected'}
              </dd>
            </div>
          </>
        )}
      </dl>

      <div className="panel-title">Launcher Log</div>
      <pre className={styles.logView}>{lines.join('\n')}</pre>
      <div className={styles.inlineButtons}>
        <button onClick={() => void window.api.openLauncherLogs().then(setActionResult)}>Open logs folder</button>
        <button
          onClick={() => {
            void window.api.copyDiagnostics().then(setActionResult);
          }}
        >
          Copy diagnostics
        </button>
      </div>
      {actionResult && (
        <p className={actionResult.ok ? styles.valid : styles.invalid}>{actionResult.message}</p>
      )}

      <div className="panel-title">Recovery</div>
      <div className={styles.resetPanel}>
        <div className={styles.resetCopy}>
          <div className={styles.resetTitle}>Reset launcher settings</div>
          <p>
            Clear every saved option and game settings profile, remove the launcher-managed Game
            Client Patch, and restart from initial setup. Game INIs, logs, caches, and backups stay
            intact.
          </p>
        </div>
        <button
          className={styles.resetButton}
          disabled={launcherBusy || resetting || gameRunning}
          title={
            gameRunning
              ? 'Close every game instance before resetting the launcher.'
              : undefined
          }
          onClick={() => {
            setResetResult(null);
            setResetConfirming(true);
          }}
        >
          Reset all settings…
        </button>
      </div>
      {!resetConfirming && resetResult && (
        <p className={resetResult.ok ? styles.valid : styles.invalid}>{resetResult.message}</p>
      )}

      {resetConfirming && (
        <div className={styles.confirmBackdrop}>
          <div
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-launcher-title"
          >
            <span className={styles.confirmEyebrow}>Recovery reset</span>
            <h2 id="reset-launcher-title">Start the launcher from scratch?</h2>
            <p>
              This removes saved profiles and replaces the saved game path, servers, launcher
              options, and game options with defaults, then restarts the launcher.
            </p>
            <p>
              The launcher also removes its managed Game Client Patch from the configured game
              install. If that install is unavailable, game cleanup is skipped. Game INIs, logs,
              caches, and backups stay intact.
            </p>
            {resetResult && (
              <p className={resetResult.ok ? styles.valid : styles.confirmError}>
                {resetResult.message}
              </p>
            )}
            <div className={styles.confirmActions}>
              <button
                className={styles.discardButton}
                disabled={resetting}
                autoFocus
                onClick={() => {
                  setResetConfirming(false);
                }}
              >
                Cancel
              </button>
              <button
                className={styles.resetConfirmButton}
                disabled={resetting}
                onClick={() => void resetLauncher()}
              >
                {resetting ? 'Resetting…' : 'Reset and restart'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
