#!/bin/zsh
# =====================================================================
# Build the Foundry module release files into dist/.
#
#   ./bin/build-module.sh     # dist/module.json + dist/module.zip
#
# Upload both to a GitHub release (gh release create vX.Y.Z dist/*); Foundry
# installs from the manifest URL in module.json (releases/latest/download/…).
# =====================================================================
set -eu
case "${1:-}" in --help|-h) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
ROOT="${0:A:h:h}"
cd "$ROOT/module"
rm -rf "$ROOT/dist" && mkdir -p "$ROOT/dist"
cp module.json "$ROOT/dist/module.json"
zip -qr "$ROOT/dist/module.zip" module.json scripts
print "dist/module.json, dist/module.zip  (version $(jq -r .version module.json))"
