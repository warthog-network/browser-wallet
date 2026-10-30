#!/usr/bin/python3
"""SafeTrade native host. Signed extension calls leave with curl -4.

SafeTrade can store an IPv4 allowlist entry and cannot store an IPv6 address.
The browser cannot choose the address family. The host is started by the
extension and speaks one native-messaging message on stdin/stdout.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys


def find_curl():
    """Linux keeps the system curl. Windows uses curl.exe on PATH."""
    if sys.platform == "win32":
        return shutil.which("curl.exe") or shutil.which("curl")
    if os.path.isfile("/usr/bin/curl"):
        return "/usr/bin/curl"
    return shutil.which("curl")


CURL = find_curl()
ORIGIN = "https://safe.trade/api/v2"
MAX_BODY = 16384
MAX_OUT = 900_000
MARKER = "\n__WART_HTTP_"

GET_EXACT = {
    "/trade/public/tickers/wartusdt",
    "/trade/account/balances/spot",
    "/trade/account/beneficiaries",
}
POST_EXACT = {
    "/trade/market/orders",
    "/trade/account/withdraws",
    "/trade/account/withdraws/generate_code",
    "/trade/account/beneficiaries",
    "/trade/account/beneficiaries/generate_code",
}
AUTH = ("X-Auth-Apikey", "X-Auth-Nonce", "X-Auth-Signature")
SEARCH_OK = re.compile(r"^\?[A-Za-z0-9._~%=&,-]{0,512}$")
DEPOSIT = re.compile(r"^/trade/account/deposit_address/(wart|usdt|btc|eth|sol|usdc)$")
ORDER = re.compile(r"^/trade/market/orders/\d+$")
CANCEL = re.compile(r"^/trade/market/orders/\d+/cancel$")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        raise ValueError("short header")
    length = struct.unpack("<I", raw)[0]
    if length <= 0 or length > 1_000_000:
        raise ValueError("bad length")
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        raise ValueError("short body")
    parsed = json.loads(data.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("not an object")
    return parsed


def write_message(obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def path_allowed(method, pathname):
    if method == "GET" and (
        pathname in GET_EXACT
        or pathname == "/trade/market/orders"
        or ORDER.match(pathname)
        or DEPOSIT.match(pathname)
    ):
        return True
    return method == "POST" and (pathname in POST_EXACT or CANCEL.match(pathname))


def auth_headers(message):
    headers = message.get("headers")
    if headers is None:
        headers = {}
    if not isinstance(headers, dict):
        raise ValueError("bad headers")
    wanted = {name.lower(): name for name in AUTH}
    out = []
    for key, value in headers.items():
        if not isinstance(key, str) or key.lower() not in wanted:
            continue
        if not isinstance(value, str) or not value or len(value) > 256:
            raise ValueError("bad auth header")
        if "\r" in value or "\n" in value:
            raise ValueError("bad auth header")
        out.append((wanted[key.lower()], value))
    return out


def handle(message):
    if message.get("op") == "ping":
        return {"ok": True, "ipv4": True}
    method = message.get("method") or "GET"
    if method not in ("GET", "POST"):
        return {"error": "The SafeTrade forwarder rejected this request."}
    path = message.get("path")
    search = message.get("search") or ""
    if not isinstance(path, str) or not isinstance(search, str):
        return {"error": "The SafeTrade forwarder rejected this request."}
    if not path_allowed(method, path) or (search and not SEARCH_OK.match(search)):
        return {"error": "The SafeTrade forwarder rejected this request."}
    body = message.get("body")
    payload = None
    if method == "POST":
        if body is None:
            body = ""
        if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_BODY:
            return {"error": "The SafeTrade forwarder rejected this request."}
        payload = body.encode("utf-8")
    try:
        headers = auth_headers(message)
    except ValueError:
        return {"error": "The SafeTrade forwarder rejected this request."}

    if not CURL:
        return {"error": "The SafeTrade IPv4 forwarder needs curl installed on this computer."}

    args = [
        CURL,
        "-sS",
        "-4",
        "-m",
        "25",
        "-A",
        "WarthogWallet/1.0",
        "-H",
        "Accept: application/json",
    ]
    if method == "POST":
        args += ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-"]
    for name, value in headers:
        args += ["-H", f"{name}: {value}"]
    args += ["-w", f"{MARKER}%{{http_code}}__", f"{ORIGIN}{path}{search}"]
    # A console window on Windows would flash over the browser for every call.
    launch = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    try:
        # Never inherit the native-messaging stdin. Chrome keeps it open, and
        # curl would block on it.
        if payload is None:
            proc = subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=30,
                check=False,
                **launch,
            )
        else:
            proc = subprocess.run(
                args,
                input=payload,
                capture_output=True,
                timeout=30,
                check=False,
                **launch,
            )
    except (OSError, subprocess.TimeoutExpired):
        return {"error": "The SafeTrade IPv4 forwarder could not reach SafeTrade."}
    if proc.returncode != 0:
        return {"error": "The SafeTrade IPv4 forwarder could not reach SafeTrade."}
    if len(proc.stdout) > MAX_OUT:
        return {"error": "The SafeTrade IPv4 forwarder could not reach SafeTrade."}
    text = proc.stdout.decode("utf-8", "replace")
    mark = text.rfind(MARKER)
    if mark < 0 or not text.endswith("__"):
        return {"error": "The SafeTrade IPv4 forwarder could not reach SafeTrade."}
    status_text = text[mark + len(MARKER) : -2]
    if not status_text.isdigit():
        return {"error": "The SafeTrade IPv4 forwarder could not reach SafeTrade."}
    return {"status": int(status_text), "body": text[:mark]}


def main():
    if sys.platform == "win32":
        import msvcrt

        # Text mode rewrites newline bytes and breaks native-message framing.
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        reply = handle(read_message())
    except Exception:
        reply = {"error": "The SafeTrade IPv4 forwarder failed."}
    write_message(reply)


if __name__ == "__main__":
    main()
