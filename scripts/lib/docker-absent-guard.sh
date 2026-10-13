#!/usr/bin/env bash
# Docker-absent guard for the no-Docker dev path (sourced by dev-no-docker.sh).
#
# apps/dev warms two Docker images at boot. With no Docker daemon that work is
# doomed, so detect the absence up front, name the missing socket, and export
# MASKIN_DOCKER_UNAVAILABLE=1 so apps/dev/src/index.ts skips the warm calls.
#
#   MASKIN_REQUIRE_DOCKER=1  turn the skip into a fast non-zero exit
#   DOCKER_HOST              only unix:// (or unset) is tested as a socket path;
#                            tcp:// / http:// means a remote daemon, so the flag
#                            is left unset and the warm calls run
maskin_docker_absent_guard() {
	local host="${DOCKER_HOST:-unix:///var/run/docker.sock}"
	local socket

	case "$host" in
		unix://*) socket="${host#unix://}" ;;
		*://*) return 0 ;;
		*) socket="$host" ;;
	esac

	if [ -S "$socket" ]; then
		return 0
	fi

	echo "no Docker socket at $socket" >&2
	if [ "${MASKIN_REQUIRE_DOCKER:-}" = "1" ]; then
		echo "MASKIN_REQUIRE_DOCKER=1 is set, so a missing Docker socket is fatal." >&2
		return 1
	fi
	echo "Continuing without Docker: skipping the agent-base and browser-sidecar image warm-up." >&2
	export MASKIN_DOCKER_UNAVAILABLE=1
}
