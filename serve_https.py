#!/usr/bin/env python3
"""Drop-in replacement for `python3 -m http.server 8080` with TLS.

WebTransport (and other secure-context APIs) are only exposed over
https://, so testing from a phone on the LAN requires serving TLS.

One-time cert setup (see also: trusting rootCA.pem on the phone):

    brew install mkcert
    mkcert -install
    mkcert -cert-file cert.pem -key-file key.pem \
        "$(ipconfig getifaddr en0)" "$(hostname).local" localhost

Usage:

    python3 serve_https.py [port] [dir]   # default 8443, this folder

The sia-site sandbox needs its own origin, so run a second instance
for it (the certs are always loaded from this script's folder):

    python3 serve_https.py 8081 ~/repos/sialo_sandbox

The CSP in index.html allows https://localhost and https://127.0.0.1 as
frame sources, which covers testing on this machine. Reaching the sandbox
from a phone means framing this machine's LAN address, so add that origin
to frame-src locally; it stays out of the committed policy because the
address belongs to whoever is testing.
"""
import http.server
import pathlib
import ssl
import sys

HERE = pathlib.Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
ROOT = pathlib.Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else HERE


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(HERE / "cert.pem", HERE / "key.pem")

httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f"Serving {ROOT} at https://0.0.0.0:{PORT}/")
httpd.serve_forever()
