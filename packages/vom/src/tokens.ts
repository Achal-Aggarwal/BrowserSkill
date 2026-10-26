// Token estimate for observation budgets (`--max-tokens`).
//
// Real tokenizers (o200k, cl100k) first split text into pieces with a regex
// and only then run BPE inside each piece, so a piece's cost depends on what
// kind of piece it is, not on raw character counts:
//
// - common English words, with their leading space, are one token;
// - longer or non-English words cost more per character;
// - a run of spaces (VOM indentation) is one token, a digit group of up to
//   three is one token;
// - punctuation runs cost about one token per two characters;
// - Han text costs ~0.76 token per character (Traditional ~0.93), kana ~0.66
//   and Hangul ~0.47.
//
// We split text with the o200k pre-tokenizer regex and cost each piece with
// a few fitted constants. No vocabulary is loaded. On a mixed corpus (repo
// docs, CHANGELOG, code blocks, UI strings in 10 locales and VOM pages built
// from them) the result lands within about ±6% of o200k on average for every
// group, against 1.66x for English prose with the previous estimate
// (`vom-script-v1`). SAFETY_FACTOR keeps the remaining error on the high side.
//
// Counts are o200k-equivalent. Other tokenizers differ: cl100k needs ~1.3x
// more for CJK text, and newer Claude tokenizers are reported to need more
// tokens than o200k for the same text.

export const TOKEN_ESTIMATOR = "vom-pretok-v2";

/** Multiplier on the central estimate so a budget errs high, not low. */
const SAFETY_FACTOR = 1.05;

// The o200k pre-tokenizer pattern. BPE never merges across these pieces.
const PIECE =
  /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'[sStTmMdD]|'[rR][eE]|'[vV][eE]|'[lL][lL])?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'[sStTmMdD]|'[rR][eE]|'[vV][eE]|'[lL][lL])?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

const LETTER = /[\p{L}\p{M}]/u;

/** English function words: their share tells English text from other Latin-script languages. */
const ENGLISH_FUNCTION_WORDS = new Set(
  "a about after all also an and are as at be been before but by can do does for from had has have if in into is it its more no not of on or than that the their these they this those to was we were what when which will with you your".split(
    " ",
  ),
);
const ENGLISH_MIN_SHARE = 0.1;

/** Common characters that exist only in Traditional Chinese; their presence marks costlier Han text. */
const TRADITIONAL_ONLY = new Set(
  "這個們為會說時開關選擇設資訊頁點錄載動號碼應該與對見後從際實現發經過還進給覺長間問題無來東車書電話網線讀寫請認識處檔畫視窗區單擊顯啟儲體驗證權據傳輸複製連結帳戶務歷種類標籤屬隱藏圖裝備註冊維護輕鬆試產專業學習師議並節員總統勢況環遠運氣燈萬億態濟術輯稱擁樣變價買賣廣層頭慣歡邊",
);

/**
 * VOM role and state words, with their o200k cost after a space. They are
 * part of the format, so they are costed exactly instead of by the word
 * curves (which would treat `navigation` on a non-English page as foreign).
 */
const VOM_WORDS = new Map<string, number>();
for (const word of "alert article banner button canvas cell checkbox checked complementary ctx definition dialog directory disabled document empty feed figure filled first focus form generic grid group heading hover iframe img layers link list main menu mixed more navigation nodes none option page paragraph placeholder presentation radio region row scrollbar search section separator slider status switch tab table term textarea textbox toolbar tooltip tree unchecked view vom".split(
  " ",
))
  VOM_WORDS.set(word, 1);
for (const word of "alertdialog columnheader combobox contentinfo gridcell listbox listitem menubar menuitem occluded progressbar rowgroup rowheader searchbox spinbutton tablist tabpanel treeitem".split(
  " ",
))
  VOM_WORDS.set(word, 2);
for (const word of ["menuitemcheckbox", "menuitemradio", "radiogroup"]) VOM_WORDS.set(word, 3);

// Fitted against o200k (gpt-tokenizer 2.9.0); see `__tests__/tokens.test.ts`.
const W = {
  /** Extra cost per ASCII punctuation character beyond the first two in a run. */
  punctExtra: 0.2,
  /** Extra cost per non-ASCII symbol (`•`, `→`, emoji) beyond the first character of a run. */
  symbolExtra: 0.9,
  /** A word glued to a leading punctuation mark (`"Home`, `(see`, `/path`). */
  gluedPrefix: 0.35,
  /** Words: [length that is still one token, extra cost per character beyond it]. */
  englishLower: [7, 0.06],
  englishCapital: [10, 0.05],
  otherLower: [5.5, 0.23],
  otherCapital: [7, 0.42],
  /** Long words never cost more than this many characters per token (German compounds). */
  longWordCharsPerToken: 4.5,
  allCapsPerChar: 0.28,
  /** Extra per accented or other non-ASCII Latin letter. */
  nonAsciiLetter: 0.09,
  /** Letter runs this long are identifiers or hashes, not words. */
  identifierLength: 30,
  identifierCharsPerToken: 1.9,
  han: 0.76,
  hanTraditional: 0.93,
  hanBase: 0.22,
  kana: 0.66,
  kanaBase: 0.21,
  hangul: 0.465,
  hangulBase: 0.64,
} as const;

function isHan(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  );
}

function isKana(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff66 && cp <= 0xff9f)
  );
}

function isHangul(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  );
}

/** One pass over the pieces: is this English text, and does it contain Traditional-only Han? */
function scanText(pieces: string[]): { english: boolean; traditional: boolean } {
  let words = 0;
  let functionWords = 0;
  let traditional = false;
  for (const piece of pieces) {
    const start = piece.charCodeAt(0) === 0x20 ? 1 : 0;
    const c = piece.charCodeAt(start) | 0x20;
    if (c >= 0x61 && c <= 0x7a) {
      words++;
      if (piece.length - start <= 6 && ENGLISH_FUNCTION_WORDS.has(piece.slice(start).toLowerCase()))
        functionWords++;
    } else if (!traditional && piece.charCodeAt(start) >= 0x3400) {
      for (const ch of piece) {
        if (TRADITIONAL_ONLY.has(ch)) {
          traditional = true;
          break;
        }
      }
    }
  }
  return { english: words > 0 && functionWords / words >= ENGLISH_MIN_SHARE, traditional };
}

function wordCost(letters: number, upper: number, nonAscii: number, english: boolean): number {
  if (letters >= W.identifierLength) return letters / W.identifierCharsPerToken;
  let cost: number;
  if (upper > 1 && upper === letters) {
    cost = 1 + (letters - 2) * W.allCapsPerChar;
  } else {
    const capital = upper > 0;
    const [free, perChar] =
      english && nonAscii === 0
        ? capital
          ? W.englishCapital
          : W.englishLower
        : capital
          ? W.otherCapital
          : W.otherLower;
    cost = Math.min(
      1 + Math.max(0, letters - free) * perChar,
      Math.max(1, letters / W.longWordCharsPerToken),
    );
  }
  return cost + nonAscii * W.nonAsciiLetter;
}

function pieceCost(piece: string, english: boolean, traditional: boolean): number {
  const first = piece.charCodeAt(0);
  if (first >= 0x30 && first <= 0x39) return 1; // digit group (at most three)
  if (piece.trim() === "") return 1; // whitespace or newline run

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let letters = 0;
  let upper = 0;
  let nonAscii = 0;
  let symbols = 0;
  let wideSymbols = 0;
  let glued = false;
  for (let i = 0; i < piece.length; i++) {
    let cp = piece.charCodeAt(i);
    if (cp < 0x80) {
      if (cp >= 0x61 && cp <= 0x7a) letters++;
      else if (cp >= 0x41 && cp <= 0x5a) {
        letters++;
        upper++;
      } else if (cp !== 0x20) {
        symbols++;
        if (i === 0) glued = true;
      }
      continue;
    }
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < piece.length) {
      cp = ((cp - 0xd800) << 10) + (piece.charCodeAt(++i) - 0xdc00) + 0x10000;
    }
    if (isHan(cp)) han++;
    else if (isKana(cp)) kana++;
    else if (isHangul(cp)) hangul++;
    else if (LETTER.test(String.fromCodePoint(cp))) {
      letters++;
      nonAscii++;
    } else {
      wideSymbols++;
      if (i === 0) glued = true;
    }
  }

  if (han + kana + hangul > 0) {
    let cost = glued ? W.gluedPrefix : 0;
    if (kana > 0) cost += W.kanaBase + (kana + han) * W.kana;
    else if (han > 0) cost += W.hanBase + han * (traditional ? W.hanTraditional : W.han);
    if (hangul > 0) cost += W.hangulBase + hangul * W.hangul;
    return cost + letters / 4;
  }
  if (letters === 0) {
    const firstIsWide = symbols === 0 ? 1 : 0;
    return (
      1 +
      Math.max(0, symbols - 2) * W.punctExtra +
      Math.max(0, wideSymbols - firstIsWide) * W.symbolExtra
    );
  }
  if (piece === "@e") return 2; // VOM ref marker at the start of a line: `@` and `e`
  if (glued || wideSymbols > 0) return W.gluedPrefix + wordCost(letters, upper, nonAscii, english);
  if (upper === 0 && nonAscii === 0) {
    const known = VOM_WORDS.get(piece.charCodeAt(0) === 0x20 ? piece.slice(1) : piece);
    if (known !== undefined) return known;
  }
  return wordCost(letters, upper, nonAscii, english);
}

/** Unrounded estimate, for summing many short lines without rounding each. */
function rawEstimate(text: string): number {
  const pieces = text.match(PIECE);
  if (!pieces) return 0;
  const { english, traditional } = scanText(pieces);
  let total = 0;
  for (const piece of pieces) total += pieceCost(piece, english, traditional);
  return total * SAFETY_FACTOR;
}

/** Estimated o200k-equivalent tokens for `text`. */
export function estimateTokens(text: string): number {
  return Math.ceil(rawEstimate(text));
}

/**
 * Cost of one rendered line, including the newline that joins it to the
 * next. Not rounded, so a budget summed over many rows does not pay a
 * rounding error per row.
 */
export function estimateLineTokens(line: string): number {
  return rawEstimate(line) + 1;
}
