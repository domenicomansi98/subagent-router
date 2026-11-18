import type { Tier } from '../types'

export type Route = {
  tier: Tier
  model: 'haiku' | 'sonnet' | 'opus' | 'fable'
  effort: 'low' | 'medium' | 'high' | 'xhigh'
  reason: string
}

// Signals, strongest first. Each hit adds its weight to that tier's score.
const DEEP: [RegExp, number][] = [
  [/\b(architect(ure)?|system design|design (an?|the) )/i, 3],
  // A file name like SECURITY.md is not a security task.
  [/\b(security\b(?!\.\w)|vulnerab|threat model|auth(n|z|entication|orization) flow)/i, 3],
  // Investigations phrased in plain words: "find out why it sometimes double-charges".
  [/\bwhy\b/i, 2],
  [/\b(sometimes|intermittent(ly)?|occasionally|non-?deterministic|randomly)\b/i, 2],
  [/\b(idempoten|double[- ](charg|count|submit|process)|diverge|inconsisten|trace (where|how|why))/i, 2],
  [/\b(root[- ]cause|race condition|deadlock|concurren|memory leak|flaky|heisenbug)/i, 3],
  [/\b(trade-?offs?|evaluate (options|approaches)|compare approaches|strategy)\b/i, 2],
  [/\b(plan|planning|roadmap|migration plan|spec)\b/i, 2],
  [/\b(review|audit|critique|verify (that|whether)|adversarial)/i, 2],
  [/\b(optimi[sz]e|performance|bottleneck|complexity|algorithm)/i, 2],
  [/\b(refactor (the )?(whole|entire|across)|cross-cutting|many files|codebase-wide)/i, 2],
  [/\b(prove|proof|invariant|formal)\b/i, 2],
]
const STANDARD: [RegExp, number][] = [
  [/\b(implement|build|create|add (a|an|the|support)|write (a|the|tests?|code))/i, 2],
  [/\b(fix|bug|debug|error|failing|broken)\b/i, 2],
  [/\b(refactor|rename across|migrate|upgrade|update)\b/i, 1],
  [/\b(test|tests|spec file|coverage)\b/i, 1],
  [/\b(edit|modify|change|patch)\b/i, 1],
  [/\b(document|docs|readme|explain)\b/i, 1],
]
const LIGHT: [RegExp, number][] = [
  [/\b(find|search|grep|locate|look ?up|where (is|are|does)|which files?)\b/i, 2],
  [/\b(list|enumerate|count|inventory|collect)\b/i, 2],
  [/\b(read|skim|summari[sz]e|extract|fetch|scan)\b/i, 1],
  [/\b(check (if|whether|that)|does .* exist|is there)\b/i, 1],
  [/\b(format|lint|typo|rename (a|the|one)|bump version)\b/i, 3],
  [/\b(quick|simple|trivial|small|just)\b/i, 1],
  [/\b(report back|return (only )?(the )?(paths?|list|names|conclusion))/i, 1],
]

const score = (text: string, rules: [RegExp, number][]) =>
  rules.reduce((sum, [re, w]) => (re.test(text) ? sum + w : sum), 0)

export function classify(
  input: { description?: string; prompt: string; subagent_type?: string },
  topModel: Route['model'],
): Route {
  const type = (input.subagent_type ?? '').toLowerCase()
  const text = `${input.description ?? ''}\n${input.prompt}`

  // Agent types whose job fixes the tier.
  if (type === 'plan') {
    return { tier: 'deep', model: topModel, effort: 'high', reason: 'Plan agent' }
  }
  if (type === 'statusline-setup' || type === 'claude-code-guide') {
    return { tier: 'light', model: 'haiku', effort: 'low', reason: `${type} agent` }
  }

  const route = scoreRoute(text, topModel)

  // Explore agents are read-only: score them like any task, but cap at standard.
  if (type === 'explore' && route.tier === 'deep') {
    return { tier: 'standard', model: 'sonnet', effort: 'high', reason: `Explore, capped: ${route.reason}` }
  }
  // A plain read-only sweep with no clear signals stays on the small model.
  if (type === 'explore' && route.tier === 'standard' && route.effort === 'medium') {
    return { tier: 'light', model: 'haiku', effort: 'low', reason: `Explore: ${route.reason}` }
  }
  return route
}

function scoreRoute(text: string, topModel: Route['model']): Route {
  const deep = score(text, DEEP)
  const standard = score(text, STANDARD)
  const light = score(text, LIGHT)

  // Long, dense briefs usually mean multi-step work.
  const words = text.split(/\s+/).length
  const sizeBump = words > 600 ? 2 : words > 250 ? 1 : 0
  const files = (text.match(/[\w./-]+\.(ts|tsx|js|py|go|rs|java|rb|swift|kt|cs|sql|md)\b/g) ?? []).length
  const fileBump = files >= 6 ? 1 : 0

  const deepScore = deep + sizeBump + fileBump

  // Deep when the signals pile up, or when one deep signal clearly outweighs
  // everything else (so a single stray word can't pull a trivial task up).
  if (deepScore >= 5 || (deep >= 3 && deep > standard + light)) {
    const effort = deepScore >= 8 ? 'xhigh' : 'high'
    return { tier: 'deep', model: topModel, effort, reason: why('deep', deep, standard, light) }
  }
  if (deep === 0 && light > standard && sizeBump === 0) {
    return { tier: 'light', model: 'haiku', effort: 'low', reason: why('light', deep, standard, light) }
  }
  const effort = deep >= 2 || sizeBump > 0 ? 'high' : 'medium'
  return { tier: 'standard', model: 'sonnet', effort, reason: why('standard', deep, standard, light) }
}

const why = (tier: string, d: number, s: number, l: number) =>
  `${tier} (signals d${d}/s${s}/l${l})`
