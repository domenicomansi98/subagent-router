import { expect, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane shows each sub-agent under this session with its current action on ${surface}`, async ($, on) => {
    on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } as never }))
    on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' as never }))
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('agent.list', () => ({ value: [{ id: 'a1', status: 'running', description: '', type: 'Explore', kind: 'local_agent' }] }) as never)
    await $.tool.call({ tool: 'Agent', description: 'Find auth handlers', prompt: 'Search for login routes and list file paths.', subagent_type: 'Explore' } as never)
    // The sub-agent (a1) reads a file.
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth/login.ts', agentId: 'a1' } as never)

    const ui = await $.ui.mount({
      plugin: 'subagent-router', surface, component: 'Pane', requestId: 'subagents',
      props: { title: 'Sub-agents', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain('This session')
    expect(texts).toContain('Find auth handlers')
    expect(texts).toContain('haiku/low')
    expect(texts).toContain('Reading login.ts')
    await ui.unmount()
  })

  test(`band stays empty with nothing running on ${surface}`, async $ => {
    const ui = await $.ui.mount({ plugin: 'subagent-router', surface, component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false } } as never)
    expect(await ui.find({ key: 'open' } as never)).toBeUndefined()
    await ui.unmount()
  })
}
