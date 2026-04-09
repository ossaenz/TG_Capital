#!/usr/bin/env python3
"""
Local dev server for TG-Capital.
Sets Cross-Origin-Opener-Policy: same-origin-allow-popups so Google's
OAuth popup can communicate back to the page (fixes the COOP window.closed error).

Usage:
    python3 server.py          # listens on http://localhost:8080
    python3 server.py 3000     # choose a different port
"""

import sys
import http.server
import functools


class COOPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress noisy per-request logs; keep errors visible
        if int(args[1]) >= 400:
            super().log_message(fmt, *args)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
handler = functools.partial(COOPHandler, directory=".")

with http.server.HTTPServer(("", port), handler) as httpd:
    print(f"Serving at http://localhost:{port}  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
