# subagent-router

A Claude Code mod that picks the model and effort for each sub-agent from the task, and nudges the main session to delegate token-heavy work so its own context stays small.

## What it does

- **Routes sub-agents.** Searches, lists and summaries run on haiku at low effort. Implementation, fixes and tests run on sonnet at medium effort. Architecture, planning, security, root-cause investigations and reviews go to your top model at high effort. Forks are left alone.
- **Asks Claude to route up front.** The routing table goes into the system prompt so Claude sets `model` and `effort` on each call itself. The mod fills in only what Claude leaves out, which keeps calls unchanged after auto mode has reviewed them.
- **Shows what is running.** A band above the prompt lists active sub-agents with model, effort and elapsed time, and each Agent call in the transcript gets a "routed to" line.

## Commands

- `/subagents` opens a pane listing every sub-agent this session, nested under the agent that launched it.
- `/router` summarises how sub-agents were routed.

## Settings

- `respectExplicitModel` (default on): keep a model the caller already chose and only fill in effort.
- `topModel` (default `opus`; also `fable` or `sonnet`): model for complex tasks.
- `delegationGuidance` (default on): add the delegation guidance and routing table to the system prompt.

## Install

At the prompt of a Claude Code session:

```
/plugin install subagent-router --marketplace domenicomansi98/subagent-router
```

From a shell:

```bash
claude plugin install subagent-router --marketplace domenicomansi98/subagent-router
```

### Cloud sessions

Add this to the project's `.claude/settings.json` so every cloud session for that project loads the mod:

```json
{
  "extraKnownMarketplaces": {
    "subagent-router": { "source": { "source": "github", "repo": "domenicomansi98/subagent-router" } }
  },
  "enabledPlugins": { "subagent-router@subagent-router": true }
}
```

Turn it off in a session with `/plugin`, or set `"subagent-router@subagent-router": false`.
