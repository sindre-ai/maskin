#!/bin/sh
# Git credential helper for github.com. Mints a fresh GitHub App installation
# token on every invocation via the Maskin API's just-in-time token route,
# instead of relying on a value baked into the container's env once at
# session launch. GitHub App installation tokens expire after exactly 1 hour
# with no refresh token, so any session running past that mark would
# otherwise start failing git push/fetch/clone silently.
#
# Configured as credential.helper for https://github.com in agent-run.sh's
# setup_github_credential_helper. Git invokes this as `github-credential-helper.sh
# get` and feeds protocol/host/path on stdin; we only handle `get` and answer
# with a fresh token, exiting quietly (no output) on any failure so git falls
# back to its normal (unauthenticated / prompt) behavior instead of crashing.
set -eu

action="${1:-}"

# Git feeds key=value pairs on stdin for every action; drain them even when
# we're not going to answer, so git doesn't see a broken pipe.
cat >/dev/null

if [ "$action" != "get" ] || [ -z "${GITHUB_INTEGRATION_ID:-}" ]; then
  exit 0
fi

# Narrow the minted token per invocation: `tool=git` maps to contents:write
# (push/fetch/clone all need it) + metadata:read. If GITHUB_REPO is set (e.g.
# by agent-run.sh from the workspace's bet.metadata.repo), the token is also
# scoped to that single repo, so a leak can't reach any other repo in the
# installation. Repo omitted ⇒ token narrows on permissions but stays install-wide
# on repositories, matching the pre-T4 behavior.
url="${MASKIN_API_URL}/api/integrations/${GITHUB_INTEGRATION_ID}/github-token?tool=git"
if [ -n "${GITHUB_REPO:-}" ]; then
  # URL-encode the slash so `owner/repo` survives the query string intact.
  repo_encoded=$(printf '%s' "$GITHUB_REPO" | sed 's|/|%2F|g')
  url="${url}&repo=${repo_encoded}"
fi

token=$(curl -sf \
  -H "Authorization: Bearer ${MASKIN_API_KEY}" \
  -H "X-Workspace-Id: ${MASKIN_WORKSPACE_ID}" \
  "$url" \
  | jq -r '.token // empty') || exit 0

if [ -z "$token" ]; then
  exit 0
fi

printf 'username=x-access-token\npassword=%s\n' "$token"
