#!/bin/bash
# Stand-in for the `claude` CLI, bind-mounted over /usr/local/bin/claude by
# scripts/checks/agent-image-smoke.sh. Reaching this line means agent-run.sh got
# through every setup step and launched the agent. It reports the base URL it
# was handed so the check can see whether the strip-images proxy was inserted.
echo "STUB_CLAUDE_RAN base_url=${ANTHROPIC_BASE_URL:-<unset>}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"stub"}'
