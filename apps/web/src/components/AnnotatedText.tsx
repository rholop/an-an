import { useRef, useState } from 'react';
import {
  levelIndex,
  parseSyllableTone,
  senseSourceLabel,
  type Level,
  type ReadingResult,
  type Sense,
  type Token,
  type Word,
} from '@anan/core';
import './AnnotatedText.css';

export interface AnnotatedToken {
  token: Token;
  reading: ReadingResult;
  level: Level | null;
  gloss: string;
  /** The lexicon Word id this token resolved to, if any — needed to turn a
   * lookup into learner-model evidence (Phase 2 §7). */
  wordId?: string;
  /** Phase 7: the matched lexicon word and the sense chosen for THIS token
   * (the model's pick, else context rules, else the primary sense). */
  word?: Word;
  sense?: Sense;
  /** Phase 2 §1 pinyin fading (readingDisplay()), set by the caller per-token
   * from the learner's own card. Only consulted when the page mode is
   * 'auto'; undefined (no card yet, e.g. a never-seen word) behaves like
   * 'shown'. */
  readingMode?: 'shown' | 'hover';
}

export type AnnotationMode = 'always' | 'hover' | 'off' | 'tone-only' | 'auto';
export type AnnotationScript = 'pinyin' | 'zhuyin' | 'both';

export interface AnnotatedTextProps {
  tokens: AnnotatedToken[];
  mode: AnnotationMode;
  script: AnnotationScript;
  /** 'gloss': the learner opened the popover (meaning + reading) — the
   * stronger "didn't know this" signal (chat_lookup_gloss). 'reading': the
   * learner just hovered/glanced at the reading without opening it
   * (chat_hover_reading) — doesn't touch meaning, only readingDependence. */
  onLookup?: (at: AnnotatedToken, kind: 'gloss' | 'reading') => void;
  /** Phase 7: words above this level are highlighted (`an-token--above`). */
  currentLevel?: Level;
  /** Phase 7: the "Report this definition" button. */
  onReportGloss?: (at: AnnotatedToken) => void;
  /** The surrounding sentence, stored with a report. */
  contextText?: string;
}

const tokenId = (t: Token) => `${t.start}-${t.end}`;

const LEVEL_CLASS: Record<Level, string> = {
  N1: 'level-n1',
  N2: 'level-n2',
  L1: 'level-l1',
  L2: 'level-l2',
  L3: 'level-l3',
  L4: 'level-l4',
  L5: 'level-l5',
};

// Tone number -> a contour glyph (IPA tone-letter shapes), used by tone-only
// mode per phase doc §9: "tone marks above characters without letters".
const TONE_CONTOUR: Record<number, string> = {
  1: '˥',
  2: '˧˥',
  3: '˨˩˦',
  4: '˥˩',
  5: '·',
};

/** One contour glyph per syllable in a toned pinyin string ("jié yùn" -> "˧˥ ˥˩"). */
function toneContourOf(pinyin: string): string {
  if (!pinyin) return '';
  return pinyin
    .split(' ')
    .map((syl) => TONE_CONTOUR[parseSyllableTone(syl).tone] ?? '')
    .join(' ');
}

function ZhuyinWord({ at }: { at: AnnotatedToken }) {
  const chars = [...at.token.text];
  const zhuyinSyllables = at.reading.zhuyin ? at.reading.zhuyin.split(' ') : [];
  return (
    <span className="an-word an-word--zhuyin">
      {chars.map((ch, i) => (
        <span className="an-char-cell" key={i}>
          <span className="an-char">{ch}</span>
          <span className="an-zhuyin-col">{zhuyinSyllables[i] ?? ''}</span>
        </span>
      ))}
    </span>
  );
}

function PinyinWord({ at }: { at: AnnotatedToken }) {
  return (
    <ruby className="an-word an-word--pinyin">
      {at.token.text}
      <rt>{at.reading.pinyin}</rt>
    </ruby>
  );
}

function BothWord({ at }: { at: AnnotatedToken }) {
  return (
    <ruby className="an-word an-word--both">
      <ZhuyinWord at={at} />
      <rt>{at.reading.pinyin}</rt>
    </ruby>
  );
}

function ToneOnlyWord({ at }: { at: AnnotatedToken }) {
  return (
    <ruby className="an-word an-word--tone-only">
      {at.token.text}
      <rt>{toneContourOf(at.reading.pinyin)}</rt>
    </ruby>
  );
}

function Popover({
  at,
  onClose,
  showMoeZh,
  onReport,
}: {
  at: AnnotatedToken;
  onClose: () => void;
  showMoeZh: boolean;
  onReport?: () => void;
}) {
  const others = (at.word?.senses ?? []).filter((s) => s.id !== at.sense?.id);
  const moe = at.word?.moeDefZh ?? [];
  return (
    <span className="an-popover" onClick={(e) => e.stopPropagation()}>
      <button className="an-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="an-popover-reading">
        {at.reading.pinyin} · {at.reading.zhuyin}
        {at.reading.confidence === 'low' && (
          <span className="an-confidence-low"> (uncertain reading)</span>
        )}
      </div>
      <div className="an-popover-gloss">{at.gloss || '(no gloss)'}</div>
      {at.sense && <div className="an-popover-source">{senseSourceLabel(at.sense)}</div>}
      {others.length > 0 && (
        <details className="an-popover-others">
          <summary>
            {others.length} other {others.length === 1 ? 'meaning' : 'meanings'}
          </summary>
          <ul>
            {others.map((s) => (
              <li key={s.id}>
                {s.glossEn}
                {s.register && <em> ({s.register})</em>}
                <span className="an-popover-source"> {senseSourceLabel(s)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {showMoeZh && moe.length > 0 && (
        <div className="an-popover-moe" lang="zh-Hant">
          {moe.map((d) => (
            <p key={d}>{d}</p>
          ))}
          <span className="an-popover-source">教育部《重編國語辭典修訂本》</span>
        </div>
      )}
      {at.level && <div className="an-popover-level">{at.level}</div>}
      {onReport && (
        <button className="an-popover-report" onClick={onReport}>
          Report this definition
        </button>
      )}
    </span>
  );
}

export function AnnotatedText({
  tokens,
  mode,
  script,
  onLookup,
  currentLevel,
  onReportGloss,
}: AnnotatedTextProps) {
  // Phase 7: the MOE Chinese definition is shown to learners at L3 and above.
  const showMoeZh = Boolean(currentLevel && levelIndex(currentLevel) >= levelIndex('L3'));
  const [openId, setOpenId] = useState<string | null>(null);
  const hoveredIds = useRef(new Set<string>());

  return (
    <div className="an-text" onClick={() => setOpenId(null)}>
      {tokens.map((at) => {
        const id = tokenId(at.token);
        if (at.token.kind !== 'word') {
          return (
            <span key={id} className={`an-passthrough an-passthrough--${at.token.kind}`}>
              {at.token.text}
            </span>
          );
        }

        const levelClass = at.level ? LEVEL_CLASS[at.level] : 'level-unleveled';
        const autoHover = mode === 'auto' && at.readingMode === 'hover';
        const hoverLike = mode === 'hover' || autoHover;
        const showAnnotation =
          mode === 'always' || mode === 'tone-only' || (mode === 'auto' && !autoHover);
        const isOpen = openId === id;
        const above = Boolean(
          currentLevel && at.level && levelIndex(at.level) > levelIndex(currentLevel),
        );

        const inner =
          mode === 'off' ? (
            at.token.text
          ) : mode === 'tone-only' ? (
            <ToneOnlyWord at={at} />
          ) : script === 'zhuyin' ? (
            <ZhuyinWord at={at} />
          ) : script === 'both' ? (
            <BothWord at={at} />
          ) : (
            <PinyinWord at={at} />
          );

        return (
          <span
            key={id}
            className={`an-token ${levelClass} ${hoverLike ? 'an-token--hover-mode' : ''} ${above ? 'an-token--above' : ''}`}
            title={above ? `${at.level} — above your level (${currentLevel})` : undefined}
            data-visible={hoverLike ? isOpen : showAnnotation}
            onClick={(e) => {
              e.stopPropagation();
              if (!isOpen) onLookup?.(at, 'gloss');
              setOpenId(isOpen ? null : id);
            }}
            onMouseEnter={() => {
              // Hovering only means something when the reading is hidden until
              // hover. With pinyin/zhuyin/both already on screen (or off
              // entirely) the pointer just passes over the text, so only an
              // actual click counts as a lookup.
              if (!hoverLike) return;
              if (hoveredIds.current.has(id)) return;
              hoveredIds.current.add(id);
              onLookup?.(at, 'reading');
            }}
          >
            {inner}
            {isOpen && (
              <Popover
                at={at}
                onClose={() => setOpenId(null)}
                showMoeZh={showMoeZh}
                onReport={onReportGloss ? () => onReportGloss(at) : undefined}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
