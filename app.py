import argparse
import io
import json
import logging
import mimetypes
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from engine import AudioError, MAX_BYTES, MODEL_NAME, Transcriber


PUBLIC = Path(__file__).resolve().parent / "public"
HOST = "127.0.0.1"
ENGINE = Transcriber()


class StudioHandler(BaseHTTPRequestHandler):
    def send_data(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, status, data):
        self.send_data(status, "application/json; charset=utf-8", json.dumps(data).encode("utf-8"))

    def allowed_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in {f"{HOST}:{port}", f"localhost:{port}"}

    def do_GET(self):
        if not self.allowed_host():
            self.send_json(403, {"error": "Open Sayback from its local address."})
            return

        path = unquote(urlsplit(self.path).path)
        if path == "/api/status":
            self.send_json(200, {"app": "sayback", "stage": ENGINE.stage, "model": MODEL_NAME})
            return

        if path == "/":
            path = "/index.html"
        if path not in {"/index.html", "/styles.css", "/studio.js", "/practice.js"} and not path.startswith("/assets/"):
            self.send_json(404, {"error": "Page not found."})
            return

        asset = (PUBLIC / path.lstrip("/")).resolve()
        if not asset.is_relative_to(PUBLIC) or not asset.is_file():
            self.send_json(404, {"error": "File not found."})
            return

        content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        if asset.suffix == ".js":
            content_type = "text/javascript"
        elif asset.suffix == ".woff2":
            content_type = "font/woff2"
        self.send_data(200, content_type, asset.read_bytes())

    def do_POST(self):
        origin = self.headers.get("Origin")
        if not self.allowed_host() or (origin and origin != f"http://{self.headers['Host']}"):
            self.send_json(403, {"error": "Transcription is available from the local studio."})
            return
        if self.path != "/api/transcribe":
            self.send_json(404, {"error": "Page not found."})
            return
        if self.headers.get_content_type() != "application/octet-stream":
            self.send_json(415, {"error": "Choose or record an audio file first."})
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size <= 0:
            self.send_json(400, {"error": "The audio file is empty."})
            return
        if size > MAX_BYTES:
            self.send_json(413, {"error": "Choose an audio file under 60 MB."})
            return
        if not ENGINE.job.acquire(blocking=False):
            self.send_json(409, {"error": "Whisper is finishing another recording. Try again in a moment."})
            return

        try:
            self.connection.settimeout(30)
            body = self.rfile.read(size)
            if len(body) != size:
                raise AudioError("The recording was interrupted. Please try again.")
            data = ENGINE.transcribe(io.BytesIO(body))
        except (AudioError, TimeoutError) as error:
            message = str(error) if isinstance(error, AudioError) else "The audio transfer timed out. Please try again."
            self.send_json(422, {"error": message})
        except Exception:
            logging.exception("Whisper transcription failed")
            message = (
                "Whisper could not start. Check your internet connection for the first model download, then retry."
                if ENGINE.stage == "loading" else "Whisper could not finish this transcription. Please try again."
            )
            self.send_json(500, {"error": message})
        else:
            self.send_json(200, data)
        finally:
            ENGINE.stage = "idle"
            ENGINE.job.release()

    def log_message(self, format, *args):
        if args and str(args[0]).startswith("GET /api/status "):
            return
        super().log_message(format, *args)


def running_studio(url):
    try:
        with urllib.request.urlopen(f"{url}/api/status", timeout=2) as response:
            return json.load(response).get("app") == "sayback"
    except (OSError, ValueError, AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser(description="Run Sayback, the local IELTS speaking studio.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open the studio in your browser")
    parser.add_argument("--prepare", action="store_true", help="Download and load the Whisper model now")
    options = parser.parse_args()
    if options.prepare:
        print(f"Preparing Whisper {MODEL_NAME}…", flush=True)
        ENGINE.load_model()
        print("Whisper is ready.")
        return

    url = f"http://{HOST}:{options.port}"
    try:
        server = ThreadingHTTPServer((HOST, options.port), StudioHandler)
    except OSError as error:
        if options.open and running_studio(url):
            webbrowser.open(url)
            return
        parser.exit(1, f"Could not start Sayback on port {options.port}. {error}\n")

    with server:
        print(f"Sayback is ready at {url}", flush=True)
        if options.open:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nSayback stopped.")


if __name__ == "__main__":
    main()
