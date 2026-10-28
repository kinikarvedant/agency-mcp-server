import { createHash } from "node:crypto";
import type { Ctx } from "../context.js";
import { redact } from "../safety.js";

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/** Newcombe's hybrid score interval for p1 - p0 (method 10 in Newcombe 1998). */
export function newcombe(k1: number, n1: number, k0: number, n0: number, z = 1.96): [number, number] {
  const p1 = k1 / n1, p0 = k0 / n0, [l1, u1] = wilson(k1, n1, z), [l0, u0] = wilson(k0, n0, z);
  const d = p1 - p0;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u0 - p0) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p0 - l0) ** 2)];
}

export interface Provider { mode: "live" | "mock"; name: string; ask(prompt: string, run: number): Promise<string> }

export const MOCK_RATE = 0.35;
export const MOCK_NOTICE =
  "MOCK PROVIDER. No language model was called. Each reply is generated locally from a hash of the prompt and run number, " +
  `naming the client with a fixed ${MOCK_RATE * 100}% probability, so the rates below only show how the statistics work.`;

/** Deterministic stand-in used whenever no model endpoint is configured, and always in the public demo. */
export function mockProvider(brand: string): Provider {
  return {
    mode: "mock",
    name: "mock",
    async ask(prompt, run) {
      const mentioned = createHash("sha256").update(`${prompt}\n${run}`).digest().readUInt32BE(0) / 2 ** 32 < MOCK_RATE;
      return `[MOCK REPLY ${run}: no language model was called] ${mentioned ? `This mock reply names ${brand}.` : "This mock reply names no business."}`;
    },
  };
}

/** Any HTTPS endpoint speaking the common chat-completions format: POST {base}/chat/completions. No vendor SDK. */
export function httpProvider(ctx: Ctx): Provider {
  const { MODEL_API_BASE_URL: base, MODEL_API_KEY: key, MODEL_NAME: model } = ctx.env;
  return {
    mode: "live",
    name: model!,
    async ask(prompt) {
      await ctx.limiter.take("model");
      const res = await ctx.api(`${base!.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        // Only the operator's prompt is sent. Crawled page text never reaches the model.
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } };
      if (!res.ok) throw new Error(`Model endpoint returned HTTP ${res.status}: ${redact(json.error?.message ?? res.statusText)}`);
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("Model endpoint reply has no choices[0].message.content.");
      return text;
    },
  };
}

export function providerFor(ctx: Ctx): Provider {
  const e = ctx.env;
  return !e.DEMO_MODE && e.MODEL_API_BASE_URL && e.MODEL_API_KEY && e.MODEL_NAME ? httpProvider(ctx) : mockProvider(ctx.client.name);
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface VisibilityInput {
  prompts: string[];
  runs?: number;
  brandTerms?: string[];
  baseline?: { prompt: string; mentions: number; runs: number }[];
}

export async function answerEngineVisibility(ctx: Ctx, input: VisibilityInput, provider = providerFor(ctx)) {
  const runs = input.runs ?? 5;
  const brandTerms = input.brandTerms?.length ? input.brandTerms : (ctx.client.brandTerms ?? [ctx.client.name]);
  const mention = new RegExp(`(^|\\W)(${brandTerms.map(escape).join("|")})(?=\\W|$)`, "i");

  const prompts = [];
  for (const prompt of input.prompts) {
    let k = 0;
    let excerpt: string | null = null;
    for (let run = 1; run <= runs; run++) {
      const reply = await provider.ask(prompt, run);
      const m = mention.exec(reply);
      if (m) {
        k++;
        excerpt ??= reply.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100);
      }
    }
    const base = input.baseline?.find((b) => b.prompt === prompt);
    const change = base && base.runs > 0 ? newcombe(k, runs, base.mentions, base.runs) : null;
    prompts.push({
      prompt,
      runs,
      mentions: k,
      rate: round(k / runs),
      ci95: wilson(k, runs).map(round),
      firstMentionExcerpt: excerpt,
      ...(base && change
        ? {
            baseline: { mentions: base.mentions, runs: base.runs, rate: round(base.mentions / base.runs) },
            change: {
              difference: round(k / runs - base.mentions / base.runs),
              ci95: change.map(round),
              verdict: change[0] > 0 || change[1] < 0 ? "real change: the 95% interval for the difference excludes zero" : "within run-to-run variance: the 95% interval for the difference includes zero",
            },
          }
        : {}),
    });
  }
  const K = prompts.reduce((s, p) => s + p.mentions, 0), N = prompts.length * runs;
  return {
    mode: provider.mode,
    provider: provider.name,
    ...(provider.mode === "mock" ? { notice: MOCK_NOTICE } : {}),
    brandTerms,
    prompts,
    overall: { runs: N, mentions: K, rate: round(K / N), ci95: wilson(K, N).map(round) },
    method:
      "Each prompt is sent the given number of times; a run counts as a mention when the reply contains a brand term (case-insensitive, whole words). " +
      "Rates carry a 95% Wilson interval. Against a baseline, the difference gets a Newcombe hybrid score interval: if it includes zero the change is " +
      "indistinguishable from run-to-run variance. Overall pools all runs and treats them as independent.",
  };
}
