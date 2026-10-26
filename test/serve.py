"""Serves the project for test/harness.html.

Pages under /extension/ get the same Content-Security-Policy the extension declares,
so the segmenter iframe is tested under the rules it will face inside Chrome.
"""
import http.server
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
manifest = json.loads((ROOT / "extension/manifest.json").read_text())
EXTENSION_CSP = manifest["content_security_policy"]["extension_pages"]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if self.path.startswith("/extension/") and self.path.split("?")[0].endswith(".html"):
            self.send_header("Content-Security-Policy", EXTENSION_CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.SimpleHTTPRequestHandler.extensions_map[".mjs"] = "text/javascript"
http.server.SimpleHTTPRequestHandler.extensions_map[".wasm"] = "application/wasm"

if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        print(f"Serving on http://127.0.0.1:{PORT}/test/harness.html")
        server.serve_forever()
