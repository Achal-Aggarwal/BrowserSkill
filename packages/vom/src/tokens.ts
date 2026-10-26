// Token estimate for observation budgets (`--max-tokens`).
//
// `ceil(chars / 4)` fits English prose, but observation text is dominated by
// indentation, quotes, `@eN` refs and short role words, which tokenize at
// about 3 characters per token. CJK text costs 0.6-1 token per character.
// The old estimate undercounted VOM output by 1.4x for English pages and up to
// 2.5x for Chinese body text, so budgets were silently exceeded.
//
// The weights below were fitted against the o200k tokenizer on VOM-format
// fixtures (see `__tests__/tokens.test.ts`). They deliberately err high for
// plain English prose: a budget is a cap, so overestimating is the safe side.

/** Hangul syllables and jamo: about one token each. */
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
/** CJK ideographs, kana, CJK punctuation and full-width forms. */
const WIDE = /[⺀-鿿豈-﫿︰-﹏＀-￯]/u;

const WIDE_WEIGHT = 0.7;
const NARROW_CHARS_PER_TOKEN = 3;

export const TOKEN_ESTIMATOR = "vom-script-v1";

/** Estimated model tokens for `text`, counting each newline as one token. */
export function estimateTokens(text: string): number {
  let hangul = 0;
  let wide = 0;
  let narrow = 0;
  let lines = 0;
  for (const ch of text) {
    if (ch === "\n") lines++;
    else if (HANGUL.test(ch)) hangul++;
    else if (WIDE.test(ch)) wide++;
    else narrow++;
  }
  return Math.ceil(hangul + wide * WIDE_WEIGHT + narrow / NARROW_CHARS_PER_TOKEN + lines);
}

/** Cost of one rendered line, including the newline that joins it to the next. */
export function estimateLineTokens(line: string): number {
  return estimateTokens(line) + 1;
}
