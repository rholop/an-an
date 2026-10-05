import { useEffect, useState } from 'react';
import { suggestProtectedTerms, type Lexicon } from '@anan/core';
import { db } from '../db/instance.js';
import {
  getProtectedTerms,
  parseProtectedTerms,
  PROTECTED_TERMS_KEY,
} from '../lib/journal-protected.js';

/** Phase 17 Part A: the learner's own names. The reviewer never changes them
 * and they are never a blank in a review card. Stored per profile. */
export function ProtectedTerms({ lexicon }: { lexicon: Lexicon }) {
  const [terms, setTerms] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [suggested, setSuggested] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await getProtectedTerms(db);
      const entries = await db.journalEntries.toArray();
      if (cancelled) return;
      setTerms(current);
      setText(current.join('、'));
      setSuggested(
        suggestProtectedTerms(
          entries.map((e) => e.text),
          lexicon,
        ).filter((t) => !current.includes(t)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [lexicon]);

  if (!terms) return null;
  const save = async (next: string[]) => {
    await db.settings.put({ key: PROTECTED_TERMS_KEY, value: next });
    setTerms(next);
    setText(next.join('、'));
    setSuggested((s) => s.filter((t) => !next.includes(t)));
    setSaved(true);
  };

  return (
    <details className="protected-terms">
      <summary>Names to protect ({terms.length})</summary>
      <p>
        <small>
          Your own name and the people you write about. The corrector never changes them and they
          are never a blank in a review card.
        </small>
      </p>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        lang="zh-Hant-TW"
        aria-label="Names to protect, separated by commas"
        style={{ width: '100%', fontSize: 16 }}
      />
      <button onClick={() => void save(parseProtectedTerms(text))}>Save</button>
      {saved && <span role="status"> Saved.</span>}
      {suggested.length > 0 && (
        <p>
          Seen in several entries:{' '}
          {suggested.slice(0, 6).map((t) => (
            <button key={t} onClick={() => void save([...terms, t])} lang="zh-Hant-TW">
              + {t}
            </button>
          ))}
        </p>
      )}
    </details>
  );
}
