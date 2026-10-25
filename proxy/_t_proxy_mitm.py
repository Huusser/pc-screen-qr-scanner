# -*- coding: utf-8 -*-
"""端到端验收：内置运行时 + 纯 Python 证书，真的能完成一次 HTTPS 中间人。

全程离线，不碰系统代理、不装证书、不访问外网：
  本地 TLS 服务(18443) ← MITM 代理(18888) ← 测试客户端(CONNECT + TLS)
客户端只信任临时目录里的 ca.crt，能验过就说明：
  根证书、叶子证书、签名算法、SAN、SNI 全部正确。
"""
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# 故意用**非 443** 端口：P1-B 修的就是"上游 TLS 只看端口号"这个缺陷。
# 以前这里被迫写 443（非 443 必 502），现在 18443 能通才说明修好了，
# 而且不用管理员权限就能跑。
TLS_PORT = int(os.environ.get("QR_TLS_PORT") or 18443)
sys.path.insert(0, HERE)
import certs  # noqa: E402

PY = os.path.join(os.path.dirname(HERE), "desktop", "vendor", "python", "python.exe")
if not os.path.exists(PY):
    PY = sys.executable
    print("（用当前解释器代替内置运行时）")

data = tempfile.mkdtemp(prefix="qr-mitm-")
os.environ["QRSCAN_PROXY_DATA"] = data
store = certs.CertStore(data, log=lambda *a: None)

# 1) 本地 HTTPS 服务：用同一套 CA 签出来的 127.0.0.1 证书
ctx = store.server_context("127.0.0.1")
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", TLS_PORT))
srv.listen(4)


def serve():
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        try:
            c = ctx.wrap_socket(conn, server_side=True)
            req = c.recv(4096)
            body = b"HELLO-FROM-UPSTREAM"
            c.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
                + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
            )
            c.close()
        except Exception:
            try:
                conn.close()
            except Exception:
                pass


threading.Thread(target=serve, daemon=True).start()

# 2) 起代理（内置运行时）
env = dict(os.environ)
env["QRSCAN_PROXY_DATA"] = data
proc = subprocess.Popen(
    [PY, os.path.join(HERE, "run_proxy.py"),
     "--port", "18888", "--admin-port", "18899",
     "--no-system-proxy", "--no-ca-install",
     "--scope", "127.0.0.1", "--ttl", "40"],
    cwd=HERE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)

ready = False
for _ in range(60):
    try:
        with urllib.request.urlopen("http://127.0.0.1:18899/status", timeout=1) as r:
            if r.status == 200:
                ready = True
                break
    except Exception:
        time.sleep(0.25)

print("ok   代理已就绪" if ready else "FAIL 代理没起来")

# 3) 通过代理做 CONNECT，再用 ca.crt 校验
result = {"ok": False}
if ready:
    # 管理口先起来、MITM 口可能还差几十毫秒，这里重试到连上为止
    for attempt in range(24):
        try:
            raw = socket.create_connection(("127.0.0.1", 18888), timeout=6)
            break
        except Exception as e:
            raw = None
            last = e
            time.sleep(0.25)
    if raw is None:
        result["error"] = "MITM 端口连不上: %r" % (last,)
    try:
        if raw is None:
            raise RuntimeError("no socket")
        raw.sendall(b"CONNECT 127.0.0.1:%d HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n" % (TLS_PORT, TLS_PORT))
        head = raw.recv(512)
        if b"200" not in head.split(b"\r\n")[0]:
            raise RuntimeError("CONNECT 被拒: " + head[:80].decode("latin-1"))

        cc = ssl.create_default_context(cafile=os.path.join(data, "certs", "ca.crt"))
        cc.check_hostname = True
        tls = cc.wrap_socket(raw, server_hostname="127.0.0.1")
        tls.sendall((b"GET / HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n\r\n" % TLS_PORT))
        buf = b""
        while True:
            chunk = tls.recv(4096)
            if not chunk:
                break
            buf += chunk
        tls.close()
        result["ok"] = b"HELLO-FROM-UPSTREAM" in buf
        result["head"] = buf[:80].decode("latin-1", "replace").replace("\r\n", " | ")
        result["len"] = len(buf)
        if not result["ok"]:
            body = buf.split(b"\r\n\r\n", 1)[-1]
            result["body"] = body[:300].decode("utf-8", "replace")
    except Exception as e:
        result["error"] = repr(e)

print("     响应摘要:", result.get("head") or result.get("error"), "| 字节数",
      result.get("len"))

print(("ok   " if result["ok"] else "FAIL ") + "经代理的 HTTPS 请求校验通过" +
      ("  " + result.get("head", "") if result["ok"] else "  " + result.get("error", "")))

# 4) 反例：换一个不信任的 CA 必须失败
if result["ok"]:
    try:
        raw = socket.create_connection(("127.0.0.1", 18888), timeout=6)
        raw.sendall(b"CONNECT 127.0.0.1:%d HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n" % (TLS_PORT, TLS_PORT))
        raw.recv(512)
        bad = ssl.create_default_context(cafile=os.path.join(
            os.environ["APPDATA"], "ScreenQR", "proxy", "certs", "ca.crt"))
        tls = bad.wrap_socket(raw, server_hostname="127.0.0.1")
        tls.close()
        print("FAIL 用别的根证书竟然也验过了")
    except Exception as e:
        print("ok   用别的根证书被拒绝  " + type(e).__name__)

# 5) 收尾
try:
    urllib.request.urlopen("http://127.0.0.1:18899/quit", timeout=2).read()
except Exception:
    pass
time.sleep(1.5)
try:
    proc.terminate()
except Exception:
    pass
out = b""
try:
    out = proc.communicate(timeout=8)[0] or b""
except Exception:
    pass
print("---- 代理输出 ----")
print(out.decode("utf-8", "replace").strip()[:600])

leaf = os.path.join(data, "certs", "leaf-native2")
print("数据目录:", data)
print("已签发叶子证书:", len(os.listdir(leaf)) if os.path.isdir(leaf) else 0, "个")
if result.get("body"):
    print("502 正文:", result["body"])
print("结果:", "ALL PASS" if result["ok"] else "HAS FAILURES")
