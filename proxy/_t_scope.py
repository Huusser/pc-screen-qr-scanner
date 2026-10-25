# -*- coding: utf-8 -*-
"""P1-C 验收：默认"只接管目标站"到底能不能用。

收窄模式最大的风险不是 PAC 写错，而是**跨站跳转会漏一拍**：
客户端拿到 302 就去查 PAC，如果那时新域名还没进范围，就直接连源站了
（表现：页面回到 PC 版 / 404）。所以本测试盯的是"302 写回之前范围就已经更新"。

全程离线、不装证书、不碰系统代理：
  上游 A（127.0.0.1:18443）返回 302 → 上游 B（127.0.0.2:18444）
  代理只被要求接管 127.0.0.1，第二跳的 127.0.0.2 必须靠运行期学习进来。

断言：
  C1  收窄模式下 /status 的 proxy_all=false，scope 里有目标域
  C2  /proxy.pac 对 scope 内返回 PROXY、对其他返回 DIRECT
  C3  收到 302 之后（在客户端还没发下一跳之前）新域名已进入 scope
  C4  PAC 内容随之更新
"""
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import certs  # noqa: E402

PY = os.path.join(os.path.dirname(HERE), "desktop", "vendor", "python", "python.exe")
if not os.path.exists(PY):
    PY = sys.executable

PORT_A, PORT_B = 18443, 18444
PROXY_PORT, ADMIN_PORT = 18888, 18899
HOST_A, HOST_B = "127.0.0.1", "127.0.0.2"

fails = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + (("  " + extra) if extra and not cond else ""))
    if not cond:
        fails.append(label)


data = tempfile.mkdtemp(prefix="qr-scope-")
os.environ["QRSCAN_PROXY_DATA"] = data
store = certs.CertStore(data, log=lambda *a: None)


def serve_tls(host, port, handler):
    ctx = store.server_context(host)
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(4)

    def loop():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            try:
                c = ctx.wrap_socket(conn, server_side=True)
                c.recv(8192)
                c.sendall(handler())
                c.close()
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass

    threading.Thread(target=loop, daemon=True).start()
    return srv


# 上游 A：302 跳到另一个域；上游 B：200
serve_tls(HOST_A, PORT_A, lambda: (
    b"HTTP/1.1 302 Found\r\nLocation: https://" + HOST_B.encode() +
    b":" + str(PORT_B).encode() + b"/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
))
serve_tls(HOST_B, PORT_B, lambda: (
    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\n"
    b"Connection: close\r\n\r\nSECOND"
))

env = dict(os.environ)
env["QRSCAN_PROXY_DATA"] = data
proc = subprocess.Popen(
    [PY, os.path.join(HERE, "run_proxy.py"),
     "--port", str(PROXY_PORT), "--admin-port", str(ADMIN_PORT),
     "--no-ca-install", "--no-system-proxy",
     "--scope", HOST_A, "--ttl", "40"],
    cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)


def admin(path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (ADMIN_PORT, path), timeout=3) as r:
        return r.read()


ready = False
for _ in range(80):
    try:
        st = json.loads(admin("/status"))
        if st.get("ready"):
            ready = True
            break
    except Exception:
        pass
    time.sleep(0.25)     # 无条件等：管理口先起来、ready 后置位，空转会把 80 次瞬间用完
check(ready, "代理已就绪（收窄模式）")

# ---- C1：范围状态 ----
st = json.loads(admin("/status"))
check(st.get("proxy_all") is False, "C1 proxy_all=false（收窄模式生效）", json.dumps(st.get("proxy_all")))
check(HOST_A in (st.get("scope") or []), "C1 scope 含目标域", json.dumps(st.get("scope")))
check(st.get("scope_count") == len(st.get("scope") or []), "C1 scope_count 与列表一致")

# ---- C2：PAC 分流 ----
pac = admin("/proxy.pac").decode("utf-8", "replace")
check('"%s"' % HOST_A in pac, "C2 PAC 的 scope 数组含目标域")
check('return "DIRECT";' in pac, "C2 PAC 对非 scope 域返回 DIRECT")
check("PROXY 127.0.0.1:%d" % PROXY_PORT in pac, "C2 PAC 对 scope 域指向本地代理")

# ---- C3：302 之前/之后的范围变化 ----
def tls_through_proxy(host, port, path):
    raw = socket.create_connection(("127.0.0.1", PROXY_PORT), timeout=8)
    raw.sendall(b"CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n"
                % (host.encode(), port, host.encode(), port))
    head = raw.recv(512)
    if b"200" not in head.split(b"\r\n")[0]:
        raise RuntimeError("CONNECT 被拒: " + head[:80].decode("latin-1"))
    cc = ssl.create_default_context(cafile=os.path.join(data, "certs", "ca.crt"))
    cc.check_hostname = True
    tls = cc.wrap_socket(raw, server_hostname=host)
    tls.sendall(("GET %s HTTP/1.1\r\nHost: %s:%d\r\nConnection: close\r\n\r\n"
                 % (path, host, port)).encode())
    buf = b""
    while True:
        chunk = tls.recv(4096)
        if not chunk:
            break
        buf += chunk
    tls.close()
    return buf


resp = b""
try:
    resp = tls_through_proxy(HOST_A, PORT_A, "/start")
except Exception as e:
    check(False, "C3 第一跳请求成功", repr(e))
check(b"302" in resp.split(b"\r\n")[0], "C3 第一跳返回 302", resp[:80].decode("latin-1", "replace"))

# 关键断言：客户端还没发第二跳，范围就应该已经包含新域名
st2 = json.loads(admin("/status"))
check(HOST_B in (st2.get("scope") or []),
      "C3 302 返回时新域名已在 scope（同步学习成功）", json.dumps(st2.get("scope")))
check(st2.get("proxy_all") is False, "C3 学习没有把模式改回全量")

pac2 = admin("/proxy.pac").decode("utf-8", "replace")
check('"%s"' % HOST_B in pac2, "C4 PAC 已包含新域名", pac2[:200])

# ---- 第二跳可正常通过代理 ----
try:
    resp2 = tls_through_proxy(HOST_B, PORT_B, "/next")
    check(b"SECOND" in resp2, "C4 第二跳经代理取到内容", resp2[:80].decode("latin-1", "replace"))
except Exception as e:
    check(False, "C4 第二跳经代理取到内容", repr(e))

try:
    urllib.request.urlopen("http://127.0.0.1:%d/quit" % ADMIN_PORT, timeout=2).read()
except Exception:
    pass
time.sleep(1.2)
try:
    proc.terminate()
except Exception:
    pass
out = b""
try:
    out = proc.communicate(timeout=8)[0] or b""
except Exception:
    pass
tail = out.decode("utf-8", "replace")
for ln in tail.splitlines():
    if ln.startswith("[scope]") or ln.startswith("[sys]") or ln.startswith("[error]"):
        print("     " + ln)
print("数据目录:", data)
print("结果:", "ALL PASS" if not fails else ("HAS FAILURES: " + ", ".join(fails)))
shutil.rmtree(data, ignore_errors=True)
sys.exit(0 if not fails else 1)
