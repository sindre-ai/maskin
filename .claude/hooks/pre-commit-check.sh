#!/bin/bash
# Pre-commit reminder hook for Claude Code
# Fires on PreToolUse for Bash — checks if command is a git commit
# and reminds the agent to run lint, type-check, and tests first.

COMMAND=$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qE '^git commit|&& git commit|; git commit'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"PRE-COMMIT REMINDER: Before committing, you MUST have already run and confirmed these pass:\n1. pnpm lint\n2. pnpm type-check\n3. pnpm test -- --run\n\nIf you have not run all three, cancel this commit and run them first. Fix any failures before committing."}}'
  exit 0
fi

exit 0
