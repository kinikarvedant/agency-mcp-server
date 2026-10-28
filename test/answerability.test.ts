import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/context.js";
import { isQuestion, scoreAnswerability } from "../src/tools/answerability.js";
import { fixture } from "./helpers.js";

const score = (html: string) => scoreAnswerability(parseHtml(html));

describe("score_answerability", () => {
  it("recognises question headings", () => {
    expect(["How much does it cost?", "What counts as an emergency", "Can I park nearby", "Is it safe?"].every(isQuestion)).toBe(true);
    expect(["Our services", "Pricing", "Howard's story"].some(isQuestion)).toBe(false);
  });

  it("gives a well-structured page full marks", () => {
    const r = score(fixture("good.html"));
    expect(r.components.questionHeadings).toEqual({ points: 25, questions: 2, subheadings: 3 });
    expect(r.components.answerFirst).toMatchObject({ points: 35, passed: 3, checked: 3 });
    expect(r.components.faqMarkup).toEqual({ points: 15, questions: 2, visibleOnPage: 2 });
    expect(r.components.paragraphLength).toMatchObject({ points: 25, overLimit: 0 });
    expect(r.score).toBe(100);
    expect(r.suggestions).toEqual([]);
  });

  it("scores a weak page low and suggests answer-first rewrites", () => {
    const r = score(fixture("bad.html"));
    const drain = r.components.answerFirst.sections.find((s) => s.heading === "Why is my drain blocked?")!;
    expect(drain.pass).toBe(false);
    expect(drain.reason).toBe("Opens with filler instead of the answer.");
    expect(r.components.answerFirst.sections[0]).toMatchObject({ heading: "First heading (page lead)", pass: false });
    expect(r.components.faqMarkup.points).toBe(15); // FAQPage JSON-LD is present, even though it is invalid
    expect(r.components.paragraphLength).toMatchObject({ overLimit: 1 });
    expect(r.score).toBeLessThan(60);
    const s = r.suggestions.find((x) => x.heading === "Why is my drain blocked?")!.suggestion;
    expect(s).toContain('"Hair, grease and tree roots are the usual causes of a blocked drain."');
  });

  it("flags a long first sentence even when it is on topic", () => {
    const long = Array.from({ length: 60 }, () => "drain").join(" ");
    const r = score(`<main><h1>Drains</h1><p>Drains are cleared fast.</p><h2>Why do drains block?</h2><p>${long}.</p></main>`);
    expect(r.components.answerFirst.sections[1]).toMatchObject({ pass: false, firstSentenceWords: 60 });
  });

  it("ignores nav and footer text and reads <summary> as a heading", () => {
    const r = score(`<body><nav><h2>Menu?</h2></nav><main><h1>FAQ</h1><p>Answers to common FAQ questions.</p>
      <details><summary>Do you open on Sunday?</summary><p>No, we open Monday to Saturday.</p></details></main><footer><p>${"word ".repeat(200)}</p></footer></body>`);
    expect(r.components.questionHeadings).toEqual({ points: 25, questions: 1, subheadings: 1 });
    expect(r.components.answerFirst.passed).toBe(2);
    expect(r.components.paragraphLength.overLimit).toBe(0);
  });
});
