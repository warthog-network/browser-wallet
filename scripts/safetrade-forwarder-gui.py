#!/usr/bin/env python3
"""Window for the SafeTrade IPv4 forwarder.

Brave starts safetrade-native-host.py with no window, one message at a time.
This program is that host's window. It shows the program path and the
allowlist, and it can add the extension Brave has loaded.
"""

import hashlib
import json
import os
import stat
import subprocess
import threading
from pathlib import Path

import gi

gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "public" / "logo.png"
WINDOW_ICON = ROOT / "public" / "logo-128.png"
APP_ID = "warthog-ipv4-forwarder"
GOLD = "#bba36a"
MUTED = "#8d887f"
INK = "#e6e1d6"

CSS = b"""
window.wart {
  background-color: #000000;
  color: #f4f4f5;
}
.wart-frame {
  background-color: #000000;
  border: 1px solid #8f7848;
  border-radius: 12px;
}
.wart-drag {
  background-color: transparent;
}
.wart-card, .wart-route {
  background-color: #141414;
  border-radius: 12px;
  padding: 8px 12px;
}
.wart-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.wart-route {
  border: 1px solid rgba(187, 163, 106, 0.45);
}
.pill-ok, .pill-bad {
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
}
.pill-ok {
  background-color: #bba36a;
  color: #1a160e;
}
.pill-bad {
  background-color: #a56a6a;
  color: #1a1212;
}
button.wart-primary,
button.wart-ghost,
button.wart-remove {
  min-height: 0;
  min-width: 0;
  padding: 0 7px;
  font-size: 11px;
  border-radius: 6px;
}
button.wart-primary {
  background-image: none;
  background-color: #bba36a;
  color: #1a160e;
  border: none;
  font-weight: 600;
}
button.wart-primary:hover {
  background-color: #c9b27a;
}
button.wart-primary:disabled {
  background-color: #3a3428;
  color: #8a7d62;
}
button.wart-ghost {
  background-image: none;
  background-color: transparent;
  color: #bba36a;
  border: 1px solid rgba(187, 163, 106, 0.45);
}
button.wart-ghost:hover {
  background-color: rgba(187, 163, 106, 0.12);
}
button.wart-remove {
  background-image: none;
  background-color: transparent;
  color: #a56a6a;
  border: 1px solid rgba(165, 106, 106, 0.55);
}
button.wart-remove:hover {
  background-color: rgba(165, 106, 106, 0.14);
}
"""

HOST_NAME = "com.warthog.safetrade"
HOST_PATH = Path(__file__).resolve().parent / "safetrade-native-host.py"
HOME = Path.home()
CHROMIUM = (
    ("Brave Beta", HOME / ".config/BraveSoftware/Brave-Browser-Beta"),
    ("Brave", HOME / ".config/BraveSoftware/Brave-Browser"),
    ("Chrome", HOME / ".config/google-chrome"),
    ("Chromium", HOME / ".config/chromium"),
)
FIREFOX = (
    ("Firefox", HOME / ".mozilla/native-messaging-hosts"),
    ("Firefox snap", HOME / "snap/firefox/common/.mozilla/native-messaging-hosts"),
)
BUILDS = (
    Path("/home/whitefang/webdev/browser-wallet/build"),
    Path("/home/whitefang/webdev/warthog/browser-wallet/build"),
)


def extension_id(path: Path) -> str:
    digest = hashlib.sha256(str(path).encode()).digest()[:16]
    return "".join(chr(ord("a") + nibble) for byte in digest for nibble in (byte >> 4, byte & 0xF))


def known_builds() -> dict[str, Path]:
    found = {extension_id(path): path for path in BUILDS if path.is_dir()}
    for name, root in CHROMIUM:
        prefs = root / "Default/Preferences"
        if not prefs.is_file():
            continue
        try:
            settings = json.loads(prefs.read_text(encoding="utf-8")).get("extensions", {}).get("settings", {})
        except (OSError, json.JSONDecodeError):
            continue
        for info in settings.values():
            raw = info.get("path") or ""
            if info.get("location") == 4 and raw:
                path = Path(raw)
                if path.is_dir():
                    found[extension_id(path)] = path
    return found


def loaded_in(root: Path) -> list[tuple[str, Path]]:
    prefs = root / "Default/Preferences"
    if not prefs.is_file():
        return []
    try:
        settings = json.loads(prefs.read_text(encoding="utf-8")).get("extensions", {}).get("settings", {})
    except (OSError, json.JSONDecodeError):
        return []
    rows = []
    for ext_id, info in settings.items():
        raw = info.get("path") or ""
        if info.get("location") == 4 and "browser-wallet" in raw:
            rows.append((ext_id, Path(raw)))
    return rows


def manifest_path(directory: Path) -> Path:
    return directory / "NativeMessagingHosts" / f"{HOST_NAME}.json"


def read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def allow_origin(origin: str) -> list[Path]:
    written = []
    payload = {
        "name": HOST_NAME,
        "description": "Forward SafeTrade calls over IPv4",
        "path": str(HOST_PATH),
        "type": "stdio",
        "allowed_origins": [origin],
    }
    for _name, root in CHROMIUM:
        if not root.is_dir():
            continue
        target = manifest_path(root)
        current = read_json(target) or dict(payload)
        origins = [item for item in current.get("allowed_origins", []) if isinstance(item, str)]
        if origin not in origins:
            origins.append(origin)
        current["name"] = HOST_NAME
        current["description"] = current.get("description") or payload["description"]
        current["path"] = str(HOST_PATH)
        current["type"] = "stdio"
        current["allowed_origins"] = origins
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        written.append(target)
    return written


def remove_origin(origin: str) -> list[Path]:
    written = []
    for _name, root in CHROMIUM:
        target = manifest_path(root)
        current = read_json(target)
        if current is None:
            continue
        origins = [item for item in current.get("allowed_origins", []) if isinstance(item, str) and item != origin]
        current["allowed_origins"] = origins
        target.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        written.append(target)
    return written


def remove_firefox(ext_id: str) -> list[Path]:
    written = []
    for _name, directory in FIREFOX:
        target = directory / f"{HOST_NAME}.json"
        current = read_json(target)
        if current is None:
            continue
        current["allowed_extensions"] = [
            item for item in current.get("allowed_extensions", []) if isinstance(item, str) and item != ext_id
        ]
        target.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        os.chmod(target, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        written.append(target)
    return written


def short_folder(folder: str) -> str:
    path = Path(folder)
    if path.name == "build":
        path = path.parent
    parent = path.parent.name
    if parent in {"webdev", "home", ""}:
        return path.name
    return f"{parent}/{path.name}"


def snapshot() -> dict:
    builds = known_builds()
    browsers = []
    for name, root in CHROMIUM:
        path = manifest_path(root)
        data = read_json(path)
        origins = []
        if data:
            for origin in data.get("allowed_origins", []):
                if not isinstance(origin, str):
                    continue
                ext_id = origin.removeprefix("chrome-extension://").strip("/")
                folder = builds.get(ext_id)
                origins.append({"origin": origin, "id": ext_id, "folder": str(folder) if folder else ""})
        browsers.append({
            "name": name,
            "installed": data is not None,
            "manifest": str(path),
            "program": (data or {}).get("path", ""),
            "origins": origins,
            "loaded": [{"id": ext_id, "folder": str(folder)} for ext_id, folder in loaded_in(root)],
        })
    firefox = []
    for name, directory in FIREFOX:
        path = directory / f"{HOST_NAME}.json"
        data = read_json(path)
        firefox.append({
            "name": name,
            "installed": data is not None,
            "extensions": data.get("allowed_extensions", []) if data else [],
        })
    return {"program": str(HOST_PATH), "browsers": browsers, "firefox": firefox}


def curl_text(args: list[str]) -> str:
    try:
        done = subprocess.run(["curl", *args], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.strip()


def probe_route() -> tuple[str, str]:
    """Public IPv4, and the address family safe.trade actually answers on."""
    ipv4 = curl_text(["-4", "-fsS", "--max-time", "6", "https://api.ipify.org"])
    remote = curl_text(["-sS", "--max-time", "6", "-o", "/dev/null", "-w", "%{remote_ip}", "https://safe.trade/"])
    if ipv4.count(".") != 3:
        ipv4 = ""
    return ipv4, remote


def esc(text: str) -> str:
    return GLib.markup_escape_text(text)


def text_label(markup: str, selectable: bool = False, center: bool = False) -> Gtk.Label:
    label = Gtk.Label(xalign=0.5 if center else 0)
    label.set_line_wrap(True)
    label.set_justify(Gtk.Justification.CENTER if center else Gtk.Justification.LEFT)
    label.set_max_width_chars(64)
    label.set_selectable(selectable)
    label.set_markup(markup)
    return label


class ForwarderWindow(Gtk.Window):
    def __init__(self) -> None:
        super().__init__(title="Warthog IPv4 forwarder")
        self.set_default_size(440, 360)
        self.set_size_request(320, 220)
        self.set_resizable(True)
        self.route_state = "idle"
        self.route_ip = ""
        self.route_note = "See the address SafeTrade would trust."
        self.set_decorated(False)
        self.set_app_paintable(True)
        self.get_style_context().add_class("wart")
        window_icon = WINDOW_ICON if WINDOW_ICON.is_file() else ICON
        if window_icon.is_file():
            self.set_icon_from_file(str(window_icon))
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        outer.get_style_context().add_class("wart-frame")
        overlay = Gtk.Overlay()
        overlay.add(outer)
        self.add(overlay)
        self.add_resize_grips(overlay)

        header = Gtk.Box(spacing=10)
        header.set_margin_top(12)
        header.set_margin_bottom(10)
        header.set_margin_start(14)
        header.set_margin_end(14)
        brand = Gtk.Box(spacing=10)
        if ICON.is_file():
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(ICON), 42, 42, True)
            brand.pack_start(Gtk.Image.new_from_pixbuf(pixbuf), False, False, 0)
        titles = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        titles.pack_start(text_label(f"<span weight='bold' size='large' color='{GOLD}'>WARTHOG</span>"), False, False, 0)
        titles.pack_start(text_label(f"<span color='{MUTED}'>IPv4 forwarder</span>"), False, False, 0)
        titles.set_valign(Gtk.Align.CENTER)
        brand.pack_start(titles, False, False, 0)
        drag = Gtk.EventBox()
        drag.get_style_context().add_class("wart-drag")
        drag.add(brand)
        drag.connect("button-press-event", self.on_drag)
        header.pack_start(drag, True, True, 0)
        refresh = Gtk.Button(label="Refresh")
        refresh.get_style_context().add_class("wart-ghost")
        refresh.set_valign(Gtk.Align.CENTER)
        refresh.connect("clicked", lambda _button: self.fill())
        header.pack_start(refresh, False, False, 0)
        close = Gtk.Button(label="×")
        close.get_style_context().add_class("wart-ghost")
        close.set_valign(Gtk.Align.CENTER)
        close.connect("clicked", lambda _button: self.destroy())
        header.pack_start(close, False, False, 0)
        outer.pack_start(header, False, False, 0)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_vexpand(True)
        self.body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.body.set_margin_start(16)
        self.body.set_margin_end(16)
        self.body.set_margin_bottom(8)
        scroll.add(self.body)
        outer.pack_start(scroll, True, True, 0)

        self.status = text_label(f"<span color='{MUTED}'> </span>")
        self.status.set_margin_start(16)
        self.status.set_margin_end(16)
        self.status.set_margin_bottom(12)
        outer.pack_start(self.status, False, False, 0)
        self.fill()
        self.on_check_route()

    def add_resize_grips(self, overlay: Gtk.Overlay) -> None:
        edges = (
            (Gdk.WindowEdge.NORTH, Gtk.Align.FILL, Gtk.Align.START, -1, 7, Gdk.CursorType.TOP_SIDE),
            (Gdk.WindowEdge.SOUTH, Gtk.Align.FILL, Gtk.Align.END, -1, 7, Gdk.CursorType.BOTTOM_SIDE),
            (Gdk.WindowEdge.WEST, Gtk.Align.START, Gtk.Align.FILL, 7, -1, Gdk.CursorType.LEFT_SIDE),
            (Gdk.WindowEdge.EAST, Gtk.Align.END, Gtk.Align.FILL, 7, -1, Gdk.CursorType.RIGHT_SIDE),
        )
        corners = (
            (Gdk.WindowEdge.NORTH_WEST, Gtk.Align.START, Gtk.Align.START, Gdk.CursorType.TOP_LEFT_CORNER),
            (Gdk.WindowEdge.NORTH_EAST, Gtk.Align.END, Gtk.Align.START, Gdk.CursorType.TOP_RIGHT_CORNER),
            (Gdk.WindowEdge.SOUTH_WEST, Gtk.Align.START, Gtk.Align.END, Gdk.CursorType.BOTTOM_LEFT_CORNER),
            (Gdk.WindowEdge.SOUTH_EAST, Gtk.Align.END, Gtk.Align.END, Gdk.CursorType.BOTTOM_RIGHT_CORNER),
        )
        for edge, halign, valign, width, height, cursor_type in edges:
            self.place_grip(overlay, edge, halign, valign, width, height, cursor_type)
        for edge, halign, valign, cursor_type in corners:
            self.place_grip(overlay, edge, halign, valign, 14, 14, cursor_type)

    def place_grip(
        self,
        overlay: Gtk.Overlay,
        edge: Gdk.WindowEdge,
        halign: Gtk.Align,
        valign: Gtk.Align,
        width: int,
        height: int,
        cursor_type: Gdk.CursorType,
    ) -> None:
        grip = Gtk.EventBox()
        grip.get_style_context().add_class("wart-drag")
        grip.set_size_request(width, height)
        grip.set_halign(halign)
        grip.set_valign(valign)
        grip.connect("button-press-event", lambda _widget, event, edge=edge: self.on_resize(edge, event))
        grip.connect("enter-notify-event", lambda widget, _event, kind=cursor_type: self.on_grip_cursor(widget, kind))
        grip.connect("leave-notify-event", lambda widget, _event: self.on_grip_cursor(widget, None))
        overlay.add_overlay(grip)

    def on_grip_cursor(self, grip: Gtk.EventBox, kind: Gdk.CursorType | None) -> bool:
        gdk_window = grip.get_window()
        if gdk_window is None:
            return False
        cursor = None if kind is None else Gdk.Cursor.new_for_display(grip.get_display(), kind)
        gdk_window.set_cursor(cursor)
        return False

    def on_resize(self, edge: Gdk.WindowEdge, event) -> bool:
        if event.button != 1:
            return False
        self.begin_resize_drag(edge, 1, int(event.x_root), int(event.y_root), event.time)
        return True

    def on_drag(self, _widget, event) -> bool:
        if event.button == 1:
            self.begin_move_drag(int(event.button), int(event.x_root), int(event.y_root), event.time)
        return True

    def clear(self) -> None:
        for child in self.body.get_children():
            self.body.remove(child)

    def row(self, title: str, detail: str, action: str, style: str, on_click) -> None:
        line = Gtk.Box(spacing=8)
        line.get_style_context().add_class("wart-card")
        words = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        words.pack_start(text_label(f"<span weight='bold' color='{INK}'>{esc(title)}</span>"), False, False, 0)
        ident = text_label(f"<span font_family='DejaVu Sans Mono' size='small' color='{GOLD}'>{esc(detail)}</span>")
        ident.set_tooltip_text("Click to copy")
        words.pack_start(ident, False, False, 0)
        words.set_valign(Gtk.Align.CENTER)
        hit = Gtk.EventBox()
        hit.get_style_context().add_class("wart-drag")
        hit.add(words)
        hit.connect("button-press-event", lambda _widget, event, text=detail: self.on_copy(text, event))
        line.pack_start(hit, True, True, 0)
        button = Gtk.Button(label=action)
        button.get_style_context().add_class(style)
        button.set_valign(Gtk.Align.CENTER)
        button.connect("clicked", on_click)
        line.pack_start(button, False, False, 0)
        self.body.pack_start(line, False, False, 0)

    def route_card(self) -> None:
        card = Gtk.Box(spacing=10)
        card.get_style_context().add_class("wart-route")
        dot = GOLD if self.route_state == "ok" else "#a56a6a" if self.route_state == "bad" else MUTED
        headline = self.route_ip if self.route_state == "ok" and self.route_ip else "Checking…" if self.route_state == "busy" else "IPv4 route" if self.route_state == "idle" else "IPv4 unreachable"
        words = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        words.pack_start(text_label(
            f"<span color='{dot}'>●</span>  <span weight='bold' color='{INK}'>{esc(headline)}</span>"
        ), False, False, 0)
        words.pack_start(text_label(f"<span size='small' color='{MUTED}'>{esc(self.route_note)}</span>"), False, False, 0)
        words.set_valign(Gtk.Align.CENTER)
        card.pack_start(words, True, True, 0)
        button = Gtk.Button(label="Checking…" if self.route_state == "busy" else "Check")
        button.get_style_context().add_class("wart-primary")
        button.set_valign(Gtk.Align.CENTER)
        button.set_sensitive(self.route_state != "busy")
        button.connect("clicked", lambda _button: self.on_check_route())
        card.pack_start(button, False, False, 0)
        self.body.pack_start(card, False, False, 0)

    def fill(self) -> None:
        self.clear()
        self.route_card()
        state = snapshot()
        seen: set[str] = set()
        loaded = []
        for browser in state["browsers"]:
            for row in browser["loaded"]:
                loaded.append((browser["name"], row))
                seen.add(row["id"])
        allowed: list[dict] = []
        for browser in state["browsers"]:
            for origin in browser["origins"]:
                if origin["id"] in {item["id"] for item in allowed}:
                    continue
                allowed.append(origin)
        loaded_ids = {row["id"] for _name, row in loaded}
        if not allowed and not loaded:
            self.body.pack_start(text_label(f"<span color='{MUTED}'>Nothing is allowed yet.</span>"), False, False, 0)
        for origin in allowed:
            title = short_folder(origin["folder"]) if origin["folder"] else "Extension"
            if origin["id"] in loaded_ids:
                title = f"{title}  · loaded"
            self.row(title, origin["id"], "Remove", "wart-remove", lambda _button, origin=origin["origin"]: self.on_remove(origin))
        for browser_name, row in loaded:
            if any(origin["id"] == row["id"] for origin in allowed):
                continue
            title = f"{short_folder(row['folder'])}  · {browser_name}"
            self.row(title, row["id"], "Allow", "wart-primary", lambda _button, ext_id=row["id"]: self.on_allow(ext_id))
        for item in state["firefox"]:
            if not item["installed"]:
                continue
            for ext_id in item["extensions"]:
                if not isinstance(ext_id, str) or ext_id in seen:
                    continue
                seen.add(ext_id)
                self.row(item["name"], ext_id, "Remove", "wart-remove", lambda _button, ext_id=ext_id: self.on_remove_firefox(ext_id))
        self.show_all()

    def on_copy(self, text: str, event) -> bool:
        if event.button != 1:
            return False
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(text, -1)
        self.set_status("Copied.", ok=True)
        return True

    def on_check_route(self) -> None:
        if self.route_state == "busy":
            return
        self.route_state = "busy"
        self.route_note = "Asking safe.trade over IPv4."
        self.fill()

        def work() -> None:
            ipv4, remote = probe_route()
            GLib.idle_add(self.apply_route, ipv4, remote)

        threading.Thread(target=work, daemon=True).start()

    def apply_route(self, ipv4: str, remote: str) -> bool:
        self.route_ip = ipv4
        if ipv4 and ":" in remote:
            self.route_state = "ok"
            self.route_note = "This computer prefers IPv6. The forwarder forces IPv4."
        elif ipv4 and remote:
            self.route_state = "ok"
            self.route_note = "safe.trade already answers on IPv4."
        elif ipv4:
            self.route_state = "ok"
            self.route_note = "IPv4 is open. safe.trade did not answer the family check."
        else:
            self.route_state = "bad"
            self.route_note = "The IPv4 path did not answer."
        self.fill()
        return False

    def set_status(self, message: str, ok: bool = False) -> None:
        color = GOLD if ok else MUTED
        self.status.set_markup(f"<span color='{color}'>{esc(message)}</span>")

    def on_allow(self, ext_id: str) -> None:
        written = allow_origin(f"chrome-extension://{ext_id}/")
        self.fill()
        self.set_status("Allowed. Press Check again on the SafeTrade screen." if written else "Could not update the host file.", ok=bool(written))

    def on_remove(self, origin: str) -> None:
        written = remove_origin(origin)
        self.fill()
        ext_id = origin.removeprefix("chrome-extension://").strip("/")
        self.set_status(f"Removed {ext_id}." if written else "Could not update the host file.", ok=bool(written))

    def on_remove_firefox(self, ext_id: str) -> None:
        written = remove_firefox(ext_id)
        self.fill()
        self.set_status(f"Removed {ext_id}." if written else "Could not update the Firefox host file.", ok=bool(written))


def main() -> None:
    GLib.set_prgname(APP_ID)
    GLib.set_application_name("Warthog IPv4 forwarder")
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
    window = ForwarderWindow()
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
