#!/usr/bin/env bash
# Initialise git (if needed), commit, create a GitHub repository and push.
#
#   npm run publish:github                 # private repo named after this folder
#   npm run publish:github -- my-repo      # custom name
#   npm run publish:github -- my-repo --public
#
# Requires the GitHub CLI, signed in:  gh auth login
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_NAME="${1:-$(basename "$PWD")}"
VISIBILITY="--private"
[[ "${2:-}" == "--public" ]] && VISIBILITY="--public"

command -v gh >/dev/null || { echo "GitHub CLI not found. Install it: https://cli.github.com (macOS: brew install gh)"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in to GitHub. Run: gh auth login"; exit 1; }

if [[ ! -d .git ]]; then
  git init -b main
fi

# Refuse to publish secrets or the local database.
for path in .env prisma/dev.db; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "Refusing to push: $path is tracked by git. Remove it from the index first."; exit 1
  fi
done

git add -A
if ! git diff --cached --quiet; then
  git commit -m "${COMMIT_MESSAGE:-Update UW Hiring Radar}"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin HEAD
else
  gh repo create "$REPO_NAME" "$VISIBILITY" --source=. --remote=origin --push \
    --description "Live feed of UWaterloo club and design team applications, with a Bento application tracker."
fi

gh repo view --json url --jq .url
