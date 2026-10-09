import { expect, type Page } from '@playwright/test';

/**
 * Phase 28: a browser opening a profile for the first time never opens silently empty. When the
 * server has no copy of that profile yet it says so and offers "Start fresh"; specs that start a
 * new profile on purpose take that button.
 */
export async function startFreshIfAsked(page: Page, name?: string): Promise<void> {
  const chip = name ? page.getByTestId('profile-chip').filter({ hasText: name }) : page.getByTestId('profile-chip');
  const fresh = page.getByTestId('gate-start-fresh');
  await expect(chip.or(fresh).first()).toBeVisible({ timeout: 20000 });
  if (await fresh.isVisible()) await fresh.click();
}
