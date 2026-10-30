#!/bin/sh
# Pack the IPv4 forwarder window into a small AppImage.
# The result uses the computer's Python, GTK 3, and curl.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/dist"}
APPDIR=$(mktemp -d)
trap 'rm -rf "$APPDIR"' EXIT

mkdir -p "$APPDIR/scripts" "$APPDIR/public" "$OUT"
cp "$ROOT/scripts/safetrade-forwarder-gui.py" "$APPDIR/scripts/safetrade-forwarder-gui.py"
cp "$ROOT/public/logo.png" "$ROOT/public/logo-128.png" "$APPDIR/public/"
cp "$ROOT/public/logo-128.png" "$APPDIR/warthog-ipv4-forwarder.png"

cat > "$APPDIR/warthog-ipv4-forwarder.desktop" << 'EOF'
[Desktop Entry]
Type=Application
Name=Warthog IPv4 forwarder
Comment=SafeTrade calls over this computer's IPv4 address
Exec=warthog-ipv4-forwarder
Icon=warthog-ipv4-forwarder
StartupWMClass=warthog-ipv4-forwarder
Categories=Network;
Terminal=false
EOF

cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/sh
HERE=$(dirname "$(readlink -f "$0")")
exec python3 "$HERE/scripts/safetrade-forwarder-gui.py"
EOF
chmod +x "$APPDIR/AppRun"
# mktemp is private to this user. Current appimagetool rejects that.
chmod -R a+rX "$APPDIR"

TOOL=${APPIMAGETOOL:-/tmp/appimagetool-x86_64.AppImage}
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi

IMAGE="$OUT/Warthog_IPv4_forwarder-x86_64.AppImage"
# VERSION in the environment would change the file name. The release looks for this one.
env -u VERSION ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$IMAGE"
echo "$IMAGE"
