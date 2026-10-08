import { useEffect, useState } from 'react';
import { useProfile } from '../components/ProfileGate.js';
import { backupFileName, exportBackup, importBackup } from '../db/backup.js';
import { db } from '../db/instance.js';
import type { AiGlossRow, GlossReportRow } from '../db/schema.js';
import { exportReportsAsOverridesYaml } from '../lib/gloss-reports.js';
import { useSetting } from '../lib/useSetting.js';

/** Every dictionary/data source bundled in the app, with the licence terms
 * that require attribution (phase doc B7). Keep in sync with data/raw/SOURCES.md. */
export const CREDITS: {
  name: string;
  what: string;
  licence: string;
  href: string;
  terms: string;
}[] = [
  {
    name: 'CC-CEDICT',
    what: 'English glosses for most words (via the ivankra/tocfl merge of CC-CEDICT onto the TOCFL list).',
    licence: 'CC BY-SA 4.0',
    href: 'https://cc-cedict.org/wiki/',
    terms:
      'Attribution + share-alike: the derived gloss data in this app is offered under the same licence.',
  },
  {
    name: 'English Wiktionary (via wiktextract / kaikki.org)',
    what: 'Sense-by-sense English glosses with Taiwan/Mainland tags. Optional source: included only in builds where the dump was available.',
    licence: 'CC BY-SA 4.0',
    href: 'https://kaikki.org/',
    terms: 'Attribution + share-alike.',
  },
  {
    name: '教育部《重編國語辭典修訂本》 (MOE Revised Mandarin Chinese Dictionary)',
    what: 'Authoritative Taiwan readings and the Chinese definitions shown to L3+ learners.',
    licence: 'CC BY-ND 3.0 TW',
    href: 'https://language.moe.gov.tw/001201/Detail?sid=36',
    terms:
      'Shown verbatim and unaltered, with credit to the Ministry of Education, R.O.C. (Taiwan).',
  },
  {
    name: 'TOCFL / SC-TOP word lists (Taiwan Ministry of Education)',
    what: 'The 8,000-word vocabulary and level structure (2023 list). The 2010–2011 list was used only as a build-time hint for which sense was meant.',
    licence: 'Per the Steering Committee for the Test of Proficiency–Huayu (SC-TOP)',
    href: 'https://tocfl.edu.tw/',
    terms: 'Word list used for study; parsed copies from ivankra/tocfl.',
  },
  {
    name: 'Microsoft Azure AI Speech (neural text-to-speech, zh-TW)',
    what: 'The spoken clips for words and sentences. Generated offline from the Ministry of Education readings, checked by speech-to-text and by a person, and stored as static files.',
    licence: 'Microsoft Azure AI Services terms',
    href: 'https://azure.microsoft.com/products/ai-services/ai-speech',
    terms: 'Synthesized audio produced under the owner’s own Azure Speech subscription.',
  },
  {
    name: 'Unicode Unihan database',
    what: 'Per-character English definitions for the character-breakdown help. Optional source.',
    licence: 'Unicode Terms of Use (permissive)',
    href: 'https://www.unicode.org/charts/unihan.html',
    terms: 'Copyright © Unicode, Inc.',
  },
  {
    name: 'Nunito typeface (Vernon Adams, Cyreal; via Google Fonts)',
    what: 'The rounded font for English headings. Served from this site (Latin subset).',
    licence: 'SIL Open Font License 1.1',
    href: 'https://fonts.google.com/specimen/Nunito',
    terms: 'Free to use, bundle and redistribute with the app.',
  },
];

/** Phase 10 §7: per-profile switch for every speaker button. */
function AudioSettingsPanel() {
  const [enabled, setEnabled] = useSetting<boolean>('audioEnabled', true);
  const [listening, setListening] = useSetting<boolean>('listeningEnabled', true);
  return (
    <section>
      <h2>Audio</h2>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="audio-toggle"
        />{' '}
        Show speaker buttons
      </label>
      <label>
        <input
          type="checkbox"
          checked={listening}
          disabled={!enabled}
          onChange={(e) => setListening(e.target.checked)}
          data-testid="listening-toggle"
        />{' '}
        Listening practice (Listen session and listening exercises in review)
      </label>
    </section>
  );
}

/** Phase 8 §6: backup export/import for the CURRENT profile only; the file
 * name carries the profile id so two people's files can't be mixed up. */
function BackupPanel() {
  const { profile } = useProfile();
  const [message, setMessage] = useState<string | null>(null);

  async function exportNow() {
    const backup = await exportBackup(db);
    const blob = new Blob([JSON.stringify({ ...backup, profileId: profile.id }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = backupFileName(profile.id);
    a.click();
    URL.revokeObjectURL(a.href);
    setMessage(`Saved ${a.download}`);
  }

  async function importFile(file: File) {
    try {
      const raw = JSON.parse(await file.text()) as { profileId?: string };
      if (raw.profileId && raw.profileId !== profile.id) {
        setMessage(
          `That file belongs to "${raw.profileId}", not ${profile.name}. Switch profile first.`,
        );
        return;
      }
      if (
        !window.confirm(
          `Replace ${profile.name}'s progress on this device with the contents of ${file.name}?`,
        )
      )
        return;
      const result = await importBackup(db, raw);
      setMessage(`Restored ${result.itemCount} items. Reload the page to see everything.`);
    } catch (err) {
      setMessage(`Couldn't import: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <section>
      <h2>
        Your data (<span lang="zh-Hant">{profile.name}</span>)
      </h2>
      <button onClick={() => void exportNow()}>Export backup</button>{' '}
      <label>
        Import backup{' '}
        <input
          type="file"
          accept="application/json"
          onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
        />
      </label>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function CreditsPage() {
  const [reports, setReports] = useState<GlossReportRow[]>([]);
  const [ai, setAi] = useState<AiGlossRow[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void Promise.all([db.glossReports.toArray(), db.aiGlosses.toArray()]).then(([r, a]) => {
      setReports(r);
      setAi(a);
    });
  }, []);

  const yaml = exportReportsAsOverridesYaml(reports, ai);

  return (
    <div className="credits-page">
      <h1>Credits &amp; licences</h1>
      <p>
        Definitions in An&apos;an are condensed from the sources below. Each definition shows where
        it came from; if one looks wrong, use <strong>Report this definition</strong> in the word
        popover.
      </p>
      <ul className="credits-list" data-testid="credits-list">
        {CREDITS.map((c) => (
          <li key={c.name}>
            <h2>
              <a href={c.href} target="_blank" rel="noreferrer">
                {c.name}
              </a>
            </h2>
            <p>{c.what}</p>
            <p>
              <strong>Licence:</strong> {c.licence}. {c.terms}
            </p>
          </li>
        ))}
      </ul>

      <AudioSettingsPanel />

      <BackupPanel />

      <h2>Reported definitions ({reports.length})</h2>
      {reports.length === 0 && ai.length === 0 ? (
        <p>Nothing reported yet.</p>
      ) : (
        <>
          <p>
            Stored on this device only. Copy this list into{' '}
            <code>data/supplement/gloss-overrides.yaml</code> after correcting each gloss.
            {ai.length > 0 &&
              ` Includes ${ai.length} AI-generated definition(s) of words that are not in the dictionary.`}
          </p>
          <textarea
            readOnly
            value={yaml}
            rows={10}
            style={{ width: '100%' }}
            aria-label="Exported reports"
          />
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(yaml).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
    </div>
  );
}
