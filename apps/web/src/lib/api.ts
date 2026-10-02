import type { ProfileId } from '../profiles.js';

/** Where the proxy lives: dev runs it on :3002; production is same-origin,
 * nginx-routed at <base>/api (docs/related-repos.md). */
export function proxyBase(): string {
  const override = import.meta.env.VITE_PROXY_URL;
  if (override) return override;
  return import.meta.env.DEV ? 'http://localhost:3002' : `${import.meta.env.BASE_URL}api`;
}

const INSTALL_ID_KEY = 'anan-install-id';
const SITE_CODE_KEY = 'anan.siteCode';

/** A random per-browser id (no accounts). Rate limits are applied per
 * `installId:profileId`, so each person has their own budget. */
export function getInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

/** The household code, typed once per browser. Only ever sent to the proxy in
 * a header — it is never part of the bundle (the proxy's SITE_CODE env var
 * holds the real one). */
export const getSiteCode = (): string | null => localStorage.getItem(SITE_CODE_KEY);
export const setSiteCode = (code: string): void => localStorage.setItem(SITE_CODE_KEY, code);
export const clearSiteCode = (): void => localStorage.removeItem(SITE_CODE_KEY);

/** The profile whose requests are being made; kept in sync by the session. */
let activeProfile: ProfileId | null = null;
export const setActiveProfileForApi = (id: ProfileId | null): void => {
  activeProfile = id;
};

/** Headers every proxy request carries: the household code and
 * `installId:profileId` (phase 8 §7). */
export function authHeaders(profileId: ProfileId | null = activeProfile): Record<string, string> {
  return {
    'x-install-id': profileId ? `${getInstallId()}:${profileId}` : getInstallId(),
    'x-site-code': getSiteCode() ?? '',
  };
}

export const AUTH_FAILED_EVENT = 'anan:auth-failed';

/** A 401 means the code is wrong or was changed on the server: forget it so
 * the site asks again ("changing the env var makes every browser ask once more"). */
export function handleUnauthorized(): void {
  clearSiteCode();
  window.dispatchEvent(new Event(AUTH_FAILED_EVENT));
}
