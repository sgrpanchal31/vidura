#!/usr/bin/env bash
# Assembles and ad-hoc-signs a macOS .app, then wraps it in a DMG.
# Used by both local `npm run dist:mac` and the GitHub Actions release workflow.
#
# Prerequisites: run `npm run build` before calling this script.
# The script prunes + trims node_modules in-place; the caller is responsible
# for restoring devDeps afterwards if needed (local: append `npm install`).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_DIR/dist"
APP="$DIST/Vidura.app"

# Safety: dev-mode builds inline the local Langfuse keys from .env.local into
# out/main/index.js. Never ship one — require a fresh production build.
if grep -qE 'pk-lf|new Langfuse' "$REPO_DIR/out/main/index.js" 2>/dev/null; then
  echo "✗ out/ contains a dev build (telemetry keys detected) — run 'npm run build' first" >&2
  exit 1
fi

echo "▶ Cleaning previous build artifacts"
rm -rf "$DIST"
mkdir -p "$DIST"

# ── 1. Copy Electron.app from the devDep (already downloaded by npm install) ──
# This avoids the CI curl download and ensures the version matches package.json.
ELECTRON_APP="$REPO_DIR/node_modules/electron/dist/Electron.app"
if [ ! -d "$ELECTRON_APP" ]; then
  echo "✗ Electron.app not found at $ELECTRON_APP — run npm install first" >&2
  exit 1
fi
echo "▶ Copying Electron.app"
cp -r "$ELECTRON_APP" "$APP"

# Strip any quarantine/extended-attributes that would break signing
xattr -cr "$APP"

# Replace Electron's default icon with the Vidura icon. Must happen before
# signing: codesign seals the bundle contents, so changing the icon afterwards
# would invalidate the signature.
echo "▶ Installing app icon"
cp "$REPO_DIR/resources/icon.icns" "$APP/Contents/Resources/vidura.icns"
rm -f "$APP/Contents/Resources/electron.icns"

# ── 2. Prune devDependencies before bundling ──
echo "▶ Pruning devDependencies"
cd "$REPO_DIR"
npm prune --omit=dev

# ── 3. Trim platform-specific dead weight from production deps ──
echo "▶ Trimming non-Mac onnxruntime binaries (linux + win32 = ~176 MB)"
rm -rf "$REPO_DIR/node_modules/onnxruntime-node/bin/napi-v6/linux"
rm -rf "$REPO_DIR/node_modules/onnxruntime-node/bin/napi-v6/win32"

echo "▶ Removing onnxruntime-web (~130 MB, WASM-only browser runtime)"
# transformers.node.cjs bundles onnxruntime-web code inline — the package itself
# is never require()-d at runtime in Node.js/Electron context.
rm -rf "$REPO_DIR/node_modules/onnxruntime-web"

echo "▶ Removing typescript (~23 MB, dev tooling)"
# typescript survives npm prune due to peer-dep chain from typescript-eslint,
# but it is never imported at runtime.
rm -rf "$REPO_DIR/node_modules/typescript"

# @napi-rs/canvas must ship: pdfjs-dist v5 needs it for its DOMMatrix polyfill
# in Node, and pdf.mjs constructs a DOMMatrix at module load — without the
# package, importing pdfjs throws "DOMMatrix is not defined" and PDF ingest
# fails entirely in the packaged app.

echo "▶ Removing unused pdfjs-dist builds (app uses legacy/ only)"
# The main process imports pdfjs-dist/legacy/build/pdf.mjs — legacy/ must stay.
rm -rf "$REPO_DIR/node_modules/pdfjs-dist/build"
rm -rf "$REPO_DIR/node_modules/pdfjs-dist/web"
rm -rf "$REPO_DIR/node_modules/pdfjs-dist/types"

echo "▶ Removing unused tree-sitter grammars (keeping 10 used by GRAMMAR_MAP)"
# Keep only what ingest/code.ts actually loads; delete the other 26.
KEEP_GRAMMARS="typescript tsx javascript python go rust java c cpp ruby"
GRAMMAR_DIR="$REPO_DIR/node_modules/tree-sitter-wasms/out"
for wasm in "$GRAMMAR_DIR"/tree-sitter-*.wasm; do
  name="$(basename "$wasm" .wasm | sed 's/tree-sitter-//')"
  keep=false
  for g in $KEEP_GRAMMARS; do
    [ "$name" = "$g" ] && keep=true && break
  done
  "$keep" || rm -f "$wasm"
done

echo "▶ Normalizing llama.cpp file permissions"
# llama.cpp's .git MUST ship: node-llama-cpp refuses to use its locally compiled
# build without it and silently falls back to the stock binary, which cannot
# load the Gemma 4 models (this broke the v0.2.2 release). Its read-only pack
# files are made writable so recursive xattr/copy operations never fail.
chmod -R u+w "$REPO_DIR/node_modules/node-llama-cpp/llama" 2>/dev/null || true

# Clean up broken .bin/ symlinks left by deleted packages (e.g., tsc, tsserver).
# cp -r dereferences symlinks on macOS, so broken ones produce errors and abort.
for link in "$REPO_DIR/node_modules/.bin"/*; do
  [ -L "$link" ] && [ ! -e "$link" ] && rm -f "$link"
done

# ── 4. Assemble app payload ──
echo "▶ Assembling app bundle"
APP_RES="$APP/Contents/Resources/app"
mkdir -p "$APP_RES"
cp "$REPO_DIR/package.json" "$APP_RES/"
cp -r "$REPO_DIR/out"         "$APP_RES/"
cp -r "$REPO_DIR/node_modules" "$APP_RES/"

# ── 5. Rename executable and patch Info.plist ──
echo "▶ Patching Info.plist and renaming executable"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Vidura"          "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.vidura.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable vidura"    "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile vidura.icns" "$PLIST"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/vidura"

# ── 6. Ad-hoc code-sign (inside-out: native binaries first, then the bundle) ──
# --deep does not descend into Contents/Resources/app/node_modules, so we sign
# every .node/.dylib/.so there explicitly before sealing the outer bundle.
echo "▶ Signing native binaries in app/node_modules"
find "$APP/Contents/Resources/app/node_modules" \
  \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) \
  -exec codesign --force --sign - {} \;

# --deep fails on Electron's framework structure, so sign inner components first.
echo "▶ Signing Electron Helper apps"
for helper in "$APP/Contents/Frameworks/"*.app; do
  codesign --force --sign - "$helper"
done

echo "▶ Signing Electron Framework binary"
# Sign the inner executable only — signing the .framework bundle directory itself
# produces "bundle format is ambiguous" and a non-zero exit on macOS 14+.
codesign --force --sign - \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"

echo "▶ Signing main app bundle"
codesign --force --sign - "$APP"

echo "▶ Verifying signature (informational)"
# codesign --verify always traverses the full bundle and exits non-zero on
# Electron Framework's "ambiguous" structure — that's a tooling quirk, not a
# launch failure. We check the main executable's signing status directly instead.
codesign -dv "$APP/Contents/MacOS/vidura" 2>&1 | grep -E 'Signature|CodeDirectory|Authority' | head -3 || true

# ── 7. Create DMG ──
echo "▶ Creating DMG"
hdiutil create \
  -volname "Vidura" \
  -srcfolder "$APP" \
  -ov -format UDZO \
  "$DIST/vidura-arm64.dmg"

echo ""
echo "✔ Done: $DIST/vidura-arm64.dmg ($(du -sh "$DIST/vidura-arm64.dmg" | cut -f1))"
