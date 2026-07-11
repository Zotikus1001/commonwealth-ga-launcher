import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type {
  ActionResult,
  ClientPatchStatus,
  LauncherState,
  Settings as SettingsModel,
  WineRunner
} from '@shared/types';
import { isLoginMap, LOGIN_MAP_OPTIONS } from '@shared/loginMaps';
import { isFpsLimit, MAX_FPS_LIMIT, MIN_FPS_LIMIT } from '@shared/fpsLimit';
import { isUiScale, UI_SCALE_OPTIONS } from '@shared/uiScale';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import {
  DEFAULT_SERVER_ID,
  DEVELOPER_MAX_HEIGHT,
  DEVELOPER_MAX_WIDTH,
  DEVELOPER_MIN_HEIGHT,
  DEVELOPER_MIN_WIDTH,
  MAX_DEVELOPER_SERVERS,
  validateDeveloperServers
} from '@shared/serverProfiles';
import styles from './Settings.module.css';

export type SettingsTab = 'game' | 'patches' | 'account' | 'launch' | 'dev' | 'diagnostics' | 'about';

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

const PATCH_COPY: Record<ClientPatchStatus['id'], { title: string; description: string }> = {
  'high-fps-movement-stability': {
    title: 'High-FPS movement stability',
    description:
      'Fixes teleporting and harsh position corrections caused by running the game at high frame rates. ' +
      'Limiting FPS to your monitor refresh rate is still recommended to avoid other potential issues.'
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
  const [wineRunners, setWineRunners] = useState<WineRunner[]>([]);
  const [prefixResult, setPrefixResult] = useState<ActionResult | null>(null);
  const [steamOpening, setSteamOpening] = useState(false);
  const [steamResult, setSteamResult] = useState<ActionResult | null>(null);
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [developerModeSaving, setDeveloperModeSaving] = useState(false);
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null);
  const aboutClicks = useRef<number[]>([]);

  const isLinux = window.api.platform === 'linux';

  useEffect(() => {
    void window.api.getSettings().then(setDraft);
    if (isLinux) void window.api.listWineRunners().then(setWineRunners);
  }, [isLinux]);

  const tabs = useMemo<{ id: SettingsTab; label: string }[]>(() => {
    const t: { id: SettingsTab; label: string }[] = [
      { id: 'game', label: 'Game' },
      { id: 'patches', label: 'Patches' }
    ];
    // Account tab is built but gated off until Phase 4 auto-login works (plan §11b decision #4).
    if (state.accountTabEnabled) t.push({ id: 'account', label: 'Account' });
    t.push(
      { id: 'launch', label: 'Launch' },
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
    if (!draft || mapSaving) return false;
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
    const validationError = validateDeveloperServers(draft.developer.servers);
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

  const browse = async (): Promise<void> => {
    const p = await window.api.browseForGame(); // saved main-side immediately
    if (p) setDraft((d) => (d ? { ...d, gameExePath: p } : d));
  };

  const autoDetect = async (): Promise<void> => {
    const p = await window.api.autoDetectGame(); // saved main-side immediately
    if (p) setDraft((d) => (d ? { ...d, gameExePath: p } : d));
  };

  const openSteamStore = async (): Promise<void> => {
    if (steamOpening) return;
    setSteamOpening(true);
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
      setSteamOpening(false);
    }
  };

  const createPrefix = async (): Promise<void> => {
    if (dirty && !(await save())) return; // prefix creation uses SAVED settings
    setPrefixResult({ ok: true, message: 'Creating prefix… (first boot can take minutes)' });
    setPrefixResult(await window.api.createWinePrefix());
  };

  const saveDeveloperMode = async (enabled: boolean): Promise<void> => {
    if (!draft || developerModeSaving) return;
    const previous = draft.developer.enabled;
    setDraft((current) =>
      current
        ? { ...current, developer: { ...current.developer, enabled } }
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
              developer: { ...current.developer, enabled: updated.developer.enabled }
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
          ? { ...current, developer: { ...current.developer, enabled: previous } }
          : current
      );
      setDeveloperModeError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeveloperModeSaving(false);
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
            <div className="panel-title">Game install</div>
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
                  className={styles.steamStoreButton}
                  disabled={steamOpening}
                  onClick={() => void openSteamStore()}
                >
                  {steamOpening ? 'Opening Steam…' : 'View on Steam'}
                </button>
              </div>
              {steamResult && (
                <span className={styles.invalid}>{steamResult.message}</span>
              )}
              <span className={gamePathIsValid ? styles.valid : styles.invalid}>
                {gamePathStatus}
              </span>
            </div>

            <div className="panel-title">Login environment</div>
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

            <div className="panel-title">Frame rate</div>
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
                <span className={styles.featureName}>FPS limit</span>
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

            <div className="panel-title">Combat feedback</div>
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
                <span className={styles.featureName}>Show overhealing</span>
                <span className={styles.featureDetail}>
                  Displays healing and repair numbers even when the target is already at full
                  health. Applies to Medic and Robotics abilities.
                </span>
              </label>
            </div>

            {isLinux && (
              <>
                <div className="panel-title">Wine</div>
                <div className={styles.fieldRow}>
                  <label>Wine runner</label>
                  <select
                    value={draft.linux.winePath}
                    onChange={(e) => edit((d) => ({ ...d, linux: { ...d.linux, winePath: e.target.value } }))}
                  >
                    <option value="">— pick a runner —</option>
                    {wineRunners.map((r) => (
                      <option key={r.path} value={r.path}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <label>Custom wine binary</label>
                  <input
                    type="text"
                    value={draft.linux.winePath}
                    placeholder="/path/to/wine"
                    onChange={(e) => edit((d) => ({ ...d, linux: { ...d.linux, winePath: e.target.value } }))}
                  />
                </div>
                <div className={styles.fieldRow}>
                  <label>Wine prefix</label>
                  <input
                    type="text"
                    value={draft.linux.winePrefix}
                    onChange={(e) => edit((d) => ({ ...d, linux: { ...d.linux, winePrefix: e.target.value } }))}
                  />
                  <div className={styles.inlineButtons}>
                    <button onClick={() => void createPrefix()}>Create prefix</button>
                  </div>
                  {prefixResult && (
                    <span className={prefixResult.ok ? styles.valid : styles.invalid}>{prefixResult.message}</span>
                  )}
                </div>
                <div className={styles.checkRow}>
                  <input
                    id="winedebug"
                    type="checkbox"
                    checked={draft.linux.wineDebug}
                    onChange={(e) => edit((d) => ({ ...d, linux: { ...d.linux, wineDebug: e.target.checked } }))}
                  />
                  <label htmlFor="winedebug">
                    Wine debug output (captures wine stderr into the launcher log; launcher stays attached to the game)
                  </label>
                </div>
              </>
            )}
          </section>
        )}

        {tab === 'account' && (
          <section className={styles.section}>
            <div className="panel-title">Account</div>
            <p className={styles.hint}>Auto-login arrives in a later phase.</p>
          </section>
        )}

        {tab === 'patches' && <PatchesTab state={state} />}

        {tab === 'launch' && (
          <section className={styles.section}>
            <div className="panel-title">Launcher interface</div>
            <div className={styles.fieldRow}>
              <label htmlFor="launcher-ui-scale">UI scale</label>
              <select
                id="launcher-ui-scale"
                value={draft.uiScale}
                onChange={(event) => {
                  const scale = Number(event.currentTarget.value);
                  if (isUiScale(scale)) edit((settings) => ({ ...settings, uiScale: scale }));
                }}
              >
                {UI_SCALE_OPTIONS.map((scale) => (
                  <option key={scale} value={scale}>
                    {Math.round(scale * 100)}%
                  </option>
                ))}
              </select>
              <span className={styles.hint}>Applied after saving.</span>
            </div>

            <div className="panel-title">Graphics</div>
            <div className={styles.fieldGrid}>
              <div>
                <label>GPU adapter (ordinal, 0 = primary)</label>
                <input
                  type="number"
                  min={0}
                  value={draft.launch.gpuAdapter}
                  onChange={(e) =>
                    edit((d) => ({
                      ...d,
                      launch: { ...d.launch, gpuAdapter: Math.max(0, parseInt(e.target.value, 10) || 0) }
                    }))
                  }
                />
              </div>
            </div>

            <div className="panel-title">Startup</div>
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
                <span className={styles.featureName}>Automatically close launcher after launching game</span>
                <span className={styles.featureDetail}>
                  Closes the launcher five seconds after it starts the game.
                </span>
              </label>
            </div>
            <div className={styles.checkRow}>
              <input
                id="nostartupmovies"
                type="checkbox"
                checked={draft.launch.noStartupMovies}
                onChange={(e) => edit((d) => ({ ...d, launch: { ...d.launch, noStartupMovies: e.target.checked } }))}
              />
              <label htmlFor="nostartupmovies">Skip startup movies (-nostartupmovies)</label>
            </div>
            <div className={styles.checkRow}>
              <input
                id="nosplash"
                type="checkbox"
                checked={draft.launch.noSplash}
                onChange={(e) => edit((d) => ({ ...d, launch: { ...d.launch, noSplash: e.target.checked } }))}
              />
              <label htmlFor="nosplash">Skip splash screen (-nosplash)</label>
            </div>

            <div className="panel-title">Advanced</div>
            <div className={styles.fieldRow}>
              <label>Extra launch arguments (space-separated)</label>
              <input
                type="text"
                value={draft.launch.extraArgs}
                onChange={(e) => edit((d) => ({ ...d, launch: { ...d.launch, extraArgs: e.target.value } }))}
              />
            </div>
          </section>
        )}

        {tab === 'dev' && (
          <DeveloperTab
            settings={draft}
            edit={edit}
            modeSaving={developerModeSaving}
            modeError={developerModeError}
            onModeChange={(enabled) => void saveDeveloperMode(enabled)}
          />
        )}

        {tab === 'diagnostics' && <DiagnosticsTab state={state} settings={draft} />}

        {tab === 'about' && <AboutTab state={state} />}

        {tab !== 'diagnostics' &&
          tab !== 'patches' &&
          tab !== 'account' &&
          tab !== 'about' &&
          dirty && (
          <footer className={styles.saveBar}>
            <span className={saveError ? styles.invalid : styles.saveState}>
              {saveError ?? 'Unsaved changes'}
            </span>
            <button
              className={styles.saveButton}
              disabled={saving || mapSaving || developerModeSaving}
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
                disabled={saving || discarding || mapSaving}
                onClick={() => setPendingNavigation(null)}
              >
                Cancel
              </button>
              <button
                className={styles.discardButton}
                disabled={saving || discarding || mapSaving}
                onClick={() => void discardAndNavigate()}
              >
                {discarding ? 'Discarding…' : "Don't save"}
              </button>
              <button
                autoFocus
                className={styles.confirmSaveButton}
                disabled={saving || discarding || mapSaving}
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

function DeveloperTab({
  settings,
  edit,
  modeSaving,
  modeError,
  onModeChange
}: {
  settings: SettingsModel;
  edit: (fn: (settings: SettingsModel) => SettingsModel) => void;
  modeSaving: boolean;
  modeError: string | null;
  onModeChange: (enabled: boolean) => void;
}): JSX.Element {
  const hasUnfinishedServer = settings.developer.servers.some(
    (server) => !server.name.trim() || !server.host.trim()
  );

  const addServer = (): void => {
    if (settings.developer.servers.length >= MAX_DEVELOPER_SERVERS || hasUnfinishedServer) return;
    edit((current) => {
      const servers = current.developer.servers;
      if (
        servers.length >= MAX_DEVELOPER_SERVERS ||
        servers.some((server) => !server.name.trim() || !server.host.trim())
      ) {
        return current;
      }
      return {
        ...current,
        developer: {
          ...current.developer,
          servers: [...servers, { id: crypto.randomUUID(), name: '', host: '' }]
        }
      };
    });
  };

  const removeServer = (id: string): void => {
    edit((current) => ({
      ...current,
      developer: {
        ...current.developer,
        selectedServerId:
          current.developer.selectedServerId === id
            ? DEFAULT_SERVER_ID
            : current.developer.selectedServerId,
        servers: current.developer.servers.filter((server) => server.id !== id)
      }
    }));
  };

  return (
    <section className={styles.section}>
      <div className="panel-title">Developer mode</div>
      <div className={`${styles.featureToggle} ${styles.developerToggle}`}>
        <input
          id="developer-mode"
          type="checkbox"
          checked={settings.developer.enabled}
          disabled={modeSaving}
          onChange={(event) => onModeChange(event.target.checked)}
        />
        <label htmlFor="developer-mode">
          <span className={styles.featureName}>Enable developer mode</span>
          <span className={styles.featureDetail}>
            Allows multiple game instances and adds a server selector beside Play. This setting is saved immediately.
          </span>
        </label>
      </div>
      {modeError && <p className={styles.invalid}>{`Could not save Developer mode: ${modeError}`}</p>}

      {settings.developer.enabled && (
        <>
          <div className="panel-title">Dev Launch display</div>
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
                <span className={styles.featureName}>Windowed mode</span>
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

          <div className="panel-title">Test servers</div>
          <p className={styles.hint}>
            Add named IP addresses or hostnames. The main page shows only the server name.
          </p>
          <div className={styles.serverProfiles}>
            {settings.developer.servers.map((server, index) => (
              <article key={server.id} className={styles.serverProfile}>
                <span className={styles.serverProfileIndex}>{String(index + 1).padStart(2, '0')}</span>
                <div className={styles.serverProfileFields}>
                  <label>
                    <span>Name</span>
                    <input
                      type="text"
                      maxLength={48}
                      value={server.name}
                      placeholder="Local test"
                      onChange={(event) =>
                        edit((current) => ({
                          ...current,
                          developer: {
                            ...current.developer,
                            servers: current.developer.servers.map((item) =>
                              item.id === server.id ? { ...item, name: event.target.value } : item
                            )
                          }
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>IP address or hostname</span>
                    <input
                      type="text"
                      value={server.host}
                      placeholder="127.0.0.1"
                      onChange={(event) =>
                        edit((current) => ({
                          ...current,
                          developer: {
                            ...current.developer,
                            servers: current.developer.servers.map((item) =>
                              item.id === server.id ? { ...item, host: event.target.value } : item
                            )
                          }
                        }))
                      }
                    />
                  </label>
                </div>
                <button
                  className={styles.removeServerButton}
                  aria-label={`Remove ${server.name || `server ${index + 1}`}`}
                  onClick={() => removeServer(server.id)}
                >
                  Remove
                </button>
              </article>
            ))}
            {settings.developer.servers.length === 0 && (
              <p className={styles.emptyServers}>No test servers added.</p>
            )}
          </div>
          <button
            className={styles.addServerButton}
            disabled={
              settings.developer.servers.length >= MAX_DEVELOPER_SERVERS || hasUnfinishedServer
            }
            title={
              hasUnfinishedServer
                ? 'Finish or remove the current server before adding another.'
                : undefined
            }
            onClick={addServer}
          >
            + Add server
          </button>
        </>
      )}
    </section>
  );
}

function PatchesTab({ state }: { state: LauncherState }): JSX.Element {
  const [applying, setApplying] = useState<ClientPatchStatus['id'] | null>(null);
  const [result, setResult] = useState<
    { id: ClientPatchStatus['id']; value: ActionResult } | null
  >(null);

  const applyPatch = async (id: ClientPatchStatus['id']): Promise<void> => {
    if (applying) return;
    setApplying(id);
    setResult(null);
    try {
      setResult({ id, value: await window.api.applyClientPatch(id) });
    } catch (error) {
      setResult({
        id,
        value: {
          ok: false,
          message: `Could not apply patch: ${error instanceof Error ? error.message : String(error)}`
        }
      });
    } finally {
      setApplying(null);
    }
  };

  return (
    <section className={styles.section}>
      <div className="panel-title">Client patches</div>
      <p className={styles.hint}>
        Verified against the installed game. Required fixes are checked again before every Play.
      </p>
      <div className={styles.patchList}>
        {state.clientPatches.map((patch) => {
          const copy = PATCH_COPY[patch.id];
          const patchApplying = applying === patch.id;
          const status =
            patch.applied === true
              ? 'Applied'
              : patch.applied === false
                ? patchApplying
                  ? 'Applying…'
                  : state.launchCoolingDown
                    ? 'Wait for launch to finish'
                    : 'Ready to apply'
                : 'Game path required';
          const tone =
            patch.applied === true
              ? styles.patchApplied
              : patch.applied === false
                ? styles.patchPending
                : styles.patchUnknown;
          return (
            <article key={patch.id} className={`${styles.patchCard} ${tone}`}>
              {patch.applied === false ? (
                <button
                  className={`${styles.patchIcon} ${styles.patchApplyButton}`}
                  disabled={patchApplying || state.launchCoolingDown}
                  aria-label={`Apply ${copy.title} patch`}
                  title={state.launchCoolingDown ? 'Wait for launch to finish.' : 'Apply patch'}
                  onClick={() => void applyPatch(patch.id)}
                >
                  {patchApplying ? '…' : 'APPLY'}
                </button>
              ) : (
                <span className={styles.patchIcon} aria-hidden="true">
                  {patch.applied === true ? '✓' : '—'}
                </span>
              )}
              <div className={styles.patchBody}>
                <div className={styles.patchTitle}>{copy.title}</div>
                <p className={styles.patchDescription}>{copy.description}</p>
                <span className={styles.patchState}>{status}</span>
                {result?.id === patch.id && (
                  <p className={result.value.ok ? styles.patchResultOk : styles.patchResultError}>
                    {result.value.message}
                  </p>
                )}
              </div>
            </article>
          );
        })}
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
            : state.launcherUpdate === 'error'
              ? { text: 'Update check failed. Try again.', tone: styles.aboutWarn }
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
            Private server access, client fixes, and automatic updates.
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
          <div className="panel-title">Launcher updates</div>
          <p className={`${styles.aboutStatus} ${updateStatus.tone}`}>{updateStatus.text}</p>
          {state.launchCoolingDown && (
            <p className={styles.aboutStatus}>Wait for the current game launch to finish.</p>
          )}
        </div>
        <button
          className={styles.aboutUpdateButton}
          disabled={checkDisabled}
          onClick={() => void window.api.refresh()}
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

  useEffect(() => {
    void window.api.getLogTail().then(setLines);
    const unsubscribe = window.api.onLogLine((line) =>
      setLines((prev) => [...prev.slice(-499), line])
    );
    return unsubscribe;
  }, []);

  const localDevelopment = state.launcherUpdate === 'disabled';
  const updateStatus = localDevelopment
    ? 'local out/ · online checks off'
    : state.launcherUpdate === 'up-to-date'
      ? `up to date · v${state.launcherVersion}`
      : `${state.launcherUpdate}${state.launcherUpdateVersion ? ` · v${state.launcherUpdateVersion}` : ''}`;
  const updateStatusClass =
    state.launcherUpdate === 'error'
      ? styles.invalid
      : localDevelopment || state.launcherUpdate === 'up-to-date'
        ? styles.valid
        : undefined;
  const serverAddressStatus = state.resolvedHost ? 'configured' : 'unavailable';

  return (
    <section className={styles.section}>
      <div className="panel-title">Runtime checks</div>
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
          <dd className={state.serverOnline ? styles.valid : state.serverOnline === false ? styles.invalid : undefined}>
            {state.serverOnline === true ? 'online' : state.serverOnline === false ? 'offline' : 'pending'}
          </dd>
        </div>
        {state.platform === 'linux' && (
          <div>
            <dt>Wine runner</dt>
            <dd className={state.winePathValid ? styles.valid : styles.invalid}>
              {state.winePathValid
                ? 'executable'
                : settings.linux.winePath
                  ? 'not executable'
                  : 'not configured'}
            </dd>
          </div>
        )}
      </dl>

      <div className="panel-title">Launcher log</div>
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
    </section>
  );
}
