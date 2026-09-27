#!/usr/bin/env sh
# Drop the governance framework into a repo:  ./install.sh /path/to/repo [--mode advisory]
set -eu
command -v node >/dev/null 2>&1 || { echo "install: Node.js >= 18 is required" >&2; exit 1; }
exec node "$(dirname "$0")/scripts/install.js" "$@"
