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
# Availability is decided by the BACKEND, not by this script. POST /ask answers
# delivered_to=chat for a session in a chat (the answer comes back as its next
# turn) and delivered_to=chief_of_staff for an autonomous one (the question goes
# to the person's 1-1 with the Chief of Staff, and the answer goes there too, not
# back here). An autonomous session must never wait on it, or the run would be
# stranded until the timeout backstop. 409 means there is nobody to ask.
#
# `--dangerously-skip-permissions` is set on the CLI, so this hook must NOT
# depend on the permission decision alone being honoured. It writes the
# model-facing text to both documented carriers: permissionDecisionReason and
# additionalContext.
set -eo pipefail

INPUT=$(cat)

# Never wedge the turn. Every exit path here denies the tool call but hands the
# model an instruction, because letting the call through means the agent hits
# the same broken tool this hook exists to replace.
#
# This must not depend on jq. Under `set -e` a failing jq would abort the hook
# with a non-zero exit and no stdout, and a non-blocking PreToolUse failure lets
# the call proceed — straight into the TTY-less AskUserQuestion. jq is installed
# in the image, but the fail-safe path itself cannot assume it.
json_escape() {
  # Pure bash so the fail-safe path has no external dependency at all.
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

decide() {
  local reason
  reason=$(json_escape "$1")
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s","additionalContext":"%s"}}\n' \
    "$reason" "$reason"
  exit 0
}

DECIDE_YOURSELF="You cannot ask the user a question in this session — there is nobody on the other end. Do not call AskUserQuestion again. Choose the most reasonable option yourself, state the assumption you made, and continue."

# No INTERACTIVE gate here any more: an autonomous session's question goes to
# the person's 1-1 with the Chief of Staff, and only the backend knows whether
# one exists. A 409 still means "nobody to ask".

if [ -z "$MASKIN_API_URL" ] || [ -z "$MASKIN_API_KEY" ] || [ -z "$SESSION_ID" ] || [ -z "$MASKIN_WORKSPACE_ID" ]; then
  decide "$DECIDE_YOURSELF"
fi

# The tool input mirrors messageQuestionItemSchema apart from multiSelect's
# casing. Anything malformed drops through to the decide-yourself path rather
# than erroring, so a CLI-side shape change degrades to today's behaviour
# instead of wedging the turn.
#
# Every field is clamped to the bounds messageQuestionItemSchema enforces —
# header 24, question 1000, label 200, description 1000, and 4 each of questions
# and options (MESSAGE_MAX_QUESTIONS / MESSAGE_MAX_QUESTION_OPTIONS). The tool's
# headers are free-form model output and routinely run past 24 characters, so
# without the clamp the ordinary case 400s and this feature silently never fires.
QUESTIONS=$(echo "$INPUT" | jq -c '
  [ (.tool_input.questions // [])[]
    | select((.question | type) == "string" and (.options | type) == "array")
    | {
        question: (.question | .[0:1000]),
        header: ((.header // "Question") | tostring | .[0:24] | if . == "" then "Question" else . end),
        multi_select: (.multiSelect // false),
        options: [
          .options[]
          | select((.label | type) == "string" and (.label | length) > 0)
          | {label: (.label | .[0:200]), description: ((.description // "") | tostring | .[0:1000])}
        ][0:4]
      }
    | select((.options | length) >= 2)
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
  DELIVERED_TO=$(echo "$RESPONSE" | sed '$d' | jq -r '.delivered_to // "chat"' 2>/dev/null || echo chat)
  if [ "$DELIVERED_TO" = "chief_of_staff" ]; then
    decide "Your question has been sent to the user in their chat with the Chief of Staff. Their answer will go there, not back to this session, so do not wait for it and do not call AskUserQuestion again. Choose the most reasonable option yourself, state the assumption you made in your output, and continue."
  fi
  decide "Your question has been posted to the chat and the user is being shown the options to pick from. Do not call AskUserQuestion again and do not repeat the question in your own words — it is already on screen. End your turn now, without a closing message; their answer will arrive as your next turn."
fi

# 409 is the expected answer for an autonomous session. Anything else (network
# failure, 403, 5xx, a schema 400) lands here too: the agent still must not
# block, and "decide for yourself" is the safe instruction in every one of those
# cases. But it is NOT the same event, and collapsing them all into one silent
# path is how a broken ask stays broken — a misconfigured MASKIN_API_URL or a
# 403 would otherwise look exactly like a healthy autonomous run. Anything
# unexpected goes to stderr, which session-manager captures into session_logs.
if [ "$STATUS" != "409" ]; then
  echo "[system] ask-user-question: POST /ask failed (status=${STATUS:-none}) body=$(echo "$RESPONSE" | sed '$d' | head -c 500)" >&2
fi

decide "$DECIDE_YOURSELF"
