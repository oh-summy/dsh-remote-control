#!/usr/bin/env python3
"""remote-control 登录服务（仅登录页，不在资源请求热路径上）

鉴权由 Caddy 内完成（Cookie 含令牌 vs {env.RC_TOKEN}），本服务只做：
  GET/POST /rc-login —— 登录表单（每 IP 失败锁定）+ 成功后发令牌 Cookie
  GET      /rc-logout —— 清除 Cookie

为什么不用 Basic Auth：Safari/WebKit 不在 WebSocket 握手上携带 Basic 凭据，
导致反复弹密码框。为什么不做 per-request 校验：浏览器并发拉取全部插件
脚本，外部鉴权服务是瓶颈，Caddy 内匹配零开销。

DSH 新版（≥0.1.5）在首次访问时要求用一次性 launch token 换签名 cookie，
且 cookie 的 authority 字段必须等于 Host（即 127.0.0.1:3080）。
本服务在登录成功后自动完成 token→cookie 交换，将两个 cookie 一起发给浏览器。
"""
import base64
import hashlib
import hmac
import html
import http.client
import json
import os
import re
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RC_HOME = os.environ.get("RC_HOME", os.path.expanduser("~/.remote-control"))
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
PORT = int(os.environ.get("RC_AUTH_PORT", "9091"))
SESSION_TTL = 7 * 86400
LOCK_THRESHOLD = 5      # 连续失败次数
LOCK_SECONDS = 300      # 锁定时长
MAX_BODY = 64 * 1024    # 登录表单远小于此；封顶防畸形大请求吃内存
DSH_COOKIE_MAX_AGE_DAYS = int(os.environ.get("DSH_COOKIE_MAX_AGE_DAYS", "7"))

with open(os.path.join(RC_HOME, "session.secret"), encoding="ascii") as f:
    TOKEN = f.read().strip()
with open(os.path.join(RC_HOME, "password"), encoding="ascii") as f:
    PASSWORD = f.read().strip()

# DSH 浏览器会话签名密钥（存于 ~/.dsh/.credentials.yaml records 中）
_DSH_SECRET_B64 = ""
_DSH_LAUNCH_TOKEN = ""


def _load_dsh_credentials():
    """从 ~/.dsh/.credentials.yaml 读取 browser-session 密钥和当前 launch token。
    DSH 每次启动生成新 token，所以每次启动 auth-server 时刷新一次即可。"""
    global _DSH_SECRET_B64, _DSH_LAUNCH_TOKEN
    cred_path = os.path.join(DSH_HOME, ".credentials.yaml")
    try:
        import yaml
        d = yaml.safe_load(open(cred_path))
        rec = (d.get("records") or {}).get("client-connection/browser-session", {})
        payload = rec.get("payload", {})
        if payload.get("version") == 1 and "secret" in payload:
            _DSH_SECRET_B64 = payload["secret"]
    except Exception:
        pass
    # launch token 是 DSH 进程打印在 stdout 里的；日志文件每次 start 时清空，
    # 所以 tail 能拿到最新那次启动的 token
    try:
        log_path = os.path.join(RC_HOME, "logs", "dsh.log")
        with open(log_path) as f:
            for line in reversed(list(f)):
                m = re.search(r'token=([A-Za-z0-9_-]+)', line)
                if m:
                    _DSH_LAUNCH_TOKEN = m.group(1)
                    break
    except Exception:
        pass


def _encode_b64url(data):
    """Base64url 编码，去掉尾部 = 填充（与 Node.js crypto 一致）。"""
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _dsh_cookie_name(authority):
    """生成 DSH 的 dsh-auth-<hash> cookie 名。"""
    h = _encode_b64url(hashlib.sha256(authority.encode()).digest())
    return f"dsh-auth-{h}"


def _dsh_cookie_value(secret_b64, authority, now_ms, expires_ms):
    """用 DSH 的 HMAC-SHA256 算法生成签名 cookie 值。"""
    secret_bytes = base64.urlsafe_b64decode(secret_b64 + '==')
    payload = json.dumps(
        {"version": 1, "authority": authority, "issuedAt": now_ms, "expiresAt": expires_ms},
        separators=(',', ':')
    )
    body = _encode_b64url(payload.encode())
    sig = _encode_b64url(hmac.new(secret_bytes, body.encode(), hashlib.sha256).digest())
    return f"v1.{body}.{sig}"


def _exchange_token(token, authority="127.0.0.1:3080"):
    """用 DSH launch token 换取浏览器签名 cookie。
    返回 (cookie_name, cookie_value, max_age_seconds) 或 None。"""
    if not _DSH_SECRET_B64 or not token or token != _DSH_LAUNCH_TOKEN:
        return None
    now_ms = int(time.time() * 1000)
    expires_ms = now_ms + DSH_COOKIE_MAX_AGE_DAYS * 86400 * 1000
    max_age = DSH_COOKIE_MAX_AGE_DAYS * 86400
    name = _dsh_cookie_name(authority)
    value = _dsh_cookie_value(_DSH_SECRET_B64, authority, now_ms, expires_ms)
    return name, value, max_age


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

    def _redirect(self, location, clear_cookie=False, extra_cookies=()):
        hdrs = [("Location", location)]
        if clear_cookie:
            hdrs.append(("Set-Cookie", "rc_session=; Max-Age=0; Path=/"))
        for c in extra_cookies:
            hdrs.append(("Set-Cookie", c))
        self._send(302, headers=hdrs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/rc-login":
            ip = client_ip(self.headers)
            locked = time.time() < FAILS.get(ip, [0, 0])[1]
            err_qs = qs.get("err")
            if locked:
                err = "<p class='err'>失败次数过多，请 5 分钟后再试</p>"
            elif err_qs:
                err = "<p class='err'>密码错误，请重试</p>"
            else:
                err = ""
            body = PAGE.format(host=html.escape(self.headers.get("Host", "")),
                               err=err).encode()
            self._send(429 if locked else 200, body,
                       [("Content-Type", "text/html; charset=utf-8")])
            return

        if path == "/rc-logout":
            self._redirect("/rc-login", clear_cookie=True)
            return

        # ── DSH 新认证流程 ────────────────────────────────────────────────
        # 用户通过我们的网关登录成功后，被重定向到 /?token=...
        # 这里：auth-server 用 token 向 DSH 换签名 cookie，连同 rc_session 一起返回
        if path == "/" and qs.get("token"):
            token = qs["token"][0]
            authority = self.headers.get("Host", "127.0.0.1:3080")
            dsh_cookie = _exchange_token(token, authority)
            if dsh_cookie:
                name, value, max_age = dsh_cookie
                rc_cookie = (f"rc_session={TOKEN}; Max-Age={SESSION_TTL}; Path=/; "
                             "HttpOnly; SameSite=Lax")
                dsh_cookie_str = (f"{name}={value}; Max-Age={max_age}; Path=/; "
                                  "HttpOnly; SameSite=Strict")
                self._redirect("/", extra_cookies=[rc_cookie, dsh_cookie_str])
            else:
                # token 不匹配或 secret 未加载，退回到登录页
                self._redirect("/rc-login")
            return

        # 其他所有请求：先做密码门校验（由 Caddy 处理），这里兜底重定向
        self._redirect("/rc-login")

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/rc-login":
            self._redirect("/rc-login")
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_BODY:
            self._send(413, b"payload too large",
                       [("Content-Type", "text/plain; charset=utf-8")])
            return
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        pw = form.get("pw", [""])[0]
        next_path = form.get("next", ["/"])[0]
        ip = client_ip(self.headers)
        cnt, lock = FAILS.get(ip, [0, 0])
        now = time.time()
        if now < lock:
            self._redirect("/rc-login?locked=1")
            return
        # compare_digest 只接受 ASCII str；用户粘贴非 ASCII 内容时会抛 TypeError，
        # 统一按字节比较（时序安全性不变）
        if hmac.compare_digest(pw.encode("utf-8"), PASSWORD.encode("utf-8")):
            FAILS.pop(ip, None)
            # 登录成功：同时签发 rc_session（Caddy 密码门）和 dsh-auth（DSH 浏览器认证）
            # authority 使用回环地址（127.0.0.1:3080），因为 Caddy 代理到 DSH 时会把 Host
            # 重写为上游地址；DSH 验证 cookie 时比较的是 Host 头，必须与 cookie 内一致
            rc_cookie = (f"rc_session={TOKEN}; Max-Age={SESSION_TTL}; Path=/; "
                         "HttpOnly; SameSite=Lax")
            dsh_authority = os.environ.get("RC_UPSTREAM", "127.0.0.1:3080")
            if _DSH_SECRET_B64 and _DSH_LAUNCH_TOKEN:
                now_ms = int(time.time() * 1000)
                expires_ms = now_ms + DSH_COOKIE_MAX_AGE_DAYS * 86400 * 1000
                dsh_name = _dsh_cookie_name(dsh_authority)
                dsh_value = _dsh_cookie_value(_DSH_SECRET_B64, dsh_authority, now_ms, expires_ms)
                dsh_cookie_str = (f"{dsh_name}={dsh_value}; Max-Age={DSH_COOKIE_MAX_AGE_DAYS*86400}; "
                                  "Path=/; HttpOnly; SameSite=Strict")
                self._redirect("/", extra_cookies=[rc_cookie, dsh_cookie_str])
            else:
                self._redirect("/", extra_cookies=[rc_cookie])
        else:
            cnt += 1
            lock_until = now + LOCK_SECONDS if cnt >= LOCK_THRESHOLD else 0
            FAILS[ip] = [cnt, lock_until]
            print(f"[auth] failed login ip={ip} count={cnt} "
                  f"{'LOCKED ' + str(LOCK_SECONDS) + 's' if lock_until else ''}",
                  flush=True)
            # 带 err=1，让登录页显示错误提示；保留原有 next（如果有）
            self._redirect("/rc-login?err=1")

    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 128  # 默认 5，登录突发时防 SYN 丢弃


if __name__ == "__main__":
    _load_dsh_credentials()
    print(f"[auth] secret loaded: {'yes' if _DSH_SECRET_B64 else 'no'} "
          f"token={'set' if _DSH_LAUNCH_TOKEN else 'not found'}", flush=True)
    srv = Server(("127.0.0.1", PORT), Handler)
    print(f"[auth] listening 127.0.0.1:{PORT} (login-only)", flush=True)
    srv.serve_forever()
