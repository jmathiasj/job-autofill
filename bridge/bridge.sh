#!/usr/bin/env bash
# AutoApply Claude bridge control.  Usage: ./bridge.sh {start|stop|restart|status|logs}
# Mirrors the Wisdom pattern: nohup-detached so it survives closing the terminal
# / Claude Code session. Manual start (run again after a reboot), like `wisdom`.
SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -L "$SOURCE" ]; do
  T="$(readlink "$SOURCE")"; case "$T" in /*) SOURCE="$T" ;; *) SOURCE="$(dirname "$SOURCE")/$T" ;; esac
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
PIDFILE="$DIR/.bridge.pid"
LOG="$DIR/bridge.log"
PORT=8765

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

start() {
  if running; then echo "already running (pid $(cat "$PIDFILE")) on http://127.0.0.1:$PORT"; return; fi
  lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null   # clear anything stale on the port
  cd "$DIR" || exit 1
  nohup python3 claude_bridge.py >"$LOG" 2>&1 &   # detached, survives terminal close
  echo $! > "$PIDFILE"
  sleep 1
  if running; then echo "started (pid $(cat "$PIDFILE")) on http://127.0.0.1:$PORT"
  else echo "failed to start - last log lines:"; tail -3 "$LOG"; rm -f "$PIDFILE"; fi
}

stop() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE"
  lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null   # fallback: kill anything still on the port
  echo "stopped"
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)
    if running; then echo "running (pid $(cat "$PIDFILE")) on http://127.0.0.1:$PORT"
    elif lsof -ti tcp:"$PORT" >/dev/null 2>&1; then echo "running on :$PORT (pid $(lsof -ti tcp:"$PORT" | tr '\n' ' '), started outside this script)"
    else echo "not running"; fi ;;
  logs)    tail -f "$LOG" ;;
  *)       echo "usage: ./bridge.sh {start|stop|restart|status|logs}"; exit 1 ;;
esac
