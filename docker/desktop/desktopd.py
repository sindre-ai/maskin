#!/usr/bin/env python3
"""desktopd: the control endpoint for the workspace desktop VM.

Why this exists: `msb exec <vm> -- <cmd>` hangs while the entrypoint's own exec
holds the VM, so the host cannot run xdotool/scrot by exec'ing into it. Instead
the VM serves this small HTTP API on a second published port, exactly like noVNC
is served on the first.

Auth: `Authorization: Bearer <VNC_PASSWORD>` on everything except /healthz. The
port is published on the msb bridge only (never a public interface) and the
caller is the agent-server, never a session VM directly.

The request schema mirrors packages/shared/src/schemas/desktop.ts. apps/dev
validates first; this validates again because it is the last stop before a
command line is built. Arguments always go to xdotool as a list — never through
a shell — except /exec, whose whole purpose is to run the agent's command.
"""

import base64
import hmac
import http.client
import json
import os
import re
import socket
import struct
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
PORT = int(os.environ.get("DESKTOPD_PORT", "6081"))
NOVNC_PORT = int(os.environ.get("NOVNC_PORT", "6080"))
PASSWORD = os.environ.get("VNC_PASSWORD", "")
# The screen size. Agents see the screenshot and click in these native pixels, so keep
# it in step with the entrypoint's SCREEN_SIZE default.
WIDTH, HEIGHT = 1920, 1080
MAX_BODY = 64 * 1024
MAX_OUTPUT = 20_000
KEY_RE = re.compile(r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$")
BUTTONS = {"left": "1", "middle": "2", "right": "3"}

# Chromium's debugging port, on this machine only (see the flags in the Dockerfile). Used
# to read which field has focus before a saved password is typed.
CDP_HOST, CDP_PORT = "127.0.0.1", int(os.environ.get("CHROMIUM_DEBUG_PORT", "9222"))

# Runs inside the page. Follows focus through open shadow roots and same-origin frames and
# answers with a word, never with page content. Anything it cannot see into (a frame from
# another site) is "frame", which counts as not confirmed.
FOCUS_PROBE = """(() => {
  if (!document.hasFocus()) return 'unfocused';
  let el = document.activeElement;
  for (let i = 0; i < 20 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try {
        const d = el.contentDocument;
        if (d && d.activeElement) { el = d.activeElement; continue; }
      } catch (e) {}
      return 'frame';
    }
    break;
  }
  return el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password' ? 'password' : 'other';
})()"""

ENV = {**os.environ, "DISPLAY": DISPLAY}
# xdotool calls interleave badly (a click between a move and a drag-release).
input_lock = threading.Lock()


class BadRequest(Exception):
    pass


class NotPasswordField(Exception):
    """A saved password was about to be typed and the focus is not a confirmed password field."""


def xdo(*args):
    subprocess.run(["xdotool", *args], env=ENV, check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


class WebSocket:
    """A bare-bones client for Chromium's debugging port, standard library only."""

    def __init__(self, path):
        self.sock = socket.create_connection((CDP_HOST, CDP_PORT), timeout=3)
        self.buf = b""
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {CDP_HOST}:{CDP_PORT}\r\n"
                               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            while b"\r\n\r\n" not in self.buf:
                self._fill()
                if len(self.buf) > 16_384:
                    raise OSError("unexpected handshake reply")
            head, self.buf = self.buf.split(b"\r\n\r\n", 1)
            if not head.startswith(b"HTTP/1.1 101"):
                raise OSError("debugging port refused the WebSocket")
        except Exception:
            self.sock.close()
            raise

    def _fill(self):
        chunk = self.sock.recv(65_536)
        if not chunk:
            raise OSError("debugging port closed the connection")
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        header = bytearray([0x81])
        if len(data) < 126:
            header.append(0x80 | len(data))
        elif len(data) < 65_536:
            header += bytes([0x80 | 126]) + struct.pack(">H", len(data))
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", len(data))
        mask = os.urandom(4)
        self.sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        """One text message, joined from its fragments."""
        message = b""
        while True:
            b0, b1 = self._take(2)
            length = b1 & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", self._take(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._take(8))
            if length > 1_000_000:
                raise OSError("reply too large")
            payload = self._take(length)
            opcode = b0 & 0x0F
            if opcode == 0x8:
                raise OSError("debugging port closed the WebSocket")
            if opcode in (0x9, 0xA):  # ping / pong: nothing to do
                continue
            message += payload
            if b0 & 0x80:
                return message.decode("utf-8", "replace")

    def close(self):
        self.sock.close()


def page_focus(ws_path):
    """Asks one page what has focus: 'password', 'other', 'frame' or 'unfocused'."""
    ws = WebSocket(ws_path)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": FOCUS_PROBE, "returnByValue": True}}))
        while True:
            reply = json.loads(ws.recv())
            if reply.get("id") == 1:
                value = (reply.get("result") or {}).get("result", {}).get("value")
                return value if isinstance(value, str) else "unknown"
    finally:
        ws.close()


def focused_field_is_password():
    """True only when exactly one browser page has focus and its focused element is a password
    input. Every failure (no debugging port, no page, a frame it cannot see into, more than one
    page claiming focus) answers False: the caller types nothing."""
    try:
        conn = http.client.HTTPConnection(CDP_HOST, CDP_PORT, timeout=3)
        try:
            conn.request("GET", "/json/list")
            targets = json.loads(conn.getresponse().read())
        finally:
            conn.close()
        answers = []
        for t in targets:
            if t.get("type") != "page":
                continue
            ws = t.get("webSocketDebuggerUrl", "")
            m = re.match(r"^ws://[^/]+(/devtools/page/[A-Za-z0-9-]+)$", ws)
            if not m:
                continue
            answer = page_focus(m.group(1))
            if answer != "unfocused":
                answers.append(answer)
        return answers == ["password"]
    except Exception:
        return False


def coord(body, key, limit):
    v = body.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < limit:
        raise BadRequest(f"{key} must be an integer in [0, {limit - 1}]")
    return v


def run_input(body):
    action = body.get("action")
    with input_lock:
        if action == "click":
            btn = BUTTONS.get(body.get("button", "left"))
            if btn is None:
                raise BadRequest("button must be left, middle or right")
            xdo("mousemove", str(coord(body, "x", WIDTH)), str(coord(body, "y", HEIGHT)))
            xdo("click", "--repeat", "2" if body.get("double") is True else "1", btn)
        elif action == "move":
            xdo("mousemove", str(coord(body, "x", WIDTH)), str(coord(body, "y", HEIGHT)))
        elif action == "drag":
            xdo("mousemove", str(coord(body, "from_x", WIDTH)), str(coord(body, "from_y", HEIGHT)))
            xdo("mousedown", "1")
            xdo("mousemove", str(coord(body, "to_x", WIDTH)), str(coord(body, "to_y", HEIGHT)))
            xdo("mouseup", "1")
        elif action == "scroll":
            if body.get("direction") not in ("up", "down"):
                raise BadRequest("direction must be up or down")
            amount = body.get("amount", 3)
            if isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= 20:
                raise BadRequest("amount must be an integer in [1, 20]")
            if "x" in body and "y" in body:
                xdo("mousemove", str(coord(body, "x", WIDTH)), str(coord(body, "y", HEIGHT)))
            xdo("click", "--repeat", str(amount), "4" if body["direction"] == "up" else "5")
        elif action == "type":
            text = body.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 2000:
                raise BadRequest("text must be a string of 1-2000 characters")
            # `--` so text starting with '-' is data, not an option.
            xdo("type", "--delay", "12", "--", text)
        elif action == "type_secret":
            # A saved password, typed only into a password field. The check and the typing
            # happen under the same lock, so another call cannot move focus between them.
            text = body.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 2000:
                raise BadRequest("text must be a string of 1-2000 characters")
            if body.get("require") != "password_field":
                raise BadRequest("require must be password_field")
            if not focused_field_is_password():
                raise NotPasswordField()
            xdo("type", "--delay", "12", "--", text)
        elif action == "key":
            keys = body.get("keys")
            if (not isinstance(keys, list) or not 1 <= len(keys) <= 20
                    or not all(isinstance(k, str) and len(k) <= 64 and KEY_RE.match(k) for k in keys)):
                raise BadRequest("keys must be 1-20 key combos like 'ctrl+l'")
            for k in keys:
                xdo("key", "--", k)
        else:
            raise BadRequest("unknown action")


def screenshot():
    path = "/tmp/desktopd-shot.jpg"
    subprocess.run(["scrot", "-o", "-q", "60", path], env=ENV, check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    with open(path, "rb") as f:
        return f.read()


def run_exec(body):
    command = body.get("command")
    timeout = body.get("timeout_s", 30)
    if not isinstance(command, str) or not 1 <= len(command) <= 10_000:
        raise BadRequest("command must be a string of 1-10000 characters")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 120:
        raise BadRequest("timeout_s must be an integer in [1, 120]")
    try:
        p = subprocess.run(["sh", "-c", command], env=ENV, timeout=timeout,
                           stdin=subprocess.DEVNULL, capture_output=True)
        code, out, err, timed_out = p.returncode, p.stdout, p.stderr, False
    except subprocess.TimeoutExpired as e:
        code, out, err, timed_out = None, e.stdout or b"", e.stderr or b"", True
    clip = lambda b: b.decode("utf-8", "replace")[:MAX_OUTPUT]
    return {"exit_code": code, "stdout": clip(out), "stderr": clip(err), "timed_out": timed_out}


def ready():
    """X is up AND websockify is listening — i.e. the desktop is actually viewable."""
    try:
        subprocess.run(["xdotool", "getdisplaygeometry"], env=ENV, check=True, timeout=3,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with socket.create_connection(("127.0.0.1", NOVNC_PORT), timeout=1):
            return True
    except Exception:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "desktopd"

    def log_message(self, *_):  # no request logging: bodies can hold typed secrets
        pass

    def reply(self, status, payload, content_type="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        got = self.headers.get("Authorization", "")
        return bool(PASSWORD) and hmac.compare_digest(got.encode(), f"Bearer {PASSWORD}".encode())

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise BadRequest("invalid Content-Length")
        if not 0 <= length <= MAX_BODY:
            raise BadRequest("body too large")
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise BadRequest("invalid JSON")
        if not isinstance(body, dict):
            raise BadRequest("body must be an object")
        return body

    def do_GET(self):
        if self.path == "/healthz":
            ok = ready()
            return self.reply(200 if ok else 503, {"ready": ok})
        self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if not self.authed():
            return self.reply(401, {"error": "unauthorized"})
        try:
            if self.path == "/screenshot":
                return self.reply(200, {"image_base64": base64.b64encode(screenshot()).decode(),
                                        "mime_type": "image/jpeg", "width": WIDTH, "height": HEIGHT})
            if self.path == "/input":
                run_input(self.read_json())
                return self.reply(200, {"ok": True})
            if self.path == "/exec":
                return self.reply(200, run_exec(self.read_json()))
            self.reply(404, {"error": "not_found"})
        except BadRequest as e:
            self.reply(400, {"error": "invalid_request", "message": str(e)})
        except NotPasswordField:
            self.reply(409, {"error": "not_a_password_field"})
        except subprocess.CalledProcessError as e:
            self.reply(502, {"error": "desktop_command_failed",
                             "message": (e.stderr or b"").decode("utf-8", "replace")[:500]})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "desktop_command_timeout"})


if __name__ == "__main__":
    if not PASSWORD:
        raise SystemExit("desktopd: VNC_PASSWORD is required")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
