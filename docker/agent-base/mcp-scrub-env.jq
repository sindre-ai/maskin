# Applied to the merged MCP config by setup_mcps in agent-run.sh (jq -f).
#
# Claude Code starts every stdio tool server with the whole container
# environment plus the entry's own env block, so a server the agent never meant
# to trust (a third-party npx package) can read MASKIN_API_KEY and the GitHub
# tokens. Each stdio entry (has a command, no url) is rewritten to launch
# through env(1) with -u for every credential variable that is set in the
# container and that the entry's env block does not name:
#
#   {command: "npx", args: ["-y", "x"]}
#     -> {command: "env", args: ["-u", "MASKIN_API_KEY", ..., "--", "npx", "-y", "x"]}
#
# Named variables stay: envsubst runs on the result and has already put their
# values in the env block, which Claude Code applies before env(1) runs. Entries
# with a url (http, sse) have no child process and are left alone. Arguments are
# a JSON array, so spaces and quotes in them pass through untouched.
#
# The names come from the container's own environment ($ENV), so only variables
# that exist are unset, and the per-owner GITHUB_TOKEN_<OWNER> names, which vary
# by workspace, are picked up without a list to maintain.

def credential_names:
	$ENV
	| keys
	| map(select(test("^(MASKIN_API_KEY|MASKIN_API_URL|MASKIN_WORKSPACE_ID|GITHUB_TOKEN(_[A-Z0-9_]+)?)$")));

def is_stdio:
	type == "object" and ((.command // null) | type) == "string" and (.url // null) == null;

def scrub:
	((.env // {}) | keys) as $named
	| (credential_names - $named) as $drop
	| if ($drop | length) == 0 then .
		else
			.args = (($drop | map("-u", .)) + ["--", .command] + (.args // []))
			| .command = "env"
		end;

.mcpServers |= with_entries(.value |= if is_stdio then scrub else . end)
