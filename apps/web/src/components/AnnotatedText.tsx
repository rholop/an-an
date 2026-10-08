import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AddToReview } from './AddToReview.js';
import { createPortal } from 'react-dom';
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
import { CAN_HOVER_QUERY, SHEET_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { SpeakerButton } from './SpeakerButton.js';
import { REPORT_LABEL, wordSourceLabel } from '../lib/labels.js';
import { recordDefaultLookup, reportDefinition } from '../lib/report-actions.js';
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
  /** Phase 12: the first 來學華語 lesson this word appears in, for the badge. */
  /** Where in the course the word is first taught (book + lesson). */
  textbookHome?: { bookId: string; n: number };
  /** Phase 2 §1 pinyin fading (readingDisplay()), set by the caller per-token
   * from the learner's own card. Only consulted when the page mode is
   * 'auto'; undefined (no card yet, e.g. a never-seen word) behaves like
   * 'shown'. */
  readingMode?: 'shown' | 'hover';
}

export type AnnotationMode = 'always' | 'hover' | 'off' | 'tone-only' | 'auto';
export type AnnotationScript = 'pinyin' | 'zhuyin' | 'both';

export interface AnnotatedTextProps {
  /** A `<span>` root with the surrounding font size, for annotating a word or
   * phrase inside a sentence, list item or tile instead of a whole block. */
  inline?: boolean;
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
  /** Phase 7: the "Something's wrong" button on a definition. Phase 21: when omitted, the shared
   * report (saved for review, toast with Undo) is used, so every popover has it. */
  onReportGloss?: (at: AnnotatedToken) => void;
  /** The surrounding sentence, stored with a report. */
  contextText?: string;
  /** Phase 21: where a lookup happened, when the page gives no `onLookup` (every popover records). */
  lookupSource?: 'reader' | 'textbook' | 'journal' | 'chat' | 'cloze' | 'review';
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
  anchor,
  onOverflow,
  sheet,
  script,
}: {
  at: AnnotatedToken;
  script: AnnotationScript;
  onClose: () => void;
  showMoeZh: boolean;
  onReport?: () => void;
  /** Phones: a full-width bottom sheet (portalled to <body>) instead of a box
   * hanging off the word. Tap outside, swipe down, or × closes it. */
  sheet: boolean;
  /** The text block, and a callback for how far the popover sticks out below
   * its content. The block then pads its bottom by that much, so a
   * definition opened on the last line pushes the content below it down
   * instead of covering it. */
  anchor: React.RefObject<HTMLElement | null>;
  onOverflow: (px: number) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const swipeStart = useRef<number | null>(null);
  // A sheet is pinned to the screen, so it never needs room reserved in the text.
  useEffect(() => {
    if (!sheet) return;
    onOverflow(0);
    // tap anywhere else closes it (a tap on a word is handled by the word itself)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest('.an-popover, .an-token')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [sheet, onClose, onOverflow]);
  useLayoutEffect(() => {
    if (sheet) return;
    const measure = () => {
      const pop = ref.current;
      const root = anchor.current;
      if (!pop || !root) return;
      // Content bottom = the root's bottom minus the padding we added for the
      // popover, so growing the padding doesn't change what we measure against.
      const reserved = parseFloat(getComputedStyle(root).paddingBottom) || 0;
      const overflow =
        pop.getBoundingClientRect().bottom - (root.getBoundingClientRect().bottom - reserved);
      onOverflow(Math.max(0, Math.ceil(overflow) + 8));
    };
    measure();
    // a definition grows when "other senses" / the MOE text is expanded
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    return () => observer?.disconnect();
  }, [anchor, onOverflow, at, sheet]);
  const others = (at.word?.senses ?? []).filter((s) => s.id !== at.sense?.id);
  const moe = at.word?.moeDefZh ?? [];
  const body = (
    <span
      ref={ref}
      className={`an-popover ${sheet ? 'an-popover--sheet' : ''}`}
      role={sheet ? 'dialog' : undefined}
      aria-label={sheet ? `Definition of ${at.token.text}` : undefined}
      onClick={(e) => e.stopPropagation()}
      onTouchStart={sheet ? (e) => (swipeStart.current = e.touches[0]?.clientY ?? null) : undefined}
      onTouchEnd={
        sheet
          ? (e) => {
              const y = e.changedTouches[0]?.clientY;
              if (swipeStart.current !== null && y !== undefined && y - swipeStart.current > 60) onClose();
              swipeStart.current = null;
            }
          : undefined
      }
    >
      {sheet && <span className="an-sheet-grabber" aria-hidden="true" />}
      <button className="an-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="an-popover-reading">
        {/* Phase 21: the chosen script first */}
        {script === 'zhuyin'
          ? [at.reading.zhuyin, at.reading.pinyin].filter(Boolean).join(' · ')
          : [at.reading.pinyin, at.reading.zhuyin].filter(Boolean).join(' · ')}
        {at.reading.confidence === 'low' && (
          <span className="an-confidence-low"> (uncertain reading)</span>
        )}
      </div>
      {at.wordId && (
        <div className="an-popover-audio">
          <SpeakerButton kind="word" id={at.wordId} label={at.token.text} />
        </div>
      )}
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
      {(at.level || at.textbookHome !== undefined) && (
        <div className="an-popover-level" lang="zh-Hant" data-testid={at.textbookHome ? 'textbook-badge' : undefined}>
          {wordSourceLabel(at.level, at.textbookHome)}
        </div>
      )}
      {at.wordId && <AddToReview wordId={at.wordId} />}
      {onReport && (
        <button
          className="an-popover-report"
          onClick={onReport}
          data-testid="report-definition"
          aria-label={`${REPORT_LABEL} with this definition`}
          title="Report this definition"
        >
          {REPORT_LABEL}
        </button>
      )}
    </span>
  );
  return sheet ? createPortal(body, document.body) : body;
}

export function AnnotatedText({
  inline = false,
  tokens,
  mode,
  script,
  onLookup: onLookupProp,
  currentLevel,
  onReportGloss: onReportProp,
  contextText,
  lookupSource,
}: AnnotatedTextProps) {
  // Phase 21: every popover records lookups and can report a definition, page handler or not;
  // repeated opens of the same word in one text count as one lookup.
  const lookedUp = useRef(new Set<string>());
  const onLookup = (at: AnnotatedToken, kind: 'gloss' | 'reading') => {
    if (kind === 'gloss') {
      const key = at.wordId ?? at.token.text;
      if (lookedUp.current.has(key)) return;
      lookedUp.current.add(key);
    }
    if (onLookupProp) onLookupProp(at, kind);
    else void recordDefaultLookup(at, kind, lookupSource).catch(() => undefined);
  };
  const onReportGloss =
    onReportProp ??
    ((at: AnnotatedToken) =>
      void reportDefinition(at, contextText ?? tokens.map((t) => t.token.text).join('')).catch(() => undefined));
  // Phase 7: the MOE Chinese definition is shown to learners at L3 and above.
  const showMoeZh = Boolean(currentLevel && levelIndex(currentLevel) >= levelIndex('L3'));
  const [openId, setOpenId] = useState<string | null>(null);
  const sheet = useMediaQuery(SHEET_QUERY);
  const canHover = useMediaQuery(CAN_HOVER_QUERY);
  // Touch screens have no hover: in the hide-until-hover modes the FIRST tap
  // reveals the reading (and counts as the reading lookup, as a hover does),
  // the second opens the definition, and a tap elsewhere hides it again.
  const [revealId, setRevealId] = useState<string | null>(null);
  useEffect(() => {
    if (canHover || revealId === null) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest('.an-token')) setRevealId(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [canHover, revealId]);
  const hoveredIds = useRef(new Set<string>());
  const rootRef = useRef<HTMLElement>(null);
  // Room reserved under the text while a definition is open (see Popover).
  const Root = inline ? 'span' : 'div';
  const [reserve, setReserve] = useState(0);
  useEffect(() => {
    if (openId === null) setReserve(0);
  }, [openId]);

  return (
    <Root
      ref={rootRef as never}
      className={`an-text ${inline ? 'an-text--inline' : ''}`}
      style={reserve > 0 ? { paddingBottom: reserve } : undefined}
      onClick={() => setOpenId(null)}
    >
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
            // Hovering any character shows its definition (a plain tooltip: it never
            // counts as a lookup — only a click does).
            title={
              isOpen
                ? undefined
                : [at.gloss, above ? `${at.level} — above your level (${currentLevel})` : undefined]
                    .filter(Boolean)
                    .join(' · ') || undefined
            }
            data-visible={hoverLike ? isOpen || revealId === id : showAnnotation}
            onClick={(e) => {
              e.stopPropagation();
              if (!canHover && hoverLike && !isOpen && revealId !== id) {
                setOpenId(null);
                setRevealId(id);
                if (!hoveredIds.current.has(id)) {
                  hoveredIds.current.add(id);
                  onLookup(at, 'reading');
                }
                return;
              }
              if (!isOpen) onLookup(at, 'gloss');
              setRevealId(null);
              setOpenId(isOpen ? null : id);
            }}
            onMouseEnter={() => {
              // Hovering only means something when the reading is hidden until
              // hover. With pinyin/zhuyin/both already on screen (or off
              // entirely) the pointer just passes over the text, so only an
              // actual click counts as a lookup.
              if (!hoverLike || !canHover) return; // touch: handled by the tap above
              if (hoveredIds.current.has(id)) return;
              hoveredIds.current.add(id);
              onLookup(at, 'reading');
            }}
          >
            {inner}
            {isOpen && (
              <Popover
                at={at}
                onClose={() => setOpenId(null)}
                showMoeZh={showMoeZh}
                onReport={() => onReportGloss(at)}
                script={script}
                anchor={rootRef}
                onOverflow={setReserve}
                sheet={sheet}
              />
            )}
          </span>
        );
      })}
    </Root>
  );
}
