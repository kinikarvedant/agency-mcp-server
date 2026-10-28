import { clean, getHtml, jsonLd, wordCount, type Ctx } from "../context.js";
import type { HTMLElement } from "node-html-parser";

const QUESTION_START = /^(who|what|when|where|why|how|which|can|could|do|does|did|is|are|should|will|would|may)\b/i;
const FILLER = /^(welcome|in this (article|post|guide|page|section)|great question|let'?s|before we|have you ever|we('re| are) (here|glad|happy)|read on|find out|click|learn more|thanks?\b)/i;
const STOP = new Set(("the and for with from are was were been does did can could should would will may you your our its this that these those " +
  "how what why when where who which into about than then they them there here not yes have has had get").split(" "));

export const isQuestion = (t: string) => t.trim().endsWith("?") || QUESTION_START.test(t.trim());
// ponytail: a 4-letter prefix stands in for a stemmer (dentist/dental, plumber/plumbing); swap in a real stemmer if matching matters more
const terms = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 4)));
const sentences = (s: string) => (clean(s).match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? []).map((x) => x.trim()).filter(Boolean);
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((t) => b.has(t)).length;
const firstWords = (s: string, n: number) => { const w = clean(s).split(" "); return w.length > n ? `${w.slice(0, n).join(" ")}…` : clean(s); };

const LONG_PARAGRAPH = 80;
const ANSWER_WORDS = 50;

interface Section { heading: string; level: number; text: string[] }

function sectionsOf(main: HTMLElement): Section[] {
  const sections: Section[] = [];
  let cur: Section = { heading: "", level: 0, text: [] };
  for (const el of main.querySelectorAll("h1, h2, h3, h4, h5, h6, summary, p, li")) {
    const tag = el.tagName.toLowerCase();
    if (tag === "li" && el.querySelector("p")) continue; // its <p> children are read instead
    const text = clean(el.text);
    if (!text) continue;
    if (/^h\d$/.test(tag) || tag === "summary") {
      sections.push(cur);
      cur = { heading: text, level: tag === "summary" ? 3 : Number(tag[1]), text: [] };
    } else cur.text.push(text);
  }
  sections.push(cur);
  return sections.filter((s) => s.heading || s.text.length);
}

/** Does the text under a question open with a short, direct answer? */
function answerCheck(question: string, text: string[], lead = false) {
  const body = text.join(" ");
  const first = sentences(body)[0] ?? "";
  const n = wordCount(first);
  const q = terms(question);
  const direct = overlap(q, terms(first)) > 0 || /^(yes|no)\b/i.test(first) || /[\d$]/.test(first);
  let reason: string | null = null;
  if (!first) reason = lead ? "No text after the h1." : "No text under this heading.";
  else if (FILLER.test(first)) reason = "Opens with filler instead of the answer.";
  else if (n > ANSWER_WORDS) reason = `The first sentence runs ${n} words, so the answer is not inside the first ${ANSWER_WORDS}.`;
  else if (!direct) reason = "The first sentence shares no key words with the question, so it may not answer it.";

  let suggestion: string | null = null;
  if (reason) {
    const best = sentences(body)
      .map((s, i) => ({ s, i, score: overlap(q, terms(s)) }))
      .filter((c) => c.score > 0 && !FILLER.test(c.s))
      // Most shared key words first, then one short enough to lead with, then the earliest.
      .sort((a, b) => b.score - a.score || Number(wordCount(a.s) > ANSWER_WORDS) - Number(wordCount(b.s) > ANSWER_WORDS) || a.i - b.i)[0];
    suggestion = best && (best.i > 0 || n > ANSWER_WORDS)
      ? `Lead with the answer in under ${ANSWER_WORDS} words, then explain. Closest answer sentence in this section: "${firstWords(best.s, ANSWER_WORDS)}"`
      : lead
        ? `Open the page with one sentence, under ${ANSWER_WORDS} words, saying what "${question}" is or offers.`
        : `Open with a one-sentence answer to "${question}" in under ${ANSWER_WORDS} words, then explain.`;
  }
  return { heading: lead ? `${question} (page lead)` : question, pass: !reason, firstSentenceWords: n, reason, suggestion };
}

/** FAQPage questions in the JSON-LD, wherever they sit (top level, @graph or nested). */
function faqQuestions(doc: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== "object" || v === null) return;
    const n = v as Record<string, unknown>;
    if ([n["@type"]].flat().includes("FAQPage"))
      for (const q of [n.mainEntity].flat()) if (q && typeof (q as { name?: unknown }).name === "string") out.push((q as { name: string }).name);
    Object.values(n).forEach(walk);
  };
  jsonLd(doc).forEach((b) => walk(b.data));
  return out;
}

export const METHOD =
  "Deterministic heuristic, 0-100. Question headings (25): share of h2-h4/summary headings phrased as questions, full marks at half or more. " +
  `Answer first (35): share of question sections, plus the page lead (the first text after the h1), whose first sentence is at most ${ANSWER_WORDS} words, is not filler, and shares a key word with the heading (or opens with yes/no or a number). ` +
  "FAQ markup (15): FAQPage JSON-LD with at least one question. " +
  `Paragraph length (25): share of paragraphs of ${LONG_PARAGRAPH} words or fewer. It measures how extractable answers are, not whether they are correct.`;

export function scoreAnswerability(doc: HTMLElement) {
  const faq = faqQuestions(doc); // read before chrome is stripped: JSON-LD often sits in <head>
  const main = doc.querySelector("main") ?? doc.querySelector("body") ?? doc;
  main.querySelectorAll("nav, header, footer, aside, script, style, noscript, form").forEach((el) => el.remove());

  const sections = sectionsOf(main);
  const subheads = sections.filter((s) => s.level >= 2);
  const questions = subheads.filter((s) => isQuestion(s.heading));
  // The lead is the first text after the h1, even when a subheading comes first: its opening ~50 words are what gets quoted.
  const h1 = Math.max(0, sections.findIndex((s) => s.level === 1));
  const leadText = sections.slice(h1).flatMap((s) => s.text).slice(0, 3);
  const checks = [
    ...(leadText.length ? [answerCheck(sections[h1].heading || "the page topic", leadText, true)] : []),
    ...questions.map((s) => answerCheck(s.heading, s.text)),
  ];
  const paragraphs = main.querySelectorAll("p").map((p) => wordCount(p.text)).filter((n) => n > 0);
  const long = paragraphs.filter((n) => n > LONG_PARAGRAPH);
  const pageText = clean(main.text).toLowerCase();

  const q = subheads.length ? Math.min(1, (questions.length / subheads.length) * 2) : 0;
  const af = checks.length ? checks.filter((c) => c.pass).length / checks.length : 0;
  const fq = faq.length ? 1 : 0;
  const pl = paragraphs.length ? (paragraphs.length - long.length) / paragraphs.length : 0;

  const suggestions = checks.filter((c) => c.suggestion).map((c) => ({ heading: c.heading, suggestion: c.suggestion! }));
  if (subheads.length && !questions.length)
    suggestions.push({ heading: "(page)", suggestion: `None of the ${subheads.length} subheadings is a question. Where a section answers something customers ask, use that question as its heading.` });
  if (!faq.length && questions.length >= 2)
    suggestions.push({ heading: "(page)", suggestion: "The page answers several questions but has no FAQPage JSON-LD; mark up the visible questions and answers." });
  if (long.length) suggestions.push({ heading: "(page)", suggestion: `${long.length} paragraph(s) run over ${LONG_PARAGRAPH} words (longest ${Math.max(...long)}); split them so each makes one point.` });

  return {
    score: Math.round(25 * q + 35 * af + 15 * fq + 25 * pl),
    components: {
      questionHeadings: { points: Math.round(25 * q), questions: questions.length, subheadings: subheads.length },
      answerFirst: { points: Math.round(35 * af), passed: checks.filter((c) => c.pass).length, checked: checks.length, sections: checks.map(({ suggestion, ...c }) => c) },
      faqMarkup: { points: 15 * fq, questions: faq.length, visibleOnPage: faq.filter((f) => pageText.includes(clean(f).toLowerCase())).length },
      paragraphLength: { points: Math.round(25 * pl), paragraphs: paragraphs.length, overLimit: long.length, longest: paragraphs.length ? Math.max(...paragraphs) : 0 },
    },
    suggestions,
    method: METHOD,
  };
}

export async function scoreAnswerabilityTool(ctx: Ctx, url: string) {
  const { page, doc } = await getHtml(ctx, url);
  return { url: page.url, ...scoreAnswerability(doc) };
}
