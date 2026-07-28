#!/usr/bin/env bash
# birth.sh — light a new agent from the hearth.
#
#   git clone git@github.com:dglittle/hearth.git ~/newagent
#   cd ~/newagent && ./birth.sh <name> <port> "<purpose>" [host]
#
# Substitutes the template placeholders IN PLACE in this checkout, creates the
# living-state dirs, and generates web/key.txt. After this, the directory IS
# the agent: `node erg.js` performs one erg.
#
# Placeholders: {{AGENT_NAME}} {{AGENT_DIR}} {{PORT}} {{HOST}} {{PURPOSE}}
set -euo pipefail

NAME="${1:-}"; PORT="${2:-}"; PURPOSE="${3:-}"; HOST="${4:-localhost}"
if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$PURPOSE" ]; then
  echo "usage: ./birth.sh <name> <port> \"<purpose>\" [host]" >&2
  echo "  e.g. ./birth.sh athena 8443 \"the operator's work on the atlas project\"" >&2
  exit 2
fi
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! grep -rq '{{AGENT_NAME}}' "$DIR/mind" 2>/dev/null; then
  echo "refusing: $DIR looks already born (no placeholders left in mind/)" >&2
  exit 1
fi

# files to templatize: everything tracked except this script and the docs
FILES=$(cd "$DIR" && git ls-files 2>/dev/null | grep -vE '^(birth\.sh|README\.md|CONTRIBUTING\.md|\.gitignore)$' || true)
[ -n "$FILES" ] || { echo "refusing: no git-tracked files found in $DIR" >&2; exit 1; }

esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
( cd "$DIR" && printf '%s\n' "$FILES" | xargs sed -i \
    -e "s|{{AGENT_DIR}}|$(esc "$DIR")|g" \
    -e "s|{{AGENT_NAME}}|$(esc "$NAME")|g" \
    -e "s|{{PORT}}|$(esc "$PORT")|g" \
    -e "s|{{HOST}}|$(esc "$HOST")|g" \
    -e "s|{{PURPOSE}}|$(esc "$PURPOSE")|g" )

mkdir -p "$DIR"/{ergs,work,secrets} \
         "$DIR"/input/processed "$DIR"/output/processed \
         "$DIR"/ro/input/processed "$DIR"/ro/output/processed "$DIR"/ro/ergs "$DIR"/ro/running
chmod 700 "$DIR/secrets"
: > "$DIR/erg.log"; : > "$DIR/ro/ro.log"; : > "$DIR/ergs.jsonl"

[ -f "$DIR/host.conf" ] || cp "$DIR/host.conf.example" "$DIR/host.conf"

if [ ! -s "$DIR/web/key.txt" ]; then
  (openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n') > "$DIR/web/key.txt"
fi
KEY=$(cat "$DIR/web/key.txt")

cat > "$DIR/short-term/status.md" <<EOF
Erg 0: born from hearth — $NAME exists, nothing done yet; first ergs should read mind/, learn the domain from input/, and start long-term/.
EOF
cat > "$DIR/short-term/threads.md" <<EOF
THREAD REGISTRY (protocol: mind/20-threads.md) — empty; add one section per strand of work that outlives a single erg.
EOF

cat <<EOF

🔥 $NAME is born in $DIR

next steps (do these by hand — birth.sh starts nothing):
  1. web server:  screen -dmS $NAME-web node $DIR/web/server.js
     watch-page:  https://$HOST:$PORT/#k=$KEY     (that key is a SECRET)
     @reboot cron:  @reboot screen -dmS $NAME-web node $DIR/web/server.js  # $NAME-web
  2. edit host.conf (just created from host.conf.example): claude CLI path,
     the env file holding CLAUDE_CODE_OAUTH_TOKEN[_2], TLS cert+key.
     No TLS configured => the watch-page serves plain HTTP.
  4. brief her: drop a file in input/ saying who she works for and what for,
     then fire the first erg:  node erg.js
  5. read mind/00-core.md — the purpose line now says: $PURPOSE
EOF
