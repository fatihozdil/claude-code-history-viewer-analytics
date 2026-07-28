#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Installing npm dependencies"
npm install

echo "==> Packaging extension"
npx vsce package --allow-missing-repository

VSIX_FILE=$(ls -t ./*.vsix | head -n1)
echo "==> Installing $VSIX_FILE into VS Code"
code --install-extension "$VSIX_FILE" --force

echo "==> Done. Reload VS Code to pick up the update."
