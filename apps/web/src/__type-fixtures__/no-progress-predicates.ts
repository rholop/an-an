// Phase 29 Part A.4 acceptance: a deliberately bad file. Each import below names a low-level
// progress predicate that `@anan/core` must NOT export (progress comes only from the ledger). If one
// is exported again, its `@ts-expect-error` is unused and `pnpm typecheck` fails. Never imported by
// the app, so the build never includes it.
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { isDueCard } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { isDueBefore } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { isNewCard } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { isScheduledCard } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { isDueListening } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { ProgressIndex } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { summarize } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { newWordState } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { sessionCards } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { sessionWindows } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { sessionAt } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { growthStage } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { reviewStatus } from '@anan/core';
// @ts-expect-error not exported: use the ledger (buildLedger / useLedger)
import { wordSets } from '@anan/core';

export const fixtures: unknown[] = [isDueCard, isDueBefore, isNewCard, isScheduledCard, isDueListening, ProgressIndex, summarize, newWordState, sessionCards, sessionWindows, sessionAt, growthStage, reviewStatus, wordSets];
