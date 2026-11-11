#!/usr/bin/env bash
# Keep apt on a mirror that answers. GitHub's Ubuntu runners resolve packages through
# azure.archive.ubuntu.com; when that host fails to resolve or crawls (seen 2026-11-11,
# "Temporary failure resolving 'azure.archive.ubuntu.com'"), `playwright install-deps` burns
# its whole budget on timeouts and every e2e shard fails before a test runs.
#
# Healthy runner default: change nothing. Otherwise rewrite the apt sources to the first
# fallback mirror that serves the suites install-deps needs. No fallback answers: leave apt
# alone and warn, so the real apt error is what fails the step.
#
# Needs sudo. Tests override APT_CODENAME, DEFAULT_MIRROR, FALLBACK_MIRRORS, MIRROR_PROBE_TIMEOUT.
set -uo pipefail

codename="${APT_CODENAME:-$(. /etc/os-release && echo "$VERSION_CODENAME")}"
timeout="${MIRROR_PROBE_TIMEOUT:-8}"
default_mirror="${DEFAULT_MIRROR:-http://azure.archive.ubuntu.com/ubuntu}"
read -r -a fallbacks <<< "${FALLBACK_MIRRORS:-https://mirrors.edge.kernel.org/ubuntu https://archive.ubuntu.com/ubuntu}"

answers() {
  local mirror="$1" suite
  for suite in "$codename" "$codename-updates" "$codename-security"; do
    curl -fsS -o /dev/null --max-time "$timeout" "$mirror/dists/$suite/InRelease" || return 1
  done
}

if answers "$default_mirror"; then
  echo "apt default mirror answers; leaving apt sources alone"
  exit 0
fi

chosen=""
for mirror in "${fallbacks[@]}"; do
  if answers "$mirror"; then
    chosen="$mirror"
    break
  fi
  echo "fallback mirror did not answer: $mirror"
done

if [ -z "$chosen" ]; then
  echo "::warning::no apt mirror answered; leaving apt sources alone"
  exit 0
fi

echo "apt default mirror is down; using $chosen"
sources=(/etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list)
for f in "${sources[@]}"; do
  [ -f "$f" ] || continue
  sudo sed -i -E \
    -e "s#mirror\+file:/etc/apt/apt-mirrors\.txt#${chosen}/#g" \
    -e "s#https?://(azure\.)?archive\.ubuntu\.com/ubuntu/?#${chosen}/#g" \
    -e "s#https?://security\.ubuntu\.com/ubuntu/?#${chosen}/#g" \
    "$f"
done
grep -hE '^(URIs:|deb )' "${sources[@]}" 2>/dev/null || true
