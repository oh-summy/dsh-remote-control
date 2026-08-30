#!/usr/bin/env python3
"""remote-control 登录服务（仅登录页，不在资源请求热路径上）

鉴权由 Caddy 内完成（Cookie 含令牌 vs {env.RC_TOKEN}），本服务只做：
  GET/POST /rc-login —— 登录表单（每 IP 失败锁定）+ 成功后发令牌 Cookie
  GET      /rc-logout —— 清除 Cookie

为什么不用 Basic Auth：Safari/WebKit 不在 WebSocket 握手上携带 Basic 凭据，
导致反复弹密码框。为什么不做 per-request 校验：浏览器并发拉取全部插件
脚本，外部鉴权服务是瓶颈，Caddy 内匹配零开销。
"""
import hashlib
import hmac
import html
import os
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RC_HOME = os.environ.get("RC_HOME", os.path.expanduser("~/.remote-control"))
PORT = int(os.environ.get("RC_AUTH_PORT", "9091"))
SESSION_TTL = 7 * 86400
LOCK_THRESHOLD = 5      # 连续失败次数
LOCK_SECONDS = 300      # 锁定时长

with open(os.path.join(RC_HOME, "session.secret"), encoding="ascii") as f:
    TOKEN = f.read().strip()
with open(os.path.join(RC_HOME, "password"), encoding="ascii") as f:
    PASSWORD = f.read().strip()

FAILS = {}  # ip -> [fail_count, lock_until_ts]


def client_ip(headers):
    return (headers.get("Cf-Connecting-Ip")
            or headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or "local")


PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Control 登录</title><style>
body{{background:#111;color:#eee;font-family:-apple-system,sans-serif;display:flex;
justify-content:center;align-items:center;min-height:100vh;margin:0}}
.card{{background:#1c1c1e;border-radius:14px;padding:32px;width:300px}}
h1{{font-size:18px;margin:0 0 4px}}p.sub{{color:#888;font-size:12px;margin:0 0 20px}}
input{{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;
background:#111;color:#eee;font-size:16px}}
button{{width:100%;padding:12px;margin-top:12px;border:0;border-radius:8px;
background:#0a84ff;color:#fff;font-size:16px}}
.err{{color:#ff453a;font-size:13px;margin:0 0 12px}}</style></head><body>
<form class="card" method="POST" action="/rc-login">
<h1>Remote Control</h1><p class="sub">{host}</p>
{err}<input type="password" name="pw" placeholder="访问密码" autofocus>
<input type="hidden" name="next" value="/">
<button>登 录</button></form></body></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body=b"", headers=()):
        self.send_response(code)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _redirect(self, location, clear_cookie=False):
        hdrs = [("Location", location)]
        if clear_cookie:
            hdrs.append(("Set-Cookie", "rc_session=; Max-Age=0; Path=/"))
        self._send(302, headers=hdrs)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/rc-login":
            ip = client_ip(self.headers)
            if time.time() < FAILS.get(ip, [0, 0])[1]:
                body = PAGE.format(host=html.escape(self.headers.get("Host", "")),
                                   err="<p class='err'>失败次数过多，请 5 分钟后再试</p>").encode()
                self._send(429, body, [("Content-Type", "text/html; charset=utf-8")])
                return
            body = PAGE.format(host=html.escape(self.headers.get("Host", "")),
                               err="").encode()
            self._send(200, body, [("Content-Type", "text/html; charset=utf-8")])
        elif path == "/rc-logout":
            self._redirect("/rc-login", clear_cookie=True)
        else:
            self._redirect("/rc-login")

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/rc-login":
            self._redirect("/rc-login")
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        pw = form.get("pw", [""])[0]
        ip = client_ip(self.headers)
        cnt, lock = FAILS.get(ip, [0, 0])
        now = time.time()
        if now < lock:
            self._redirect("/rc-login?locked=1")
            return
        if hmac.compare_digest(pw, PASSWORD):
            FAILS.pop(ip, None)
            cookie = (f"rc_session={TOKEN}; Max-Age={SESSION_TTL}; Path=/; "
                      "HttpOnly; SameSite=Lax")
            self._send(302, headers=[("Location", "/"), ("Set-Cookie", cookie)])
        else:
            cnt += 1
            lock_until = now + LOCK_SECONDS if cnt >= LOCK_THRESHOLD else 0
            FAILS[ip] = [cnt, lock_until]
            print(f"[auth] failed login ip={ip} count={cnt} "
                  f"{'LOCKED ' + str(LOCK_SECONDS) + 's' if lock_until else ''}",
                  flush=True)
            self._redirect("/rc-login?err=1")

    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 128  # 默认 5，登录突发时防 SYN 丢弃


if __name__ == "__main__":
    srv = Server(("127.0.0.1", PORT), Handler)
    print(f"[auth] listening 127.0.0.1:{PORT} (login-only)", flush=True)
    srv.serve_forever()
