import { useEffect, useState } from 'react';
import { currentSession, learnerService } from '../db/instance.js';
import { lookupWouldIntroduce } from '../lib/learner-service.js';
import { markStudyDirty } from '../lib/study-dirty.js';

/**
 * Phase 20: looking up a word above your level (or in no list, or a name) no longer adds it to
 * review by itself. The popover offers this instead.
 */
export function AddToReview({ wordId }: { wordId: string }) {
  const [state, setState] = useState<'hidden' | 'offer' | 'added'>('hidden');
  useEffect(() => {
    let cancelled = false;
    if (!currentSession() || lookupWouldIntroduce(wordId)) return;
    learnerService
      .getCard({ kind: 'word', id: wordId }, 'recognition')
      .then((c) => {
        if (!cancelled) setState(!c || c.flags.excluded || c.flags.snoozed ? 'offer' : 'hidden');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wordId]);
  if (state === 'hidden') return null;
  if (state === 'added') return <div className="an-popover-source" role="status">Added to review</div>;
  return (
    <button
      className="an-popover-add"
      data-testid="add-to-review"
      onClick={async () => {
        await learnerService.restore({ kind: 'word', id: wordId });
        markStudyDirty();
        setState('added');
      }}
    >
      Add to review
    </button>
  );
}
