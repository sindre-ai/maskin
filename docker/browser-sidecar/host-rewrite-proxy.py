#!/usr/bin/env python3
"""TCP bridge from :9222 to Chromium's real CDP port (127.0.0.1:9223) that
rewrites the `Host` header on each connection's first HTTP request.

Chrome's DevTools HTTP server rejects any request whose `Host` header isn't
`localhost` or a raw IP (DNS-rebinding protection). Sessions reach this
sidecar via `http://host.microsandbox.internal:<relayPort>/...`, so every
request's `Host` header fails that check and Chrome returns 500 (see
docs/runbooks/agent-session-failures-2026-08-11.md, Issue 2). This rewrites
just the `Host` header on the first request per connection to `localhost`,
then relays all bytes byte-for-byte (including the WebSocket upgrade and
subsequent binary frames) — replaces the plain `socat TCP-LISTEN` bridge,
which has no HTTP awareness and can't do this rewrite.
"""

import asyncio

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 9222
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9223


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


async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
	try:
		while True:
			data = await src.read(65536)
			if not data:
				break
			dst.write(data)
			await dst.drain()
	except (ConnectionResetError, BrokenPipeError):
		pass
	finally:
		dst.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
	try:
		upstream_reader, upstream_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
	except OSError:
		writer.close()
		return

	try:
		head, rest = await read_http_head(reader)
		if head:
			upstream_writer.write(rewrite_host_header(head) + b"\r\n\r\n" + rest)
			await upstream_writer.drain()
		elif rest:
			upstream_writer.write(rest)
			await upstream_writer.drain()

		await asyncio.gather(
			pipe(reader, upstream_writer),
			pipe(upstream_reader, writer),
		)
	finally:
		writer.close()
		upstream_writer.close()


async def main() -> None:
	server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
	async with server:
		await server.serve_forever()


if __name__ == "__main__":
	asyncio.run(main())
