#!/usr/bin/env bash
#
# Manage the CanvasXpress Dashboards demo server (examples/serve.py) — the
# front-end + cxd_server API + seeded demo datasets, all on one origin.
#
#   ./server.sh start      # launch in the background (seeds datasets on boot)
#   ./server.sh stop       # stop it
#   ./server.sh restart    # stop + start (pick up code / dataset changes)
#   ./server.sh status     # is it running?
#   ./server.sh logs       # follow the log (Ctrl-C to detach)
#
# Config via env: CXD_HOST (default 127.0.0.1), CXD_PORT (default 8000),
# CXD_PYTHON (a Python with the `web` extra; auto-detected otherwise),
# CXD_LLM_API_KEY / CXD_LLM_MODEL (enables the Chat NL builder).
# A gitignored .env file next to this script is loaded automatically, so
# secrets like CXD_LLM_API_KEY can live there instead of the shell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
SERVE="$ROOT/examples/serve.py"
RUN_DIR="$ROOT/examples/.cxd-demo"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
HOST="${CXD_HOST:-127.0.0.1}"
PORT="${CXD_PORT:-8000}"
URL="http://$HOST:$PORT/"

mkdir -p "$RUN_DIR"

# First Python that can import fastapi + uvicorn (or an explicit CXD_PYTHON).
find_python() {
  if [ -n "${CXD_PYTHON:-}" ]; then echo "$CXD_PYTHON"; return 0; fi
  local c
  for c in python3.13 python3.12 python3.11 python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# Echo the tracked PID if it is alive.
running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
  return 1
}

# PIDs of serve.py processes listening on $PORT (catches manual launches too).
serve_pids_on_port() {
  local p
  for p in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
    if ps -o command= -p "$p" 2>/dev/null | grep -q "serve.py"; then echo "$p"; fi
  done
}

start() {
  local pid
  if pid="$(running_pid)"; then echo "already running (pid $pid) — $URL"; return 0; fi
  local py
  if ! py="$(find_python)"; then
    echo "No Python with fastapi+uvicorn found." >&2
    echo "  Set CXD_PYTHON=/path/to/python, or: pip install -e 'server[web]'" >&2
    exit 1
  fi
  echo "starting ($py) on http://$HOST:$PORT/ …"
  # Detach stdin (</dev/null) as well as stdout/stderr so the daemon holds none
  # of the SSH channel's fds — otherwise `ssh … ./server.sh restart` hangs open
  # waiting on the inherited stdin pipe even though the server has fully started.
  ( cd "$ROOT" && CXD_HOST="$HOST" CXD_PORT="$PORT" nohup "$py" "$SERVE" </dev/null >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )
  sleep 2
  if pid="$(running_pid)"; then
    echo "started (pid $pid).  logs: ./server.sh logs"
    echo "  → $URL"
  else
    echo "failed to start — last log lines:" >&2
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
}

stop() {
  local stopped=0 pid p
  if pid="$(running_pid)"; then kill "$pid" 2>/dev/null || true; stopped=1; fi
  for p in $(serve_pids_on_port); do kill "$p" 2>/dev/null || true; stopped=1; done
  rm -f "$PID_FILE"
  if [ "$stopped" = 1 ]; then echo "stopped."; else echo "not running."; fi
}

status() {
  local pid pp
  if pid="$(running_pid)"; then
    echo "running (pid $pid) — $URL"
  else
    pp="$(serve_pids_on_port || true)"
    if [ -n "$pp" ]; then
      echo "running but untracked (pid(s): $pp) on port $PORT — 'restart' will adopt it."
    else
      echo "stopped."
    fi
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    touch "$LOG_FILE"; tail -n "${2:-40}" -f "$LOG_FILE" ;;
  *) echo "usage: $(basename "$0") {start|stop|restart|status|logs}"; exit 2 ;;
esac
