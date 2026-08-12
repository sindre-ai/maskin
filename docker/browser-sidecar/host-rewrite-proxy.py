#!/usr/bin/env python3
"""TCP bridge from :9222 to Chromium's real CDP port (127.0.0.1:9223) that
rewrites the Host header on every HTTP request until the WebSocket handshake,
then relays raw bytes — and rewrites Chrome's own echoed hostname back out of
each plain HTTP response so the client can actually reconnect to it.

Chrome's DevTools HTTP server rejects any request whose Host header isn't
`localhost` or a raw IP (DNS-rebinding protection). Sessions reach this
sidecar via `http://host.microsandbox.internal:<relayPort>/...`, so every
request's Host header fails that check and Chrome returns 500.

Rewriting the request's Host header to `localhost:<port>` (keeping the
client's own port) fixes that half of the round trip. But Chrome's CDP HTTP
handler also echoes the Host header it received verbatim into fields it
returns from /json/version and /json/list — most importantly
`webSocketDebuggerUrl`. A client that blindly opens the URL it was handed (as
@playwright/mcp does) would then try to connect to
`ws://localhost:<port>/...` — and "localhost" there resolves inside the
CLIENT's own network namespace (a sibling guest VM reachable only via the
`host.microsandbox.internal` DNS name and this proxy's own host-relayed
port), not back through this proxy, so nothing is listening and the client
gets ECONNREFUSED. So this proxy also rewrites the echoed `localhost:<port>`
authority back out of each plain HTTP response body, substituting the
client's own Host value (whatever it actually used to reach this proxy —
`host.microsandbox.internal:<relayPort>` for a sibling guest,
`127.0.0.1:<relayPort>` for the agent-server's own readiness poll) before
forwarding the response — the reverse of the request-side rewrite, undone
specifically so the client's *next* request lands somewhere real.

Once a request carries `Upgrade: websocket`, the connection becomes a raw
framed byte stream with no further HTTP headers or bodies to rewrite, so
relaying switches to a byte-for-byte bidirectional bridge for the rest of the
connection's lifetime — replaces the plain `socat TCP-LISTEN` bridge, which
has no HTTP awareness and can't do either rewrite at all.
"""

import asyncio
import re

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 9222
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9223

UPGRADE_RE = re.compile(rb"(?im)^upgrade:\s*websocket\s*$")
HOST_HEADER_RE = re.compile(rb"(?im)^host:\s*(.+?)\s*$")


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


async def read_exact(reader: asyncio.StreamReader, n: int, already: bytes) -> bytes:
	"""Read until exactly n bytes are in hand, starting from bytes already read."""
	data = already
	while len(data) < n:
		chunk = await reader.read(n - len(data))
		if not chunk:
			break
		data += chunk
	return data


def request_host(head: bytes) -> bytes | None:
	for line in head.split(b"\r\n"):
		m = HOST_HEADER_RE.match(line)
		if m:
			return m.group(1)
	return None


def rewrite_request_host(head: bytes, new_authority: bytes) -> bytes:
	lines = head.split(b"\r\n")
	rewritten = [
		b"Host: " + new_authority if line.lower().startswith(b"host:") else line for line in lines
	]
	return b"\r\n".join(rewritten)


def is_upgrade_request(head: bytes) -> bool:
	return any(UPGRADE_RE.match(line) for line in head.split(b"\r\n"))


def content_length(head: bytes) -> int:
	for line in head.split(b"\r\n")[1:]:
		if line.lower().startswith(b"content-length:"):
			try:
				return int(line.split(b":", 1)[1].strip())
			except ValueError:
				return 0
	return 0


def rewrite_response(head: bytes, body: bytes, sent_authority: bytes, client_authority: bytes):
	"""Replace every occurrence of the authority we substituted into the
	request (e.g. `localhost:45573`) with the authority the client actually
	used to reach this proxy (e.g. `host.microsandbox.internal:45573`) —
	undoes the request-side rewrite specifically in Chrome's echoed output,
	so URLs Chrome hands back (webSocketDebuggerUrl, devtoolsFrontendUrl) are
	ones the client can actually connect to next.
	"""
	if sent_authority == client_authority:
		return head, body
	new_body, n = re.subn(re.escape(sent_authority), client_authority, body)
	if n == 0:
		return head, body
	lines = head.split(b"\r\n")
	new_lines = [
		b"Content-Length: " + str(len(new_body)).encode()
		if line.lower().startswith(b"content-length:")
		else line
		for line in lines
	]
	return b"\r\n".join(new_lines), new_body


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


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
	try:
		upstream_reader, upstream_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
	except OSError as exc:
		print(f"host-rewrite-proxy: failed to connect to Chromium CDP: {exc!r}", flush=True)
		writer.close()
		return

	try:
		while True:
			head, rest = await read_http_head(reader)
			if not head:
				if rest:
					upstream_writer.write(rest)
					await upstream_writer.drain()
				break

			client_authority = request_host(head) or b"localhost"
			port = client_authority.rsplit(b":", 1)[1] if b":" in client_authority else None
			sent_authority = b"localhost:" + port if port else b"localhost"

			upstream_writer.write(rewrite_request_host(head, sent_authority) + b"\r\n\r\n" + rest)
			await upstream_writer.drain()

			if is_upgrade_request(head):
				# The response is the 101 Switching Protocols handshake, then
				# raw WS frames — nothing left to rewrite, so hand off to a
				# straight byte-for-byte bidirectional relay for the rest of
				# the connection's lifetime.
				await asyncio.gather(
					pipe(reader, upstream_writer),
					pipe(upstream_reader, writer),
				)
				return

			# Plain HTTP request/response (e.g. GET /json/version) — read the
			# full response so the authority Chrome echoed back can be
			# rewritten for the client before forwarding, then loop for the
			# next request on this keep-alive connection.
			resp_head, resp_rest = await read_http_head(upstream_reader)
			if not resp_head:
				break
			body = await read_exact(upstream_reader, content_length(resp_head), resp_rest)
			new_head, new_body = rewrite_response(resp_head, body, sent_authority, client_authority)
			writer.write(new_head + b"\r\n\r\n" + new_body)
			await writer.drain()
	except (ConnectionResetError, BrokenPipeError) as exc:
		print(f"host-rewrite-proxy: connection dropped: {exc!r}", flush=True)
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
