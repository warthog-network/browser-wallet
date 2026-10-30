#!/usr/bin/env python3
"""Register the SafeTrade IPv4 host with the browsers on this machine.

Linux derives the unpacked Chromium id from the build path. The id is the
first 16 bytes of SHA-256 of that absolute path, with each hex nibble mapped
onto a-p. Firefox uses the gecko id from the extension manifest.

Windows reads the loaded WARTHOG NETWORK extension from the browser profile,
or accepts --extension-id. The AppImage package is Linux-only.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

HOST_NAME = "com.warthog.safetrade"
APP_ID = "warthog-ipv4-forwarder"
GECKO_ID = "contact@warthog.network"
WALLET_NAME = "WARTHOG NETWORK"
ROOT = Path(__file__).resolve().parent.parent
BUILD = Path(os.environ.get("WARTHOG_EXTENSION_BUILD", ROOT / "build")).resolve()
SCRIPT_DIR = Path(__file__).resolve().parent
HOST = SCRIPT_DIR / "safetrade-native-host.py"
GUI = SCRIPT_DIR / "safetrade-forwarder-gui.py"
ICON = SCRIPT_DIR.parent / "public" / "logo-128.png"
WINDOWS_HOST_EXE = "Warthog_IPv4_forwarder.exe"
WINDOWS_BROWSERS = {
    "chrome": ("Google/Chrome/User Data", r"Software\Google\Chrome"),
    "brave": ("BraveSoftware/Brave-Browser/User Data", r"Software\BraveSoftware\Brave-Browser"),
    "edge": ("Microsoft/Edge/User Data", r"Software\Microsoft\Edge"),
    "chromium": ("Chromium/User Data", r"Software\Chromium"),
}


def extension_id(path):
    digest = hashlib.sha256(str(path).encode()).digest()[:16]
    return "".join(chr(ord("a") + nibble) for byte in digest for nibble in (byte >> 4, byte & 0xF))


def write_json(directory, payload):
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{HOST_NAME}.json"
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.chmod(target, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
    print(target)
    return target


def install_launcher():
    """Write the app-menu entry. The Icon path is the logo shipped in public/."""
    if not GUI.is_file() or not ICON.is_file():
        print("launcher skipped: gui or logo-128.png is missing")
        return
    desktop = Path.home() / ".local/share/applications" / f"{APP_ID}.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    desktop.write_text(
        "\n".join([
            "[Desktop Entry]",
            "Version=1.0",
            "Type=Application",
            "Name=Warthog IPv4 forwarder",
            "Comment=SafeTrade calls over this computer's IPv4 address",
            f"Exec={sys.executable} {GUI}",
            f"Icon={ICON}",
            f"StartupWMClass={APP_ID}",
            "Terminal=false",
            "Categories=Network;",
            "StartupNotify=true",
            "",
        ]),
        encoding="utf-8",
    )
    os.chmod(desktop, stat.S_IRWXU | stat.S_IRGRP | stat.S_IROTH)
    print(desktop)


def manifest_is_wallet(extension_path):
    try:
        data = json.loads((Path(extension_path) / "manifest.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("name") == WALLET_NAME


def wallet_dirs(profile, identity, path_value):
    candidates = []
    if isinstance(path_value, str) and path_value:
        raw = Path(path_value)
        candidates.append(raw if raw.is_absolute() else profile / path_value)
    ext_root = profile / "Extensions" / identity
    if ext_root.is_dir():
        candidates.extend(path for path in ext_root.iterdir() if path.is_dir())
    found = []
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved not in found:
            found.append(resolved)
    return found


def discover_windows_extensions(build, local_appdata, browser=None):
    """Match the build path or a loaded extension named WARTHOG NETWORK."""
    found = set()
    wanted = os.path.normcase(str(build.resolve()))
    for name, (profile_path, _) in WINDOWS_BROWSERS.items():
        if browser and browser != name:
            continue
        directory = local_appdata / profile_path
        if not directory.is_dir():
            continue
        for profile in directory.iterdir():
            if not profile.is_dir():
                continue
            if profile.name != "Default" and not profile.name.startswith("Profile "):
                continue
            for filename in ("Preferences", "Secure Preferences"):
                try:
                    data = json.loads((profile / filename).read_text(encoding="utf-8-sig"))
                except (OSError, ValueError):
                    continue
                extensions = data.get("extensions") if isinstance(data, dict) else None
                settings = extensions.get("settings") if isinstance(extensions, dict) else None
                if not isinstance(settings, dict):
                    continue
                for identity, record in settings.items():
                    if not isinstance(record, dict) or not re.fullmatch(r"[a-p]{32}", identity):
                        continue
                    for resolved in wallet_dirs(profile, identity, record.get("path")):
                        same_build = os.path.normcase(str(resolved)) == wanted
                        if same_build or manifest_is_wallet(resolved):
                            found.add((name, identity))
    return sorted(found)


def windows_launcher(python, host):
    paths = [str(python.resolve()), str(host.resolve())]
    if any(any(char in path for char in '\r\n"') for path in paths):
        raise ValueError("Invalid Python or native host path")
    python_path, host_path = (path.replace("%", "%%") for path in paths)
    return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"{0}" -u "{1}"\r\n'.format(python_path, host_path)


def register_windows(browser, manifest):
    import winreg

    key_path = "{}\\NativeMessagingHosts\\{}".format(WINDOWS_BROWSERS[browser][1], HOST_NAME)
    for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_WRITE | view) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest.resolve()))
    print("Registered HKCU\\{}".format(key_path))


def windows_host_target():
    """Chrome starts the packaged exe. A source checkout uses Python through a bat file."""
    if getattr(sys, "frozen", False):
        packaged = Path(sys.executable).resolve().parent / WINDOWS_HOST_EXE
    else:
        packaged = ROOT / WINDOWS_HOST_EXE
    if packaged.is_file():
        return packaged, None
    if not HOST.is_file():
        raise ValueError("The native host script is missing: {}".format(HOST))
    return None, HOST


def install_windows(args):
    build = args.build_dir.resolve()
    if args.extension_id:
        matches = [(args.browser or "chrome", args.extension_id)]
    else:
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise ValueError("LOCALAPPDATA is not set.")
        matches = discover_windows_extensions(build, Path(local), args.browser)
    if not matches:
        raise ValueError(
            "Load the Warthog extension in Chrome, Brave, or Edge first, "
            "or pass --browser and --extension-id from the browser's extensions page."
        )
    if not shutil.which("curl.exe") and not shutil.which("curl"):
        raise ValueError("curl.exe was not found. Windows 10 and later include it. Install curl, then run this installer again.")
    host_exe, host_script = windows_host_target()
    for browser, identity in matches:
        print("{}: chrome-extension://{}/".format(browser, identity))
    if args.dry_run:
        print("host: {}".format(host_exe or host_script))
        return
    if host_exe is not None:
        manifest_path = str(host_exe)
        directory = host_exe.parent
    else:
        directory = ROOT / ".native-host"
        directory.mkdir(exist_ok=True)
        launcher = directory / "safetrade-native-host.bat"
        launcher.write_bytes(windows_launcher(Path(sys.executable), host_script).encode("utf-8"))
        manifest_path = str(launcher)
    manifest = write_json(directory, {
        "name": HOST_NAME,
        "description": "Forward SafeTrade calls over IPv4",
        "path": manifest_path,
        "type": "stdio",
        "allowed_origins": sorted(set("chrome-extension://{}/".format(identity) for _, identity in matches)),
    })
    for browser in sorted(set(name for name, _ in matches)):
        register_windows(browser, manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=sorted(WINDOWS_BROWSERS), help="Windows browser. The default finds every loaded Warthog extension.")
    parser.add_argument("--extension-id", help="Exact id from the browser's extensions page")
    parser.add_argument("--build-dir", type=Path, default=BUILD)
    parser.add_argument("--dry-run", action="store_true", help="Show what would be registered")
    args = parser.parse_args()
    if args.extension_id and not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("--extension-id must be exactly 32 letters a-p")
    if sys.platform == "win32":
        try:
            install_windows(args)
        except (OSError, ValueError) as error:
            print(error, file=sys.stderr)
            raise SystemExit(1)
        return
    if args.browser:
        parser.error("--browser is only used on Windows")
    if sys.platform != "linux":
        parser.exit(1, "This installer supports Windows and Linux. The AppImage is Linux-only.\n")
    origin = "chrome-extension://{}/".format(args.extension_id or extension_id(args.build_dir.resolve()))
    if args.dry_run:
        print("Linux host: {}".format(HOST))
        print(origin)
        return
    os.chmod(HOST, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    chromium = {
        "name": HOST_NAME,
        "description": "Forward SafeTrade calls over IPv4",
        "path": str(HOST),
        "type": "stdio",
        "allowed_origins": [origin],
    }
    firefox = {
        "name": HOST_NAME,
        "description": "Forward SafeTrade calls over IPv4",
        "path": str(HOST),
        "type": "stdio",
        "allowed_extensions": [GECKO_ID],
    }
    home = Path.home()
    browsers = [
        home / ".config/BraveSoftware/Brave-Browser-Beta",
        home / ".config/BraveSoftware/Brave-Browser",
        home / ".config/google-chrome",
        home / ".config/chromium",
    ]
    for browser in browsers:
        if browser.is_dir():
            write_json(browser / "NativeMessagingHosts", chromium)
    mozilla = home / ".mozilla"
    if mozilla.is_dir():
        write_json(mozilla / "native-messaging-hosts", firefox)
    snap = home / "snap/firefox/common"
    if snap.is_dir():
        write_json(snap / ".mozilla/native-messaging-hosts", firefox)
    install_launcher()
    print(origin)


if __name__ == "__main__":
    main()
