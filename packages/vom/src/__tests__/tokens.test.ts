import { describe, expect, it } from "vitest";
import { estimateLineTokens, estimateTokens } from "../tokens";

// Reference counts come from the o200k tokenizer (gpt-tokenizer 2.9.0). They
// are recorded here so the test does not depend on a tokenizer package.
const FIXTURES: { name: string; text: string; reference: number }[] = [
  {
    name: "English VOM",
    text: [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Shop"',
      '    navigation "Main menu"',
      '      @e1 link "Home"',
      "    main",
      '      heading "Today\'s picks"',
      '      @e2 button "Add to cart"',
    ].join("\n"),
    reference: 66,
  },
  {
    name: "Chinese VOM",
    text: [
      "@vom 1",
      "@view 1280x720",
      "@layers 1 focus=L1",
      "L1 page",
      '  RootWebArea "Shop"',
      '    navigation "主菜单"',
      '      @e1 link "首页"',
      "    main",
      '      heading "今日推荐"',
      '      @e2 button "加入购物车"',
    ].join("\n"),
    reference: 65,
  },
  {
    name: "Chinese body text",
    text: "这是一个关于商品退货政策的说明页面，用户可以在三十天内申请无理由退货，但需要保持商品包装完整并提供购买凭证。",
    reference: 35,
  },
  {
    name: "Japanese VOM",
    text: '@e3 button "カートに追加"\n@e4 link "注文履歴を見る"',
    reference: 20,
  },
  {
    name: "Korean VOM",
    text: '@e5 button "장바구니에 담기"\n@e6 link "주문 내역 보기"',
    reference: 24,
  },
];

describe("estimateTokens", () => {
  it.each(FIXTURES)("stays within 15% of the reference for $name", ({ text, reference }) => {
    const estimate = estimateTokens(text);
    expect(Math.abs(estimate - reference) / reference).toBeLessThanOrEqual(0.15);
  });

  it("no longer undercounts the fixtures like ceil(chars / 4) did", () => {
    for (const { text, reference } of FIXTURES) {
      expect(Math.ceil(text.length / 4)).toBeLessThan(reference * 0.85);
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(reference * 0.85);
    }
  });

  it("errs high, not low, for plain English prose", () => {
    const prose =
      "This page explains the return policy: customers may return items within thirty days without giving a reason, provided the packaging is intact and proof of purchase is supplied.";
    // o200k reference: 31 tokens.
    expect(estimateTokens(prose)).toBeGreaterThanOrEqual(31);
  });

  it("counts empty text as zero and newlines as tokens", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("\n\n")).toBe(2);
    expect(estimateLineTokens("")).toBe(1);
  });

  it("counts astral characters once", () => {
    expect(estimateTokens("😀")).toBe(1);
  });
});
