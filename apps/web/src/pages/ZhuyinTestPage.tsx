// Comparison page for phase doc §9's zhuyin-rendering test: (a) CSS
// `ruby-position: inter-character`, (b) a custom flex layout per character
// using `writing-mode: vertical-rl` for the zhuyin column, (c) a zhuyin
// OpenType font. See docs/zhuyin-rendering.md for the decision and
// screenshots.
import './ZhuyinTestPage.css';

const SAMPLE_WORDS: { hanzi: string; zhuyin: string[] }[] = [
  { hanzi: '捷運', zhuyin: ['ㄐㄧㄝˊ', 'ㄩㄣˋ'] },
  { hanzi: '便利商店', zhuyin: ['ㄅㄧㄢˋ', 'ㄌㄧˋ', 'ㄕㄤ', 'ㄉㄧㄢˋ'] },
  { hanzi: '我們', zhuyin: ['ㄨㄛˇ', '˙ㄇㄣ'] },
];

function ApproachA_RubyInterCharacter() {
  return (
    <p className="zt-sample zt-a">
      {SAMPLE_WORDS.map(({ hanzi, zhuyin }, wi) => (
        <span key={wi} style={{ marginRight: '1em' }}>
          {[...hanzi].map((ch, i) => (
            <ruby key={i} className="zt-a-ruby">
              {ch}
              <rt>{zhuyin[i]}</rt>
            </ruby>
          ))}
        </span>
      ))}
    </p>
  );
}

function ApproachB_CustomFlexVertical() {
  return (
    <p className="zt-sample zt-b">
      {SAMPLE_WORDS.map(({ hanzi, zhuyin }, wi) => (
        <span className="zt-b-word" key={wi}>
          {[...hanzi].map((ch, i) => (
            <span className="zt-b-cell" key={i}>
              <span className="zt-b-char">{ch}</span>
              <span className="zt-b-zhuyin">{zhuyin[i]}</span>
            </span>
          ))}
        </span>
      ))}
    </p>
  );
}

export function ZhuyinTestPage() {
  return (
    <div className="zhuyin-test-page">
      <h1>Zhuyin rendering comparison</h1>

      <h2>(a) CSS ruby-position: inter-character</h2>
      <ApproachA_RubyInterCharacter />

      <h2>(b) Custom flex + writing-mode: vertical-rl</h2>
      <ApproachB_CustomFlexVertical />

      <h2>(c) Zhuyin OpenType font</h2>
      <p>
        Not attempted — no bundleable, license-clear zhuyin annotation font was available in this
        offline environment. See docs/zhuyin-rendering.md.
      </p>
    </div>
  );
}
