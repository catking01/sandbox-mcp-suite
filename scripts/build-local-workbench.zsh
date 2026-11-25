#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo "The native Sandbox Monitor app requires macOS. On Linux use: node runtime/desktop-commander/local-workbench-server.mjs --open" >&2
  exit 1
fi
project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
monitor_app="$project_root/Sandbox Workbench.app"
mkdir -p "$monitor_app/Contents/MacOS"
cat > "$monitor_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Sandbox Monitor</string>
  <key>CFBundleExecutable</key><string>Sandbox Workbench</string>
  <key>CFBundleIdentifier</key><string>org.sandbox-mcp.monitor</string>
  <key>CFBundleName</key><string>Sandbox Monitor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
/usr/bin/clang -fobjc-arc -Wall "$project_root/app-src/SandboxWorkbench.m" -o "$monitor_app/Contents/MacOS/Sandbox Workbench" -framework Cocoa -framework WebKit
/usr/bin/codesign --force --sign - --timestamp=none "$monitor_app"
echo "BUILT: $monitor_app"
