#!/bin/sh
# Construit « Relais Distant Agent.app » (agent macOS, barre des menus) dans dist/.
set -eu
cd "$(dirname "$0")/.."
cargo build --release -p relais-host
APP="dist/Relais Distant Agent.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp target/release/relais-distant "$APP/Contents/MacOS/relais-distant"
mkdir -p "$APP/Contents/Resources"
cp app/src-tauri/icons/icon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Relais Distant Agent</string>
  <key>CFBundleDisplayName</key><string>Relais Distant Agent</string>
  <key>CFBundleIdentifier</key><string>com.relaisdistant.host</string>
  <key>CFBundleExecutable</key><string>relais-distant</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Signature stable : avec un vrai certificat, macOS garde les autorisations (enregistrement de
# l'écran, accessibilité) d'une version à l'autre. Sans certificat, signature ad hoc.
SIGN_ID="${SIGN_ID:-$(security find-identity -p codesigning -v | grep -m1 -E 'Developer ID Application|Apple Development' | sed -E 's/.*"(.*)"/\1/')}"
codesign --force --deep --options runtime --sign "${SIGN_ID:--}" "$APP"
echo "Signé avec : ${SIGN_ID:-ad hoc}"
# Installation à un emplacement fixe (les autorisations macOS sont liées à l'app installée).
if [ "${INSTALL:-1}" = 1 ] && [ -w /Applications ]; then
  pkill -f "Relais Distant Agent.app/Contents/MacOS" 2>/dev/null || true
  rm -rf "/Applications/Relais Distant Agent.app"
  mv "$APP" /Applications/
  APP="/Applications/Relais Distant Agent.app"
  echo "Installé dans /Applications"
fi
echo "OK : $APP ($(du -sh "$APP" | cut -f1))"
