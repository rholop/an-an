import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PROFILES, isProfileId, type Profile, type ProfileId } from '../profiles.js';
import { currentSession } from '../db/instance.js';
import { AUTH_FAILED_EVENT, authHeaders, getSiteCode, proxyBase, setSiteCode } from '../lib/api.js';
import {
  LegacyMigrationError,
  legacyDbExists,
  migrateLegacyInto,
} from '../lib/legacy-migration.js';
import { ProfileController, rememberedProfile, type RestoreProblem } from '../lib/profile-controller.js';
import type { SavedInfo, SyncManager, SyncStatus } from '../lib/sync.js';
import {
  APP_OUTDATED,
  noServerCopy,
  RELOAD_APP,
  restoringLine,
  SERVER_UNREACHABLE,
  START_FRESH,
  TRY_AGAIN,
} from '../lib/labels.js';
import './ProfileGate.css';

type Stage =
  | { kind: 'booting' }
  | { kind: 'code' }
  | { kind: 'legacy' }
  | { kind: 'who' }
  | { kind: 'loading'; profile?: ProfileId; found?: SavedInfo }
  /** Phase 28: a fresh browser found nothing on the server, or couldn't reach it. */
  | { kind: 'restore'; profile: ProfileId; problem: RestoreProblem }
  | { kind: 'error'; message: string; profile: ProfileId }
  | { kind: 'ready' };

interface ProfileContextValue {
  profile: Profile;
  syncStatus: SyncStatus;
  /** Phase 28: the profile's sync (saved info, last failure, Save now); null when sync is off. */
  sync: SyncManager | null;
  /** Changes whenever the sync's saved info or failure changes (re-render the cloud). */
  syncTick: number;
  /** Saves drafts, pushes, then opens the other profile — no page reload. */
  switchProfile: (id: ProfileId) => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile() outside <ProfileProvider>');
  return ctx;
}

/**
 * Phase 8: everything that has to happen before the app can show a screen —
 * (1) the household code, once per browser; (2) if the old single database
 * exists, "Whose progress is this?"; (3) "Who are you?" when no profile is
 * remembered; (4) opening that profile's database and pulling its saved copy.
 * Children only mount once a profile is open, and are re-mounted (not the whole
 * page reloaded) whenever the profile changes or a sync brings new data in.
 */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ kind: 'booting' });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const [syncTick, setSyncTick] = useState(0);
  const controller = useRef<ProfileController | null>(null);
  if (!controller.current) {
    controller.current = new ProfileController({
      onDataChanged: () => setEpoch((e) => e + 1),
      onSyncStatus: (st) => {
        setSyncStatus(st);
        setSyncTick((t) => t + 1);
      },
      onUnauthorized: () => setStage({ kind: 'code' }),
      onRestoreFound: (found) => setStage((st) => (st.kind === 'loading' ? { ...st, found } : st)),
    });
  }
  const ctl = controller.current;

  const open = useCallback((id: ProfileId) => {
    setProfile(PROFILES.find((p) => p.id === id)!);
    setEpoch((e) => e + 1);
    setStage({ kind: 'ready' });
  }, []);

  const enter = useCallback(
    async (id: ProfileId) => {
      setStage({ kind: 'loading', profile: id });
      await ctl.activate(id);
      // The server may have said 401 during the first pull (code changed): ask again.
      if (!getSiteCode() && !sessionStorage.getItem('anan.offlineCode')) {
        setStage({ kind: 'code' });
        return;
      }
      // Phase 28: never open a fresh browser on an empty database without saying so.
      if (ctl.restoreProblem === 'outdated' && reloadOnceForUpdate()) return;
      if (ctl.restoreProblem) {
        setStage({ kind: 'restore', profile: id, problem: ctl.restoreProblem });
        return;
      }
      setProfile(PROFILES.find((p) => p.id === id)!);
      setEpoch((e) => e + 1);
      setStage({ kind: 'ready' });
    },
    [ctl],
  );

  const boot = useCallback(async () => {
    if (!getSiteCode() && !sessionStorage.getItem('anan.offlineCode'))
      return setStage({ kind: 'code' });
    if (await legacyDbExists()) return setStage({ kind: 'legacy' });
    const remembered = rememberedProfile(isProfileId);
    if (!remembered) return setStage({ kind: 'who' });
    await enter(remembered);
  }, [enter]);

  useEffect(() => {
    void boot();
    const onAuthFailed = () => setStage({ kind: 'code' });
    window.addEventListener(AUTH_FAILED_EVENT, onAuthFailed);
    return () => window.removeEventListener(AUTH_FAILED_EVENT, onAuthFailed);
  }, [boot]);

  const switchProfile = useCallback(
    async (id: ProfileId) => {
      if (currentSession()?.profileId === id) return;
      await ctl.switchTo(id);
      if (ctl.restoreProblem) {
        setStage({ kind: 'restore', profile: id, problem: ctl.restoreProblem });
        return;
      }
      setProfile(PROFILES.find((p) => p.id === id)!);
      setEpoch((e) => e + 1);
    },
    [ctl],
  );

  const adoptLegacy = useCallback(
    async (id: ProfileId) => {
      setStage({ kind: 'loading' });
      try {
        const session = await ctl.activate(id);
        await migrateLegacyInto(session.db);
        ctl.syncManager?.markDirty(); // the moved data should reach the server too
        void ctl.syncManager?.flush();
        setProfile(PROFILES.find((p) => p.id === id)!);
        setEpoch((e) => e + 1);
        setStage({ kind: 'ready' });
      } catch (err) {
        setStage({
          kind: 'error',
          profile: id,
          message:
            err instanceof LegacyMigrationError
              ? err.message
              : `Couldn't move your old progress (${String(err)}). It was not deleted.`,
        });
      }
    },
    [ctl],
  );

  const value = useMemo<ProfileContextValue | null>(
    () =>
      profile
        ? { profile, syncStatus, switchProfile, sync: ctl.syncManager?.started ? ctl.syncManager : null, syncTick }
        : null,
    [profile, syncStatus, switchProfile, ctl, syncTick],
  );

  if (stage.kind === 'ready' && value) {
    return (
      <ProfileContext.Provider value={value}>
        <div key={`${profile!.id}:${epoch}`} className="profile-root">
          {children}
        </div>
      </ProfileContext.Provider>
    );
  }

  return (
    <div className="gate">
      {stage.kind === 'booting' && <p className="gate-note">…</p>}
      {stage.kind === 'code' && (
        <CodeScreen
          onDone={(offline) => {
            if (offline) sessionStorage.setItem('anan.offlineCode', '1');
            void boot();
          }}
        />
      )}
      {stage.kind === 'who' && <ProfileButtons onPick={(id) => void enter(id)} />}
      {stage.kind === 'legacy' && (
        <ProfileButtons
          title="Whose progress is this?"
          note="Your existing progress will be moved to the name you pick."
          onPick={(id) => void adoptLegacy(id)}
        />
      )}
      {stage.kind === 'loading' && (
        <p className="gate-note" role="status" data-testid="gate-loading">
          {stage.profile
            ? restoringLine(PROFILES.find((p) => p.id === stage.profile)!.name, stage.found)
            : 'Loading your progress…'}
        </p>
      )}
      {stage.kind === 'restore' && (
        <div className="gate-error" role="alert" data-testid="gate-restore">
          <p lang="zh-Hant">
            {stage.problem === 'none'
              ? noServerCopy(PROFILES.find((p) => p.id === stage.profile)!.name)
              : stage.problem === 'outdated'
                ? APP_OUTDATED
                : SERVER_UNREACHABLE}
          </p>
          {stage.problem === 'outdated' ? (
            <button className="gate-small" onClick={() => void reloadForUpdate()}>
              {RELOAD_APP}
            </button>
          ) : (
            <button className="gate-small" onClick={() => void enter(stage.profile)} data-testid="gate-try-again">
              {TRY_AGAIN}
            </button>
          )}
          <button className="gate-small" onClick={() => open(stage.profile)} data-testid="gate-start-fresh">
            {START_FRESH}
          </button>
        </div>
      )}
      {stage.kind === 'error' && (
        <div className="gate-error" role="alert">
          <p>{stage.message}</p>
          <button className="gate-small" onClick={() => void adoptLegacy(stage.profile)}>
            Try again
          </button>
          <button className="gate-small" onClick={() => void enter(stage.profile)}>
            Continue without moving it for now
          </button>
        </div>
      )}
    </div>
  );
}

/** Phase 28: the server copy is from a newer app. Update the service worker and reload, once per tab
 * session (a second time the restore screen offers Reload instead). Returns whether it reloads. */
function reloadOnceForUpdate(): boolean {
  if (sessionStorage.getItem('anan.reloadedForUpdate')) return false;
  sessionStorage.setItem('anan.reloadedForUpdate', '1');
  void reloadForUpdate();
  return true;
}

async function reloadForUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* no service worker (dev, private mode): a plain reload is enough */
  }
  location.reload();
}

/** Two large buttons with the names. Nothing else (unless a title is needed to ask a question). */
function ProfileButtons({
  onPick,
  title,
  note,
}: {
  onPick: (id: ProfileId) => void;
  title?: string;
  note?: string;
}) {
  return (
    <div className="gate-profiles">
      {title && <h1 className="gate-title">{title}</h1>}
      <div className="gate-buttons">
        {PROFILES.map((p) => (
          <button key={p.id} className="gate-big" onClick={() => onPick(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
      {note && <p className="gate-note">{note}</p>}
    </div>
  );
}

/** The household code, asked once per browser. Checked by the server (the
 * code itself is never in this bundle); a wrong one lets you try again. */
function CodeScreen({ onDone }: { onDone: (offline: boolean) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    setUnreachable(false);
    try {
      const res = await fetch(`${proxyBase()}/v1/auth/check`, {
        headers: { ...authHeaders(null), 'x-site-code': code.trim() },
      });
      if (res.ok) {
        setSiteCode(code.trim());
        onDone(false);
      } else {
        setError("That's not it");
      }
    } catch {
      setUnreachable(true); // offline: never block the app
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="gate-code"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="gate-title" htmlFor="site-code">
        Household code
      </label>
      <input
        id="site-code"
        className="gate-input"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-invalid={error !== null}
      />
      <button className="gate-big gate-big--small" type="submit" disabled={busy || !code.trim()}>
        Continue
      </button>
      {error && (
        <p className="gate-error" role="alert">
          {error}
        </p>
      )}
      {unreachable && (
        <p className="gate-note" role="status">
          Can&apos;t reach the server right now.{' '}
          <button type="button" className="gate-small" onClick={() => onDone(true)}>
            Continue offline
          </button>
        </p>
      )}
    </form>
  );
}
