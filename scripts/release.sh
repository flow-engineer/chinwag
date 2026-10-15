#!/usr/bin/env bash
# Publishes chinwag to npm from a clean, tagged commit whose tests pass.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "release: the working tree is not clean." >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
if ! git tag --points-at HEAD | grep -qx "v$version"; then
  echo "release: this commit is not tagged v$version." >&2
  exit 1
fi

npm test
npm test --prefix simulators

npm publish --access public
