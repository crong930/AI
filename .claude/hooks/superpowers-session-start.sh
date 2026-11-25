#!/usr/bin/env bash
# Injects the Superpowers "using-superpowers" skill at session start,
# like the Superpowers plugin's own SessionStart hook does.
# Cloud sessions can't install plugins, so the skills live in .claude/skills.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-.}"
f="$ROOT/.claude/skills/using-superpowers/SKILL.md"
[ -r "$f" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
python3 - "$f" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read().rstrip("\n")
ctx = ("<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n"
       "The Superpowers skills are installed as project skills in this repository. "
       "Wherever a skill says `superpowers:<name>`, invoke the project skill `<name>` with the Skill tool "
       "(for example `superpowers:brainstorming` is the `brainstorming` skill).\n\n"
       "**Below is the full content of your 'using-superpowers' skill - your introduction to using skills. "
       "For all other skills, use the 'Skill' tool:**\n\n" + body + "\n</EXTREMELY_IMPORTANT>")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))
PY
