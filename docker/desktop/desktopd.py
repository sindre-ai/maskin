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
import json
import os
import re
import socket
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
PORT = int(os.environ.get("DESKTOPD_PORT", "6081"))
NOVNC_PORT = int(os.environ.get("NOVNC_PORT", "6080"))
PASSWORD = os.environ.get("VNC_PASSWORD", "")
WIDTH, HEIGHT = 1280, 720
MAX_BODY = 64 * 1024
MAX_OUTPUT = 20_000
KEY_RE = re.compile(r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$")
BUTTONS = {"left": "1", "middle": "2", "right": "3"}

ENV = {**os.environ, "DISPLAY": DISPLAY}
# xdotool calls interleave badly (a click between a move and a drag-release).
input_lock = threading.Lock()


class BadRequest(Exception):
    pass


def xdo(*args):
    subprocess.run(["xdotool", *args], env=ENV, check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


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
        except subprocess.CalledProcessError as e:
            self.reply(502, {"error": "desktop_command_failed",
                             "message": (e.stderr or b"").decode("utf-8", "replace")[:500]})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "desktop_command_timeout"})


if __name__ == "__main__":
    if not PASSWORD:
        raise SystemExit("desktopd: VNC_PASSWORD is required")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
