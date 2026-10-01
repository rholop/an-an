import { useRef, useState } from 'react';
import { parseSyllableTone, type Level, type ReadingResult, type Token } from '@anan/core';
import './AnnotatedText.css';

export interface AnnotatedToken {
  token: Token;
  reading: ReadingResult;
  level: Level | null;
  gloss: string;
  /** The lexicon Word id this token resolved to, if any — needed to turn a
   * lookup into learner-model evidence (Phase 2 §7). */
  wordId?: string;
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
}

const tokenId = (t: Token) => `${t.start}-${t.end}`;

const LEVEL_CLASS: Record<Level, string> = {
  N1: 'level-n1', N2: 'level-n2', L1: 'level-l1', L2: 'level-l2',
  L3: 'level-l3', L4: 'level-l4', L5: 'level-l5', L6: 'level-l6',
};

// Tone number -> a contour glyph (IPA tone-letter shapes), used by tone-only
// mode per phase doc §9: "tone marks above characters without letters".
const TONE_CONTOUR: Record<number, string> = {
  1: '˥', 2: '˧˥', 3: '˨˩˦', 4: '˥˩', 5: '·',
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

function Popover({ at, onClose }: { at: AnnotatedToken; onClose: () => void }) {
  return (
    <span className="an-popover" onClick={(e) => e.stopPropagation()}>
      <button className="an-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="an-popover-reading">
        {at.reading.pinyin} · {at.reading.zhuyin}
        {at.reading.confidence === 'low' && <span className="an-confidence-low"> (uncertain reading)</span>}
      </div>
      <div className="an-popover-gloss">{at.gloss || '(no gloss)'}</div>
      {at.level && <div className="an-popover-level">{at.level}</div>}
    </span>
  );
}

export function AnnotatedText({ tokens, mode, script, onLookup }: AnnotatedTextProps) {
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
        const showAnnotation = mode === 'always' || mode === 'tone-only' || (mode === 'auto' && !autoHover);
        const isOpen = openId === id;

        const inner =
          mode === 'off'
            ? at.token.text
            : mode === 'tone-only'
              ? <ToneOnlyWord at={at} />
              : script === 'zhuyin'
                ? <ZhuyinWord at={at} />
                : script === 'both'
                  ? <BothWord at={at} />
                  : <PinyinWord at={at} />;

        return (
          <span
            key={id}
            className={`an-token ${levelClass} ${hoverLike ? 'an-token--hover-mode' : ''}`}
            data-visible={hoverLike ? isOpen : showAnnotation}
            onClick={(e) => {
              e.stopPropagation();
              if (!isOpen) onLookup?.(at, 'gloss');
              setOpenId(isOpen ? null : id);
            }}
            onMouseEnter={() => {
              if (hoveredIds.current.has(id)) return;
              hoveredIds.current.add(id);
              onLookup?.(at, 'reading');
            }}
          >
            {inner}
            {isOpen && <Popover at={at} onClose={() => setOpenId(null)} />}
          </span>
        );
      })}
    </div>
  );
}
