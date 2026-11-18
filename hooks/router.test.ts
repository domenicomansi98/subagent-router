import { expect, test } from 'claude-code/testing'

// Each case: what the main model sends → what the sub-agent should run on.
const CASES = [
  {
    input: { description: 'Find auth handlers', prompt: 'Search the repo and list which files define login routes. Return only file paths.', subagent_type: 'Explore' },
    want: { model: 'haiku', effort: 'low' },
  },
  {
    input: { description: 'Locate config usage', prompt: 'Find where FEATURE_FLAGS is read and list the files. Quick lookup.' },
    want: { model: 'haiku', effort: 'low' },
  },
  {
    input: { description: 'Add CSV export', prompt: 'Implement a CSV export button on the reports page and write tests for it.' },
    want: { model: 'sonnet', effort: 'medium' },
  },
  {
    input: { description: 'Security review of auth', prompt: 'Audit the authentication flow for security vulnerabilities and do a root-cause analysis of the session fixation bug. Weigh trade-offs of fixes.' },
    want: { model: 'opus' },
  },
  {
    input: { description: 'Design caching layer', prompt: 'Draft a plan.', subagent_type: 'Plan' },
    want: { model: 'opus', effort: 'high' },
  },
  // Misroutes found by the classifier review.
  {
    input: { description: 'Double-charge bug', prompt: 'Find out why the payment webhook sometimes double-charges customers. Read the handler and check whether retries are idempotent; just report back the conclusion.' },
    want: { model: 'opus', effort: 'high' },
  },
  {
    input: { description: 'Fix typo', prompt: 'Fix the typo in SECURITY.md' },
    want: { model: 'haiku', effort: 'low' },
  },
  {
    input: { description: 'List flaky tests', prompt: 'List the flaky tests from the last CI run' },
    want: { model: 'sonnet' },
  },
  {
    input: { description: 'Trace logout bug', prompt: 'Figure out why users get logged out across services after token refresh and trace where the session state diverges', subagent_type: 'Explore' },
    want: { model: 'sonnet', effort: 'high' },
  },
]

for (const c of CASES) {
  test(`routes "${c.input.description}"`, async ($, on) => {
    let seen: { model?: string; effort?: string } = {}
    on('tool.call', { tool: 'Agent' }, (_, e) => {
      seen = { model: e.model, effort: e.effort }
      return { result: 'ok' as never }
    })
    await $.tool.call({ tool: 'Agent', ...c.input } as never)
    expect(seen.model).toBe(c.want.model)
    if (c.want.effort) expect(seen.effort).toBe(c.want.effort)
  })
}

test('keeps a model the caller chose, fills effort', async ($, on) => {
  let seen: { model?: string; effort?: string } = {}
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    seen = { model: e.model, effort: e.effort }
    return { result: 'ok' as never }
  })
  await $.tool.call({ tool: 'Agent', description: 'Find files', prompt: 'List the files under src.', model: 'sonnet' })
  expect(seen).toEqual({ model: 'sonnet', effort: 'low' })
})

test('leaves forks alone', async ($, on) => {
  let seen: { model?: string; effort?: string } = { model: 'x' }
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    seen = { model: e.model, effort: e.effort }
    return { result: 'ok' as never }
  })
  await $.tool.call({ tool: 'Agent', description: 'fork', prompt: 'Do the thing.', subagent_type: 'fork' })
  expect(seen).toEqual({ model: undefined, effort: undefined })
})

test('/router reports decisions', async ($, on) => {
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'ok' as never }))
  await $.tool.call({ tool: 'Agent', description: 'Find files', prompt: 'List the files under src.' })
  const out = await $.command.run({ command: 'router', args: '' } as never)
  expect(out.text).toContain('haiku/low')
})

test('a call Claude already routed passes through unchanged', async ($, on) => {
  let seen: unknown
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    seen = e
    return { result: 'ok' as never }
  })
  const input = { description: 'Find files', prompt: 'List the files under src.', subagent_type: 'Explore', model: 'haiku', effort: 'low' }
  await $.tool.call({ tool: 'Agent', ...input } as never)
  expect(seen).toMatchObject(input)
})
