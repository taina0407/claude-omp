# Review of the uncommitted changes: REQUEST CHANGES

The retry loop can spin forever, and one message is misleading.

## Findings (1 critical, 1 medium, 1 low)

1. **[critical] Infinite retry** (`src/retry.ts:42`, confidence 0.95)
   When the server returns 503 forever, `attempt` is never incremented.
   The job hangs.
   Suggestion: Increment attempt before `continue`.

2. **[medium] No jitter** (`src/retry.ts:7`, confidence 0.70)
   All clients retry at the same instant.

3. **[low] Misleading message** (`src/log.ts`, confidence 0.50)
   Says 'saved' before the write finishes.
