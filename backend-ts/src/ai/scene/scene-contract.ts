import { z } from 'zod';

const short = (max: number) => z.string().trim().max(max);
export const scenePlanSchema = z.object({
  goal: short(600).min(1),
  withheld: short(600),
  pov: short(300).min(1),
  ending: short(400),
  targetChars: z.number().int().min(200).max(1600),
}).strict();
const requestFields = {
  book_id: z.string().min(1).max(100),
  chapter_id: z.string().max(100).nullish(),
  content: z.string().max(60000),
  intent: short(1200).min(1),
  model: z.string().min(1).max(1600).nullish(),
};
export const scenePlanRequestSchema = z.object(requestFields).strict();
export const sceneWriteRequestSchema = z.object({ ...requestFields,
  plan: scenePlanSchema, auto_repair: z.boolean().default(false),
}).strict();
export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type ScenePlanInput = z.infer<typeof scenePlanRequestSchema>;
export type SceneWriteInput = z.infer<typeof sceneWriteRequestSchema>;

export const reviewSchema = z.object({ findings: z.array(z.object({
  kind: z.enum(['goal', 'revelation', 'pov', 'continuity', 'style']),
  constraintId: z.string().min(1).max(100),
  quote: z.string().min(1).max(800),
  reason: short(500).min(1),
  suggestion: short(500).min(1),
}).strict()).max(8) }).strict();
export type SceneFinding = z.infer<typeof reviewSchema>['findings'][number] & {
  id: string;
  severity: 'conflict' | 'suggestion';
  constraint: string;
  /** UTF-16 offsets in the initial draft (same convention as editor selections). */
  start: number;
  end: number;
  repairable: boolean;
};
export const repairSchema = z.object({ edits: z.array(z.object({
  id: z.string().min(1).max(100), replacement: z.string().max(1200),
}).strict()).max(3) }).strict();

/** Only a whole JSON document or one whole fenced document is accepted. No brace scraping. */
export function parseSceneJson<T>(raw: string, schema: z.ZodType<T>): T {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  try { return schema.parse(JSON.parse(fenced ? fenced[1] : text)); }
  catch { throw new Error('场景任务返回的结构无法解析，请重试；未生成可应用结果'); }
}

export interface SceneConstraint { id: string; text: string; authoritative: boolean }
export function sceneConstraints(plan: ScenePlan): SceneConstraint[] {
  return [
    { id: 'goal', text: plan.goal, authoritative: false },
    ...(plan.withheld ? [{ id: 'withheld', text: plan.withheld, authoritative: true }] : []),
    { id: 'pov', text: plan.pov, authoritative: true },
    ...(plan.ending ? [{ id: 'ending', text: plan.ending, authoritative: false }] : []),
    { id: 'style', text: '避免重复、冗余解释；风格和节奏判断仅为建议', authoritative: false },
  ];
}

/** Evidence is grounded mechanically; this does not prove the model's literary judgment. */
export function validateFindings(raw: z.infer<typeof reviewSchema>, draft: string,
  constraints: SceneConstraint[]): { findings: SceneFinding[]; dropped: number } {
  const findings: SceneFinding[] = [];
  for (const item of raw.findings) {
    const constraint = constraints.find(c => c.id === item.constraintId);
    const compatible = item.kind === 'goal' ? ['goal', 'ending'].includes(item.constraintId)
      : item.kind === 'revelation' ? item.constraintId === 'withheld'
      : item.kind === 'pov' ? item.constraintId === 'pov'
      : item.kind === 'style' ? item.constraintId === 'style'
      : item.constraintId.startsWith('source:');
    const start = draft.indexOf(item.quote);
    // Ambiguous or invented evidence is never made into an actionable edit.
    if (!constraint || !compatible || start < 0 ||
      draft.indexOf(item.quote, start + 1) !== -1 ||
      findings.some(f => start < f.end && start + item.quote.length > f.start)) continue;
    findings.push({ ...item, id: `finding-${findings.length + 1}`, constraint: constraint.text,
      severity: constraint.authoritative ? 'conflict' : 'suggestion', start, end: start + item.quote.length,
      repairable: item.kind !== 'goal' && item.kind !== 'style',
    });
  }
  return { findings, dropped: raw.findings.length - findings.length };
}

/** The model supplies replacements only; all untouched text is copied by the server. */
export function applySceneRepairs(draft: string, findings: SceneFinding[],
  raw: z.infer<typeof repairSchema>): string {
  const selected = new Map(findings.map(f => [f.id, f]));
  const seen = new Set<string>();
  const edits = raw.edits.map(e => {
    const f = selected.get(e.id);
    if (!f || seen.has(e.id) || !f.repairable || draft.slice(f.start, f.end) !== f.quote ||
      (!e.replacement.trim() && f.quote.length > 300) || e.replacement.length > Math.max(300, f.quote.length * 2)) {
      throw new Error('局部修订超出已审阅范围，已保留初稿');
    }
    seen.add(e.id);
    return { ...e, start: f.start, end: f.end };
  }).sort((a, b) => b.start - a.start);
  if (edits.some((e, i) => i > 0 && e.end > edits[i - 1].start)) {
    throw new Error('局部修订范围重叠，已保留初稿');
  }
  return edits.reduce((text, e) => text.slice(0, e.start) + e.replacement + text.slice(e.end), draft);
}
