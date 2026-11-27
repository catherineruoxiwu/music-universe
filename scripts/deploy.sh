#!/usr/bin/env bash
# Builds the site and publishes it to the gh-pages branch, which GitHub Pages serves.
# The branch holds one commit, replaced on every deploy; the source lives on main.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
# Tells GitHub Pages to serve the files as they are, without running them through Jekyll.
touch dist/.nojekyll

# A commit made straight from dist/, without touching the working tree or the real index.
index="$(mktemp -u)"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git --work-tree=dist add --all --force .
tree="$(GIT_INDEX_FILE="$index" git write-tree)"
commit="$(git commit-tree "$tree" -m "Deploy $(git rev-parse --short HEAD)")"

git push --force origin "$commit:refs/heads/gh-pages"
echo "Deployed $(git rev-parse --short HEAD) to gh-pages."
