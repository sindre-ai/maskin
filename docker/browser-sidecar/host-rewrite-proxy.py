#!/usr/bin/env python3
"""TCP bridge from :9222 to Chromium's real CDP port (127.0.0.1:9223) that
rewrites the `Host` header on every HTTP request until the WebSocket
handshake, then relays raw bytes.

Chrome's DevTools HTTP server rejects any request whose `Host` header isn't
`localhost` or a raw IP (DNS-rebinding protection). Sessions reach this
sidecar via `http://host.microsandbox.internal:<relayPort>/...`, so every
request's `Host` header fails that check and Chrome returns 500 (see
docs/runbooks/agent-session-failures-2026-08-11.md, Issue 2). This rewrites
the `Host` header to `localhost` on every plain HTTP request sent over a
connection, not just the first — a client may poll `/json/version`-style
endpoints multiple times over one keep-alive connection before ever
upgrading to a WebSocket, and only fixing the first request left later
requests on that same connection rejected exactly as before. Once a request
carries `Upgrade: websocket`, the connection becomes a raw framed byte
stream with no further HTTP headers to rewrite, so relaying switches to a
byte-for-byte bridge for the rest of the connection's lifetime — replaces
the plain `socat TCP-LISTEN` bridge, which has no HTTP awareness and can't
do this rewrite at all.
"""

import asyncio
import re

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 9222
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9223

UPGRADE_RE = re.compile(rb"(?im)^upgrade:\s*websocket\s*$")


async def read_http_head(reader: asyncio.StreamReader) -> tuple[bytes, bytes]:
	"""Read up to and including the blank line ending the HTTP header block.

	Returns (head_without_trailing_blank_line, anything read past it). Reads
	one byte at a time — headers are a few hundred bytes, so the overhead is
	negligible and this is the only way to avoid over-reading into a body or
	the start of a WebSocket frame that happens to follow immediately.
	"""
	buf = b""
	while b"\r\n\r\n" not in buf:
		chunk = await reader.read(1)
		if not chunk:
			break
		buf += chunk
	head, _, rest = buf.partition(b"\r\n\r\n")
	return head, rest


def rewrite_host_header(head: bytes) -> bytes:
	lines = head.split(b"\r\n")
	rewritten = [b"Host: localhost" if line.lower().startswith(b"host:") else line for line in lines]
	return b"\r\n".join(rewritten)


def is_upgrade_request(head: bytes) -> bool:
	return any(UPGRADE_RE.match(line) for line in head.split(b"\r\n"))


async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
	try:
		while True:
			data = await src.read(65536)
			if not data:
				break
			dst.write(data)
			await dst.drain()
	except (ConnectionResetError, BrokenPipeError) as exc:
		print(f"host-rewrite-proxy: relay leg dropped: {exc!r}", flush=True)
	finally:
		dst.close()


async def relay_client_requests(
	reader: asyncio.StreamReader, upstream_writer: asyncio.StreamWriter
) -> None:
	"""Rewrite the Host header on each HTTP request read from the client
	until a WebSocket upgrade request is seen, then relay the rest of the
	connection byte-for-byte — a WS connection has no further HTTP headers to
	rewrite, and this is also what lets a request's own response (relayed
	independently by the concurrent `pipe(upstream_reader, writer)` task)
	keep flowing back to the client between requests on a keep-alive
	connection instead of deadlocking on this loop.
	"""
	try:
		while True:
			head, rest = await read_http_head(reader)
			if not head:
				if rest:
					upstream_writer.write(rest)
					await upstream_writer.drain()
				return
			upstream_writer.write(rewrite_host_header(head) + b"\r\n\r\n" + rest)
			await upstream_writer.drain()
			if is_upgrade_request(head):
				break
	except (ConnectionResetError, BrokenPipeError) as exc:
		print(f"host-rewrite-proxy: client-request relay dropped: {exc!r}", flush=True)
		return
	await pipe(reader, upstream_writer)


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
	try:
		upstream_reader, upstream_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
	except OSError as exc:
		print(f"host-rewrite-proxy: failed to connect to Chromium CDP: {exc!r}", flush=True)
		writer.close()
		return

	try:
		await asyncio.gather(
			relay_client_requests(reader, upstream_writer),
			pipe(upstream_reader, writer),
		)
	finally:
		writer.close()
		upstream_writer.close()


async def main() -> None:
	server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
	print(f"host-rewrite-proxy: listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
	async with server:
		await server.serve_forever()


if __name__ == "__main__":
	asyncio.run(main())
