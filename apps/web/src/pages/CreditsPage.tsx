import { useEffect, useState } from 'react';
import { db } from '../db/instance.js';
import type { AiGlossRow, GlossReportRow } from '../db/schema.js';
import { exportReportsAsOverridesYaml } from '../lib/gloss-reports.js';

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
    name: 'Unicode Unihan database',
    what: 'Per-character English definitions for the character-breakdown help. Optional source.',
    licence: 'Unicode Terms of Use (permissive)',
    href: 'https://www.unicode.org/charts/unihan.html',
    terms: 'Copyright © Unicode, Inc.',
  },
];

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
