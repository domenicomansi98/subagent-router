export type Tier = 'light' | 'standard' | 'deep'

export type AgentRunStatus = 'running' | 'done' | 'failed'

export type Decision = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The spawned agent's id, once known. */
  agentId?: string
  /** The loop that launched it (absent: the main session). */
  parentAgentId?: string
  at: number
  endedAt?: number
  status: AgentRunStatus
  description: string
  task: string
  subagentType: string
  tier: Tier
  model: string
  effort: string
  reason: string
  kept: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-router': {
      decisions: Shaped<Decision[]>
      tick: number
      isBandHidden: boolean
      activity: Record<string, string>
      paneOpened: boolean
    }
  }
}
