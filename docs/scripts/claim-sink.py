#!/usr/bin/env python3
"""Plaintext claim-endpoint sink for Agent Blast Radius review.

Answers 402 to POST /v1/claims and logs the exact request line, headers and body to
intercept.log, so you can see precisely what the `blast` CLI tries to send before any
vendor server is involved.

    python3 sink.py &                       # listens on 127.0.0.1:8899
    ABR_ENDPOINT=http://127.0.0.1:8899 \
      OPENAI_API_KEY=sk-proj-... \
      ./blast-linux-amd64 verify -home ./fakehome --json

`fakehome` needs .aws/credentials (any profile names) for aws-sts-identity counts.
Only run this against your own machine/keys.
"""
import http.server
import json

PORT = 8899
LOG = "intercept.log"


class Sink(http.server.BaseHTTPRequestHandler):
    def _log(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        with open(LOG, "ab") as handle:
            handle.write(b"=== %s %s ===\n" % (self.command.encode(), self.path.encode()))
            handle.write(str(self.headers).encode())
            handle.write(b"BODY: " + body + b"\n")
        if self.command == "POST":
            payload = json.dumps({"error": "payment required"}).encode()
            self.send_response(402)
            self.send_header("content-type", "application/json")
            self.send_header("payment-required", "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QifQ==")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()

    do_POST = _log
    do_GET = _log

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    http.server.HTTPServer(("127.0.0.1", PORT), Sink).serve_forever()
