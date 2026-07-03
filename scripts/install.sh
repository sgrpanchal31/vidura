#!/usr/bin/env bash
# One-step installer for Vidura on macOS (Apple Silicon).
# Downloads the latest release DMG, installs to /Applications, and removes
# the quarantine flag that causes the "damaged" error on unsigned apps.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sgrpanchal31/vidura/main/scripts/install.sh | bash
set -euo pipefail

DMG_URL="https://github.com/sgrpanchal31/vidura/releases/latest/download/vidura-arm64.dmg"
APP_NAME="Vidura.app"
INSTALL_DIR="/Applications"

# -- Preflight checks ---------------------------------------------------------

if [ "$(uname)" != "Darwin" ]; then
  echo "Error: This installer only works on macOS." >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "Error: This release is built for Apple Silicon (arm64) only." >&2
  echo "  Intel Mac support is not available yet." >&2
  exit 1
fi

# -- Download -----------------------------------------------------------------

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
DMG="$TMP/vidura.dmg"

# Clean up temp dir and unmount on exit (success or failure).
cleanup() {
  hdiutil detach "$MNT" -quiet 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Downloading Vidura..."
curl -fL --progress-bar -o "$DMG" "$DMG_URL"

# -- Mount --------------------------------------------------------------------

echo "Mounting DMG..."
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" -quiet

# -- Install ------------------------------------------------------------------

echo "Copying to ${INSTALL_DIR}..."
# Remove any previous install so reruns work as an upgrade
# (including installs from before the app was renamed to Vidura).
rm -rf "${INSTALL_DIR}/${APP_NAME}"
rm -rf "${INSTALL_DIR}/openbook-lm.app"
# ditto preserves code signatures; plain cp -r can strip them.
ditto "$MNT/$APP_NAME" "${INSTALL_DIR}/${APP_NAME}"

# -- Remove quarantine flag ---------------------------------------------------
# macOS tags every downloaded file with com.apple.quarantine, which causes
# Gatekeeper to reject ad-hoc-signed apps as "damaged". Removing the flag
# skips Gatekeeper evaluation entirely -- the app runs without any warning.
echo "Removing quarantine flag..."
xattr -cr "${INSTALL_DIR}/${APP_NAME}"

# -- Done ---------------------------------------------------------------------

echo ""
echo "Done: Vidura installed to ${INSTALL_DIR}/${APP_NAME}"
echo "Launching..."
open "${INSTALL_DIR}/${APP_NAME}"
