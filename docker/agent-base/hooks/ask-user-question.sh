#!/bin/bash
# PreToolUse hook on AskUserQuestion, registered in the image's default
# ~/.claude/settings.json.
#
# The headless CLI (`claude -p`) has no TTY, so AskUserQuestion has nowhere to
# render and fails the call with a bare "Answer questions?" error. On
# 2026-08-25 that error derailed a live chat mid-turn: the agent recovered and
# wrote its reply, but ended the turn on a thinking block, which blanked the
# `result` envelope and lost the reply entirely (session 9b050dec).
#
# This hook takes the questions the agent wanted to ask and posts them into the
# chat it is already in, as a message carrying `metadata.question` — the web UI
# renders those as clickable option chips. The human's pick comes back as an
# ordinary chat message, which the conversation responder already feeds into
# this same live session as the next turn. So the agent never blocks and no
# microVM is held idle waiting on a human.
#
# Availability is decided by the BACKEND, not by this script: POST /ask returns
# 409 for any session that is not an interactive chat session. An autonomous
# (trigger-driven) session has nobody to ask, so it is told to decide for
# itself rather than stranding the run until the timeout backstop.
#
# `--dangerously-skip-permissions` is set on the CLI, so this hook must NOT
# depend on the permission decision alone being honoured. It writes the
# model-facing text to both documented carriers: permissionDecisionReason and
# additionalContext.
set -eo pipefail

INPUT=$(cat)

# Fail open, always. Every early exit here prints a decision that blocks the
# tool with an explanation, because letting the call through means the agent
# hits the same broken tool this hook exists to replace.
decide() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason,
      additionalContext: $reason
    }
  }'
  exit 0
}

DECIDE_YOURSELF="You cannot ask the user a question in this session — there is nobody on the other end. Do not call AskUserQuestion again. Choose the most reasonable option yourself, state the assumption you made, and continue."

# INTERACTIVE=1 is set by SessionManager only for stdin-driven sessions, so an
# autonomous run short-circuits here without an HTTP round-trip. This is a cheap
# filter, NOT the gate: an interactive session can exist without a conversation
# attached, and the attachment can change after launch, so the backend's 409
# remains the authority on whether there is anyone to ask.
if [ "$INTERACTIVE" != "1" ]; then
  decide "$DECIDE_YOURSELF"
fi

if [ -z "$MASKIN_API_URL" ] || [ -z "$MASKIN_API_KEY" ] || [ -z "$SESSION_ID" ] || [ -z "$MASKIN_WORKSPACE_ID" ]; then
  decide "$DECIDE_YOURSELF"
fi

# The tool input mirrors messageQuestionItemSchema apart from multiSelect's
# casing. Anything malformed drops through to the decide-yourself path rather
# than erroring, so a CLI-side shape change degrades to today's behaviour
# instead of wedging the turn.
QUESTIONS=$(echo "$INPUT" | jq -c '
  [ (.tool_input.questions // [])[]
    | select((.question | type) == "string" and (.options | type) == "array" and (.options | length) >= 2)
    | {
        question: .question,
        header: (.header // "Question"),
        multi_select: (.multiSelect // false),
        options: [ .options[] | {label: .label, description: (.description // "")} ][0:4]
      }
  ][0:4]' 2>/dev/null || echo '[]')

if [ "$(echo "$QUESTIONS" | jq 'length' 2>/dev/null || echo 0)" -eq 0 ]; then
  decide "$DECIDE_YOURSELF"
fi

RESPONSE=$(curl -4 -s -m 15 -w '\n%{http_code}' -X POST \
  "${MASKIN_API_URL}/api/sessions/${SESSION_ID}/ask" \
  -H "Authorization: Bearer ${MASKIN_API_KEY}" \
  -H "X-Workspace-Id: ${MASKIN_WORKSPACE_ID}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson q "$QUESTIONS" '{questions: $q}')" 2>/dev/null || true)

STATUS=$(echo "$RESPONSE" | tail -n1)

if [ "$STATUS" = "200" ]; then
  decide "Your question has been posted to the chat and the user is being shown the options to pick from. Do not call AskUserQuestion again and do not repeat the question in your own words — it is already on screen. End your turn now, without a closing message; their answer will arrive as your next turn."
fi

# 409 is the expected answer for an autonomous session. Anything else (network
# failure, 403, 5xx) lands here too: the agent still must not block, and
# "decide for yourself" is the safe instruction in every one of those cases.
decide "$DECIDE_YOURSELF"
