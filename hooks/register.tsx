import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRunStatus, Decision } from '../types'
import { classify } from './classify'
import type { Route } from './classify'

const decisions = atom({ plugin: 'subagent-router', key: 'decisions' } as const, [], {
  shape: 'decisions-2',
})
const tick = atom({ plugin: 'subagent-router', key: 'tick' } as const, 0)
const isBandHidden = atom({ plugin: 'subagent-router', key: 'isBandHidden' } as const, false)
/** What each running agent is doing right now, by agent id. */
const activity = atom({ plugin: 'subagent-router', key: 'activity' } as const, {})
const paneOpened = atom({ plugin: 'subagent-router', key: 'paneOpened' } as const, false)

const PANE = 'subagents'

const GUIDANCE = `# Sub-agent delegation and routing (subagent-router)
To keep this conversation's context small and spend tokens where they matter:
- Hand broad searches, multi-file reads, log or doc sweeps, and independent sub-tasks to sub-agents (Agent tool) instead of reading everything here. Run independent ones in parallel.
- Keep small things here: a single file read, one edit, or anything a couple of tool calls settle. Every sub-agent pays a fixed start-up cost of tens of thousands of tokens, so delegate only work bigger than that.
- Write each brief self-contained: the goal, the files or area, what "done" looks like, and the exact shape of the answer (e.g. "return only file:line and a one-line reason"). Ask for conclusions, not file dumps.
- Pick a fitting subagent_type (Explore for read-only searches, Plan for designs).

The user has asked that every Agent call set \`model\` and \`effort\` explicitly, using this routing table (this instruction is the explicit request the effort parameter asks for):
| The task is mainly | model | effort |
|---|---|---|
| finding, listing, reading or summarising; lint, format, typo; plain Explore sweeps | haiku | low |
| implementing, fixing a known bug, writing tests or docs, routine edits; analytical Explore | sonnet | medium (high if long or multi-step) |
| architecture, design, planning, security, root cause of intermittent or unexplained behaviour ("why does it sometimes…"), performance, reviews, trade-offs | TOP_MODEL | high (xhigh only for the hardest) |
Judge by what the task needs, not its wording: a "find out why X sometimes fails" is a root-cause task. Forks (subagent_type "fork") inherit the parent's model: set neither.`

const ENDED = new Set(['completed', 'failed', 'killed', 'idle'])

const elapsed = (d: Decision, now: number) => {
  const s = Math.max(0, Math.round(((d.endedAt ?? now) - d.at) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
const glyph = (s: AgentRunStatus) => (s === 'running' ? '●' : s === 'done' ? '✓' : '✗')
const tone = (s: AgentRunStatus) => (s === 'running' ? 'claude' : s === 'done' ? 'success' : 'error')
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

const base = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() ?? p : '')

/** One short line for what a tool call is doing: "Reading classify.ts". */
function describe(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Read': return `Reading ${base(input.file_path)}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(input.file_path)}`
    case 'Write': return `Writing ${base(input.file_path)}`
    case 'Grep': return `Searching for "${cut(String(input.pattern ?? ''), 30)}"`
    case 'Glob': return `Listing ${cut(String(input.pattern ?? ''), 30)}`
    case 'Bash': return `Running ${cut(String(input.command ?? '').split('\n')[0], 40)}`
    case 'WebFetch': {
      try { return `Fetching ${new URL(String(input.url)).host}` } catch { return 'Fetching a page' }
    }
    case 'WebSearch': return `Searching the web: ${cut(String(input.query ?? ''), 30)}`
    case 'Agent': return `Delegating: ${cut(String(input.description ?? ''), 30)}`
    default: return tool.startsWith('mcp__') ? `Using ${tool.split('__').pop()}` : `Using ${tool}`
  }
}

/** Open the pane; a surface that can't place one just doesn't. */
const openPane = ($: EngineInterface) => {
  $.ui.open({ id: PANE, title: 'Sub-agents' }).catch(() => undefined)
}

const setStatus = ($: EngineInterface, id: string, patch: Partial<Decision>) =>
  update($, decisions, list => list.map(d => (d.id === id ? { ...d, ...patch } : d)))

/** Order rows so each agent sits under the agent that launched it. */
function nested(list: readonly Decision[]) {
  const out: { d: Decision; depth: number }[] = []
  const known = new Set(list.map(d => d.agentId).filter(Boolean))
  const walk = (parent: string | undefined, depth: number) => {
    for (const d of list) {
      const p = d.parentAgentId && known.has(d.parentAgentId) ? d.parentAgentId : undefined
      if (p !== parent) continue
      out.push({ d, depth })
      if (d.agentId) walk(d.agentId, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

export const register: Register = (on, options) => {
  const respectExplicit = options.respectExplicitModel !== false
  const topModel = (options.topModel as Route['model']) || 'opus'
  const guidance = options.delegationGuidance !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router', description: 'Summarise how sub-agents were routed this session' })
    await $.command.register({ name: 'subagents', description: 'Open the Sub-agents pane' })

    // Follow background agents to the end, and keep elapsed times ticking.
    $.clock.every(2000, async () => {
      const list = await read($, decisions)
      const running = list.filter(d => d.status === 'running')
      if (running.length === 0) return
      const tracked = running.filter(d => d.agentId)
      if (tracked.length > 0) {
        const agents = await $.agent.list()
        for (const d of tracked) {
          const a = agents.find(x => x.id === d.agentId)
          if (a && ENDED.has(a.status)) {
            await setStatus($, d.id, {
              status: a.status === 'completed' || a.status === 'idle' ? 'done' : 'failed',
              endedAt: Date.now(),
            })
          }
        }
      }
      await update($, tick, n => n + 1)
    })

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sub-agents' })
    return { text: 'Sub-agents pane opened.' }
  })

  on('command.run', { command: 'router' }, async $ => {
    const list = await read($, decisions)
    if (list.length === 0) return { text: 'No sub-agents routed yet this session.' }
    const counts = list.reduce<Record<string, number>>((acc, d) => {
      acc[`${d.model}/${d.effort}`] = (acc[`${d.model}/${d.effort}`] ?? 0) + 1
      return acc
    }, {})
    const summary = Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(', ')
    const rows = list
      .slice(-15)
      .map(d => `- ${d.description || d.subagentType} → ${d.model}/${d.effort}${d.kept ? ' (model kept)' : ''} — ${d.reason}`)
      .join('\n')
    return { text: `${list.length} routed (${summary})\n${rows}` }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // Forks always inherit the parent's model and effort.
    if (e.subagent_type === 'fork') return next(e)

    const route = classify(e, topModel)
    const kept = respectExplicit && e.model !== undefined
    const model = kept ? e.model! : route.model
    const effort = e.effort ?? route.effort

    const decision: Decision = {
      id: e.tool_use_id,
      parentAgentId: e.agentId,
      at: Date.now(),
      status: 'running',
      description: e.description ?? '',
      task: cut(e.prompt.replace(/\s+/g, ' ').trim(), 160),
      subagentType: e.subagent_type ?? 'general-purpose',
      tier: route.tier,
      model,
      effort,
      reason: route.reason,
      kept,
    }
    await update($, decisions, list => [...list, decision].slice(-200))
    $.ui.status(`router: ${cut(decision.description, 30)} → ${model}/${effort}`)
    if (!(await read($, paneOpened))) {
      await update($, paneOpened, () => true)
      openPane($)
    }

    const ran = await next({ ...e, model, effort })

    if (ran.deny !== undefined || ran.isError) {
      await setStatus($, decision.id, { status: 'failed', endedAt: Date.now() })
      return ran
    }
    // From here on the agent has run: bookkeeping must never fail the call.
    try {
      const agentId = (ran.result as { agentId?: string } | undefined)?.agentId
      // A background agent answers at once; the timer follows it to the end.
      let isLive = false
      if (agentId) {
        const a = (await $.agent.list()).find(x => x.id === agentId)
        isLive = a !== undefined && !ENDED.has(a.status)
      }
      await setStatus($, decision.id, isLive
        ? { agentId }
        : { agentId, status: 'done', endedAt: Date.now() })
    } catch {
      await setStatus($, decision.id, { status: 'done', endedAt: Date.now() }).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'subagent-router failed after launch' } : next(e))) // routing failed before launch: run unrouted

  // Learn each agent's id as it starts, so its tool calls can be shown under it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId && e.tool_use_id) {
      const agentId = r.agentId
      await update($, decisions, list =>
        list.map(d => (d.id === e.tool_use_id && !d.agentId ? { ...d, agentId } : d)))
    }
    return r
  }).catch(($, e, next) => next(e))

  // Track what every sub-agent is doing right now.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const line = describe(e.tool, e as unknown as Record<string, unknown>)
      await update($, activity, map => ({ ...map, [id]: line }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Band above the prompt: what is running right now.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, decisions)
    const running = list.filter(d => d.status === 'running')
    if (e.props.hasSurvey || running.length === 0 || (await read($, isBandHidden))) return next(e)
    await read($, tick)
    const doing = await read($, activity)
    const now = Date.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="claude" bold>● {running.length} sub-agent{running.length > 1 ? 's' : ''} working </Text>
          <Button key="open" label="Details" onPress={() => openPane($)} />
          <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
        </Box>
        {running.slice(-3).map(d => (
          <Text dimColor>
            {'  '}↳ {cut(d.description || d.subagentType, 32)} · {(d.agentId && doing[d.agentId]) || 'starting'} · {d.model}/{d.effort} · {elapsed(d, now)}
          </Text>
        ))}
      </Box>
    )
  })

  // Pane: a tree like the sidebar — this session, with each sub-agent under it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, decisions)
    const doing = await read($, activity)
    await read($, tick)
    const now = Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const running = list.filter(d => d.status === 'running').length
    const summary = list.length === 0
      ? 'no sub-agents yet'
      : `${running} running · ${list.length - running} finished`
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 3) / 2))
    // Running agents first, then the most recent finished ones.
    const rows = nested(list)
    const shown = [
      ...rows.filter(r => r.d.status === 'running'),
      ...rows.filter(r => r.d.status !== 'running').reverse(),
    ].slice(0, room)
    return (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        <Text dimColor>{summary}</Text>
        {list.length === 0 && (
          <Text dimColor>{'\n'}When Claude delegates work, each sub-agent appears here with what it is doing.</Text>
        )}
        {shown.map(({ d, depth }) => {
          const pad = '  '.repeat(depth + 1)
          const now_ = d.status === 'running'
            ? (d.agentId && doing[d.agentId]) || 'Starting…'
            : d.status === 'done' ? 'Done' : 'Failed'
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                {pad}<Text color="claude">↳ </Text>
                <Text bold={d.status === 'running'} dimColor={d.status !== 'running'}>
                  {cut(d.description || d.subagentType, 40)}
                </Text>
                {'  '}<Text color={tone(d.status)}>{glyph(d.status)}</Text>
                <Text dimColor> {elapsed(d, now)}</Text>
              </Text>
              <Text dimColor>
                {pad}  {now_} · {d.model}/{d.effort}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // Under each Agent call in the transcript: how it was routed.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Agent') return next(e)
    const d = (await read($, decisions)).find(x => x.id === e.props.tool_use_id)
    const row = await next(e)
    if (!d) return row
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Text dimColor>
          {'  '}↳ routed to {d.model}/{d.effort} · {d.tier}{d.kept ? ' (model kept)' : ''}
        </Text>
      </Box>
    )
  })

  if (guidance) {
    on('prompt.compose', async ($, e, next) => {
      const result = await next(e)
      if (!e.tools.includes('Agent')) return result
      return {
        sections: [
          ...result.sections,
          { id: 'subagent-router:guidance', text: GUIDANCE.replace('TOP_MODEL', topModel), scope: 'session' as const },
        ],
      }
    })
  }
}
