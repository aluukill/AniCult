#!/usr/bin/env bash
# AniCult Web Launcher
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
VENV=".venv"
[ ! -d "$VENV" ] && python3 -m venv "$VENV"
source "$VENV/bin/activate"
pip install -q -r requirements.txt
echo ""
echo "  AniCult Web → http://localhost:5000"
echo ""
python3 app.py
