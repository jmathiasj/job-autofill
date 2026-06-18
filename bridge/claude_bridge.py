#!/usr/bin/env python3
"""
AutoApply local Claude bridge.

Lets the AutoApply Chrome extension route its AI calls through the `claude` CLI
(`claude -p`) - i.e. your Claude Code subscription - instead of the metered
Anthropic API. The extension POSTs the same request body it would send to the
API; this server translates it into a `claude -p` invocation and returns a
response in the same shape the extension already understands.

Run it and keep it open while you apply:

    python3 claude_bridge.py

Then turn on "Use local Claude" in the extension popup.

Safety: the job-description text we feed to Claude is untrusted, and `claude`
can run tools (Bash, Write, ...) on your machine. This bridge runs in default
permission mode (no --dangerously-skip-permissions, so permissioned tools can't
auto-run in headless mode) AND explicitly disallows the dangerous tools. It
binds to 127.0.0.1 only - never exposed to the network. No dependencies.
"""

import json
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765
MODEL_DEFAULT = "claude-opus-4-8"
CLAUDE_TIMEOUT = 180  # seconds per call
# Never let an agent loop touch the machine while processing untrusted JD text.
BLOCK_TOOLS = ["Bash", "Write", "Edit", "Read", "NotebookEdit", "WebFetch",
               "WebSearch", "Glob", "Grep", "Task"]


def _flatten_system(system):
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        return "\n\n".join(b.get("text", "") for b in system if isinstance(b, dict))
    return ""


def _flatten_user(messages):
    parts = []
    for m in messages or []:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            parts.append("\n".join(b.get("text", "") for b in c if isinstance(b, dict)))
    return "\n\n".join(parts)


def _extract_json(text):
    """Pull a clean JSON value out of the model's reply (strip fences/prose)."""
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    m = re.search(r"[\{\[].*[\}\]]", t, re.S)
    return m.group(0) if m else t


def run_claude(body):
    model = body.get("model") or MODEL_DEFAULT
    system = _flatten_system(body.get("system"))
    user = _flatten_user(body.get("messages"))

    fmt = (body.get("output_config") or {}).get("format")
    wants_json = bool(fmt)
    if wants_json:
        directive = ("\n\nOUTPUT FORMAT: Respond with ONLY a single valid JSON value. "
                     "No prose, no markdown, no code fences, nothing before or after it.")
        schema = fmt.get("schema") if isinstance(fmt, dict) else None
        if schema:
            directive += " It MUST conform exactly to this JSON Schema:\n" + json.dumps(schema)
        system += directive

    cmd = ["claude", "-p", "--output-format", "json", "--model", model,
           "--system-prompt", system,
           "--disallowed-tools", *BLOCK_TOOLS]
    try:
        proc = subprocess.run(cmd, input=user, capture_output=True, text=True,
                              timeout=CLAUDE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"error": "claude timed out after %ds" % CLAUDE_TIMEOUT}
    except FileNotFoundError:
        return {"error": "`claude` CLI not found on PATH - install Claude Code first"}

    if proc.returncode != 0:
        return {"error": (proc.stderr or "claude exited %d" % proc.returncode).strip()[:400]}

    try:
        out = json.loads(proc.stdout)
    except Exception as e:
        return {"error": "could not parse claude output: " + str(e)}

    if out.get("is_error"):
        return {"error": (out.get("result") or "claude reported an error")[:400]}

    result = out.get("result", "")
    if wants_json:
        result = _extract_json(result)

    # Return the Anthropic-Messages shape the extension already consumes.
    return {"content": [{"type": "text", "text": result}],
            "usage": out.get("usage", {}),
            "_via": "claude-cli"}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        # health check the popup pings to show "bridge running"
        self.send_response(200); self._cors()
        self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "bridge": "autoapply-claude", "model": MODEL_DEFAULT}).encode())

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            result = run_claude(body)
        except Exception as e:
            result = {"error": str(e)[:400]}
        payload = json.dumps(result).encode()
        self.send_response(200); self._cors()
        self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print(f"AutoApply Claude bridge on http://{HOST}:{PORT}  (model: {MODEL_DEFAULT})")
    print("Keep this open. Enable 'Use local Claude' in the extension popup. Ctrl-C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbridge stopped.")
