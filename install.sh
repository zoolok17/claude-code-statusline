#!/usr/bin/env bash
# macOS/Linux convenience wrapper. Runs the cross-platform Node installer.
# Usage:  ./install.sh
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$DIR/install.js"
