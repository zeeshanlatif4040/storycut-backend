#!/bin/bash
# StoryCut launcher
set -e
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  echo "Creating virtualenv…"
  python3 -m venv .venv
fi
if ! .venv/bin/python -c "import flask" 2>/dev/null; then
  echo "Installing Flask…"
  .venv/bin/pip install --quiet flask
fi
PORT="${PORT:-8099}"
echo "Starting StoryCut on http://127.0.0.1:$PORT"
exec .venv/bin/python -m backend.app
