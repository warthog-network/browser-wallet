#!/bin/sh
# Pack the Windows IPv4 forwarder. The AppImage does not run on Windows.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/dist"}
CC=${MINGW_CC:-x86_64-w64-mingw32-gcc}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/Warthog_IPv4_forwarder-windows/scripts" "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd)
"$CC" -O2 -s -municode -mwindows -o "$STAGE/Warthog_IPv4_forwarder-windows/Warthog_IPv4_forwarder.exe" "$ROOT/scripts/safetrade-winhost.c"
cp "$ROOT/scripts/safetrade-native-host.py" "$ROOT/scripts/install-safetrade-host.py" "$STAGE/Warthog_IPv4_forwarder-windows/scripts/"

python3 - "$STAGE/Warthog_IPv4_forwarder-windows/Install-SafeTrade-Forwarder.bat" << 'PY'
import pathlib, sys
text = """@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1 && (
  py -3 scripts\\install-safetrade-host.py %*
  goto done
)
python scripts\\install-safetrade-host.py %*
:done
echo.
pause
"""
pathlib.Path(sys.argv[1]).write_bytes(text.replace("\n", "\r\n").encode("ascii"))
PY

cat > "$STAGE/Warthog_IPv4_forwarder-windows/README.txt" << 'EOF'
Warthog IPv4 forwarder for Windows

The AppImage file Warthog_IPv4_forwarder-x86_64.AppImage is Linux-only.
It does not run on Windows.

1. Load the Warthog extension in Chrome, Brave, or Edge.
2. Unzip this folder and keep the programs and scripts together.
3. Install Python 3 from https://www.python.org/downloads/ and allow it onto PATH.
4. Double-click Install-SafeTrade-Forwarder.bat.
5. Reload the extension.
6. Open SafeTrade in the wallet and press Check.

Windows 10 and later include curl.exe, and it has to be on PATH.
Run the installer again if you move this folder or reinstall the extension.

To select one browser:
  Install-SafeTrade-Forwarder.bat --browser chrome --extension-id <32 letter id>
EOF

rm -f "$OUT/Warthog_IPv4_forwarder-windows.zip"
(
  cd "$STAGE"
  zip -r -X "$OUT/Warthog_IPv4_forwarder-windows.zip" Warthog_IPv4_forwarder-windows
)
echo "$OUT/Warthog_IPv4_forwarder-windows.zip"
