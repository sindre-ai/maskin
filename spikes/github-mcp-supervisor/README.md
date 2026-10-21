# Spike: GitHub MCP supervisor restart behind a stable pipe

Throwaway code for the spike task 5a32f53f. Not for merge. Findings: see the findings file linked on the task (github-mcp-supervisor-spike-findings.md).

Run from this folder with MASKIN_API_URL, MASKIN_API_KEY, MASKIN_WORKSPACE_ID and SPIKE_INTEGRATION_ID set and github-mcp-server on PATH:

- node g1.cjs bad|good : drive the Go server directly (G1).
- node relay-test.cjs : scripted client through relay.cjs with a forced restart and init replay (G1, init replay).
- relay.cjs registered via --mcp-config, then node kick.cjs sends SIGUSR1 to force the restart (G2).

No token value is logged or stored by any of these.
