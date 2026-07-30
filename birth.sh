#!/usr/bin/env bash
# birth.sh — light a new agent from the hearth.
#
#   git clone git@github.com:dglittle/hearth.git ~/newagent
#   cd ~/newagent && ./birth.sh <name> <port> "<purpose>" [host]
#
# Substitutes the template placeholders IN PLACE in this checkout, creates the
# living-state dirs, creates db/cards.db and seeds the generic mind CARDS from
# seed/mind/, and generates web/key.txt. After this, the directory IS the
# agent: `node erg.js --card N` performs one erg on card N.
#
# Placeholders: {{AGENT_NAME}} {{AGENT_DIR}} {{PORT}} {{HOST}} {{PURPOSE}}
# Needs node >= 22 on PATH (node:sqlite).
set -euo pipefail

NAME="${1:-}"; PORT="${2:-}"; PURPOSE="${3:-}"; HOST="${4:-localhost}"
if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$PURPOSE" ]; then
  echo "usage: ./birth.sh <name> <port> \"<purpose>\" [host]" >&2
  echo "  e.g. ./birth.sh athena 8443 \"the operator's work on the atlas project\"" >&2
  exit 2
fi
# the name becomes a card KIND, a CSS class and localStorage key prefixes —
# keep it a plain lowercase identifier
if ! printf '%s' "$NAME" | grep -qE '^[a-z][a-z0-9]*$'; then
  echo "refusing: name must match [a-z][a-z0-9]* (it's used as a card kind and JS identifier)" >&2
  exit 2
fi
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! grep -rq '{{AGENT_NAME}}' "$DIR/seed" 2>/dev/null; then
  echo "refusing: $DIR looks already born (no placeholders left in seed/)" >&2
  exit 1
fi
command -v node >/dev/null || { echo "refusing: node not on PATH (need >= 22 for node:sqlite)" >&2; exit 1; }

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

mkdir -p "$DIR"/{ergs,work,secrets}
chmod 700 "$DIR/secrets"
: > "$DIR/erg.log"; : > "$DIR/ergs.jsonl"

[ -f "$DIR/host.conf" ] || cp "$DIR/host.conf.example" "$DIR/host.conf"

if [ ! -s "$DIR/web/key.txt" ]; then
  (openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n') > "$DIR/web/key.txt"
fi
KEY=$(cat "$DIR/web/key.txt")

# ---- card db: create, then seed the mind cards (post-substitution, so the
# seed files already carry the real name/purpose). First line of each seed
# file = "# <title>", rest = body. x places them in prompt order.
# CARDS_DB pinned explicitly: an inherited CARDS_DB (e.g. birth run from
# inside another agent's erg) would otherwise seed THAT agent's live board.
export CARDS_DB="$DIR/db/cards.db"
unset ERG_ID
node "$DIR/tools/card.js" init
i=0
for f in "$DIR"/seed/mind/*.md; do
  title=$(head -1 "$f" | sed 's/^# *//')
  tail -n +2 "$f" | sed '1{/^$/d}' | \
    node "$DIR/tools/card.js" create --kind mind --title "$title" --body - \
      --by operator --x $((i * 260)) --y -1080
  i=$((i + 1))
done

# the operator's first move, pre-staged as a human card
node "$DIR/tools/card.js" create --kind human \
  --title "brief $NAME: who does she work for, and on what?" \
  --body "Edit this card with the domain briefing (who the operator is, what systems exist, what to do first), then fire an erg on it." \
  --by operator

cat <<EOF

🔥 $NAME is born in $DIR

next steps (do these by hand — birth.sh starts nothing):
  1. web server:  screen -dmS $NAME-web node $DIR/web/server.js
     board:       https://$HOST:$PORT/#k=$KEY     (that key is a SECRET)
     @reboot cron:  @reboot screen -dmS $NAME-web node $DIR/web/server.js  # $NAME-web
  2. edit host.conf (just created from host.conf.example): claude CLI path,
     the env file holding CLAUDE_CODE_OAUTH_TOKEN[_2], TLS cert+key.
     No TLS configured => the board serves plain HTTP.
  3. brief her: open the board, edit the "brief $NAME" card with the domain
     briefing, and fire the first erg on it (▶ on the board, or
     node $DIR/erg.js --card <id>).
     Her purpose line already says: $PURPOSE
EOF
