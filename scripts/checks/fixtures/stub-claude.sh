#!/bin/bash
# Stand-in for the `claude` CLI, bind-mounted over /usr/local/bin/claude by
# scripts/checks/agent-image-smoke.sh. Reaching this line means agent-run.sh got
# through every setup step and launched the agent. It reports the base URL it
# was handed so the check can see whether the strip-images proxy was inserted,
# and the arguments it was launched with (effort, disallowed tools).
echo "STUB_CLAUDE_RAN base_url=${ANTHROPIC_BASE_URL:-<unset>} args=$*"
echo '{"type":"result","subtype":"success","is_error":false,"result":"stub"}'

# With STUB_RUN_MCP_STDIO=1, start every stdio entry of the --mcp-config file the
# way Claude Code does (the container environment plus the entry's env block) and
# report the NAMES of the Maskin and GitHub variables the child can see. Values
# are never printed. The stand-in tool server in the smoke check is `env`.
if [ "${STUB_RUN_MCP_STDIO:-}" = "1" ]; then
	config=""
	while [ $# -gt 0 ]; do
		[ "$1" = "--mcp-config" ] && config="$2"
		shift
	done
	for name in $(jq -r '.mcpServers | to_entries[] | select(.value.command) | .key' "$config"); do
		mapfile -t argv < <(jq -r --arg n "$name" '.mcpServers[$n] | [.command] + (.args // []) | .[]' "$config")
		mapfile -t envblock < <(jq -r --arg n "$name" '.mcpServers[$n] | (.env // {}) | to_entries[] | "\(.key)=\(.value)"' "$config")
		seen="$(env "${envblock[@]}" "${argv[@]}" | cut -d= -f1 | grep -E '^(MASKIN_|GITHUB_TOKEN)' | sort | tr '\n' ' ')"
		echo "STUB_MCP_STDIO $name sees: ${seen:-<none>}"
	done
fi
