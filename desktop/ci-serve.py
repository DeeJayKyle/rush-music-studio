# Serves the desktop app like the Electron shell does (rush:// mapping + cross-origin isolation) for CI checks.
import http.server, os, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, p):
        p = p.split('?')[0].lstrip('/') or 'RushMusicStudio.html'
        base = os.path.join(ROOT, 'ai') if p.startswith(('models/', 'ort/')) else os.path.join(ROOT, 'app')
        return os.path.join(base, *p.split('/'))
    def end_headers(self):
        for k, v in (('Cross-Origin-Opener-Policy', 'same-origin'), ('Cross-Origin-Embedder-Policy', 'require-corp'), ('Cross-Origin-Resource-Policy', 'same-origin')): self.send_header(k, v)
        super().end_headers()
    def log_message(self, *a): pass
H.extensions_map.update({'.mjs': 'text/javascript', '.wasm': 'application/wasm'})
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
