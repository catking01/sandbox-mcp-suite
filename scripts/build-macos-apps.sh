#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo 'The native apps require macOS and Xcode Command Line Tools.' >&2
  exit 1
fi
product_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
console_app="$product_root/Sandbox MCP.app"
mkdir -p "$console_app/Contents/MacOS"
cat > "$console_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Sandbox MCP</string>
<key>CFBundleIdentifier</key><string>org.sandbox-mcp.console</string>
<key>CFBundleName</key><string>Sandbox MCP</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/bin/xcrun swiftc "$product_root/app-src/SandboxMCPLauncher.swift" -o "$console_app/Contents/MacOS/Sandbox MCP" -framework AppKit
/usr/bin/codesign --force --sign - --timestamp=none "$console_app"
sh "$product_root/scripts/build-local-workbench.zsh"
echo "BUILT: $console_app"
