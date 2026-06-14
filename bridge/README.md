# Local Claude bridge (optional)

Routes the extension's AI calls through the **`claude` CLI** (`claude -p`) - your
Claude Code subscription - instead of the metered Anthropic API. Use it if you'd
rather spend subscription usage than pay per token.

## Run it

```bash
python3 claude_bridge.py
```

Keep that terminal open. Then open the extension popup and tick
**"Use local Claude"**. The popup shows a live "bridge running ✓" status.

That's it - no install, no dependencies (Python 3 stdlib only). Requires the
`claude` CLI (Claude Code) on your PATH and signed in.

## How it works

The extension POSTs the same request body it would send to `api.anthropic.com`
to `http://127.0.0.1:8765`. The bridge flattens it into a `claude -p` call
(`--output-format json`, `--system-prompt`, the answer schema folded into the
prompt) and returns the result in the Anthropic Messages shape, so nothing
downstream in the extension changes. The extension's deterministic validation
(exact-option / profile-verbatim / confidence checks) still runs on top, so the
grounding guarantees are identical to API mode.

## Trade-offs vs the API

- **Cost:** draws from your Claude Code subscription, not per-token billing.
- **Speed:** slower - `claude -p` loads the full agent harness per call, so each
  page takes a few seconds longer than a direct API call.
- **Usage limits:** each call carries ~20k tokens of Claude Code harness context,
  so heavy batch applying eats subscription limits faster than the lean API call.
- **Fallback:** if "Use local Claude" is on but the bridge isn't running, the
  extension automatically falls back to the API when an API key is configured;
  otherwise it shows a "start the bridge" message.

## Safety

The bridge feeds untrusted job-description text to `claude`, which can run tools
(Bash, Write, ...) on your machine. Mitigations:

- runs in **default permission mode** (no `--dangerously-skip-permissions`), so
  permissioned tools can't auto-execute in headless `-p` mode;
- explicitly passes `--disallowed-tools Bash Write Edit Read ...`;
- binds to **127.0.0.1 only** - never exposed to the network.

Config (port, model, timeout, blocked tools) is at the top of
`claude_bridge.py`.
