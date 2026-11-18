import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'subagent-router',
  component: 'Pane',
  requestId: 'subagents',
  props: { title: 'Sub-agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** Stand in for the engine: commands, panes, and a session that starts. */
function engine(on: On, agents: { id: string; status: string }[]) {
  on('command.register', () => ({ value: { command: 'x' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: '', type: 'general-purpose', kind: 'local_agent' })) }) as never)
}

async function paneText($: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[0], surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

// 1. Completion tracking -------------------------------------------------

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a background agent flips to Done once it completes, and the band clears (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const agents = [{ id: 'a1', status: 'running' }]
    engine(on, agents)
    on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } }) as never)
    await $.session.start({ cwd: '/', surface, isInteractive: true } as never)

    await $.tool.call({ tool: 'Agent', description: 'Long sweep', prompt: 'Search every file and list the TODOs.' } as never)
    expect((await paneText($, surface)).join('\n')).toContain('●')

    const band = await $.ui.mount({ plugin: 'subagent-router', surface, component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false } } as never)
    expect(await band.find({ key: 'open' } as never)).toBeDefined()
    await band.unmount()

    agents[0].status = 'completed'
    await clock.advance(2000)

    const after = (await paneText($, surface)).join('\n')
    expect(after).toContain('Done')
    expect(after).toContain('✓')
    const band2 = await $.ui.mount({ plugin: 'subagent-router', surface, component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false } } as never)
    expect(await band2.find({ key: 'open' } as never)).toBeUndefined()
    await band2.unmount()
  })
}

test('a killed background agent shows as Failed', async ($, on) => {
  const clock = mock.clock(on)
  const agents = [{ id: 'a1', status: 'running' }]
  engine(on, agents)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'Agent', description: 'Doomed sweep', prompt: 'Search every file.' } as never)
  agents[0].status = 'killed'
  await clock.advance(2000)
  const text = (await paneText($, 'desktop')).join('\n')
  expect(text).toContain('Failed')
  expect(text).toContain('✗')
})

test('an Agent call that errors shows as Failed straight away', async ($, on) => {
  engine(on, [])
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'boom', isError: true }) as never)
  await $.tool.call({ tool: 'Agent', description: 'Broken task', prompt: 'Implement the thing.' } as never)
  expect((await paneText($, 'desktop')).join('\n')).toContain('Failed')
})

test('a foreground agent that already finished shows as Done without polling', async ($, on) => {
  engine(on, [{ id: 'a1', status: 'completed' }])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } }) as never)
  await $.tool.call({ tool: 'Agent', description: 'Quick lookup', prompt: 'Find the config file.' } as never)
  expect((await paneText($, 'desktop')).join('\n')).toContain('Done')
})

// 2. Nesting ---------------------------------------------------------------

test('an agent started by another agent is indented under it', async ($, on) => {
  engine(on, [{ id: 'p1', status: 'running' }, { id: 'c1', status: 'running' }])
  let next = 'p1'
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: next } }) as never)

  await $.tool.call({ tool: 'Agent', description: 'Parent task', prompt: 'Implement the export feature.' } as never)
  next = 'c1'
  // Made from inside p1's loop.
  await $.tool.call({ tool: 'Agent', description: 'Child task', prompt: 'Find the export helpers.', agentId: 'p1' } as never)

  const texts = await paneText($, 'terminal')
  const parent = texts.find(t => t.includes('Parent task'))!
  const child = texts.find(t => t.includes('Child task'))!
  const indent = (t: string) => t.length - t.trimStart().length
  expect(parent).toBeDefined()
  expect(child).toBeDefined()
  expect(indent(child)).toBeGreaterThan(indent(parent))
  // The child sits below its parent.
  expect(texts.indexOf(child)).toBeGreaterThan(texts.indexOf(parent))
})

// 3. Options and guidance ----------------------------------------------------

const BASE = [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }]
/** What a real session hands prompt.compose. */
const compose = (tools: string[]) =>
  ({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools, outputStyle: null, traits: [] }) as never

test('guidance reaches the system prompt with the top model filled in', async ($, on) => {
  on('prompt.compose', () => ({ sections: BASE }) as never)
  const out = await $.prompt.compose(compose(['Agent', 'Read']))
  const section = out.sections.find(s => s.id === 'subagent-router:guidance')
  expect(section).toBeDefined()
  expect(section!.scope).toBe('session')
  expect(section!.text).toContain('| opus |')
  expect(section!.text).not.toContain('TOP_MODEL')
})

test('topModel option changes the model in guidance and routing', { options: { topModel: 'fable' } }, async ($, on) => {
  let seen: string | undefined
  on('prompt.compose', () => ({ sections: BASE }) as never)
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    seen = (e as { model?: string }).model
    return { result: 'ok' } as never
  })
  const out = await $.prompt.compose(compose(['Agent']))
  expect(out.sections.find(s => s.id === 'subagent-router:guidance')!.text).toContain('| fable |')
  await $.tool.call({ tool: 'Agent', description: 'Design', prompt: 'Draft a plan.', subagent_type: 'Plan' } as never)
  expect(seen).toBe('fable')
})

test('no guidance when the session offers no Agent tool', async ($, on) => {
  on('prompt.compose', () => ({ sections: BASE }) as never)
  const out = await $.prompt.compose(compose(['Read']))
  expect(out.sections.some(s => s.id === 'subagent-router:guidance')).toBe(false)
})

test('delegationGuidance off leaves the system prompt alone', { options: { delegationGuidance: false } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: BASE }) as never)
  const out = await $.prompt.compose(compose(['Agent']))
  expect(out.sections.some(s => s.id === 'subagent-router:guidance')).toBe(false)
})

test('respectExplicitModel off overrides a model the caller chose', { options: { respectExplicitModel: false } }, async ($, on) => {
  let seen: string | undefined
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    seen = (e as { model?: string }).model
    return { result: 'ok' } as never
  })
  await $.tool.call({ tool: 'Agent', description: 'Find files', prompt: 'List the files under src.', model: 'opus' } as never)
  expect(seen).toBe('haiku')
})
