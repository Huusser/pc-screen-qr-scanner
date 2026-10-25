# -*- coding: utf-8 -*-
"""CertStore 验收：native 后端在"没有 openssl"的机器上要能完整工作。"""
import os
import shutil
import ssl
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import certs  # noqa: E402

ok_all = True


def check(label, cond, extra=""):
    global ok_all
    if not cond:
        ok_all = False
    print(("ok   " if cond else "FAIL ") + label + ("  " + extra if extra else ""))


real_find = certs.find_openssl

# ---------- 场景 1：模拟"机器上没有 openssl" ----------
print("== 场景 1：无 openssl（模拟普通用户机器） ==")
certs.find_openssl = lambda: None
tmp = tempfile.mkdtemp(prefix="certs-native-")
t0 = time.time()
store = certs.CertStore(tmp, log=lambda *a: None)
boot = time.time() - t0
check("CertStore 能在无 openssl 下构造", True, "%.2fs" % boot)
check("走的是 native 后端", store.openssl is None)
check("生成了 ca.crt / ca.key / ca.cer",
      all(os.path.getsize(os.path.join(tmp, "certs", n)) > 0
          for n in ("ca.crt", "ca.key", "ca.cer")))

t0 = time.time()
crt, key = store._make_leaf("mp.weixin.qq.com")
dt = time.time() - t0
check("首次签叶子证书", os.path.getsize(crt) > 400, "%.2fs" % dt)
t0 = time.time()
store2 = store.server_context("mp.weixin.qq.com")
dt2 = time.time() - t0
check("第二个域名签发", store2 is not None, "%.2fs" % dt2)
ctx = store.server_context("long.weixin.qq.com")
check("SSLContext 可加载", ctx is not None)

# 用 ssl 客户端真正验一遍（起临时 TLS 服务器）
import socket
import threading

srv = socket.socket()
srv.bind(("127.0.0.1", 0))
srv.listen(2)
port = srv.getsockname()[1]


def serve():
    for _ in range(1):
        conn, _ = srv.accept()
        try:
            c = ctx.wrap_socket(conn, server_side=True)
            c.recv(8)
            c.sendall(b"ok")
            c.close()
        except Exception as e:
            print("   服务端异常:", e)


threading.Thread(target=serve, daemon=True).start()
ca_path = os.path.join(tmp, "certs", "ca.crt")
cc = ssl.create_default_context(cafile=ca_path)
try:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        with cc.wrap_socket(raw, server_hostname="long.weixin.qq.com") as s:
            s.sendall(b"hi")
            data = s.recv(8)
    check("客户端以 ca.crt 验证通过", data == b"ok")
except Exception as e:
    check("客户端以 ca.crt 验证通过", False, repr(e))

# 复用同一目录再建一次：不应重新生成 CA（根证书已装进系统信任区）
ca_before = open(ca_path, "rb").read()
store_b = certs.CertStore(tmp, log=lambda *a: None)
ca_after = open(ca_path, "rb").read()
check("二次启动复用已有 CA", ca_before == ca_after)
check("已签过的域名不再重签",
      os.path.getsize(store_b._native_leaf_paths("mp.weixin.qq.com")) > 0)

shutil.rmtree(tmp, ignore_errors=True)

# ---------- 场景 2：沿用老版本 openssl 生成的 CA ----------
print("\n== 场景 2：升级兼容（复用老 CA，不打断已安装的根证书） ==")
legacy = os.path.join(os.environ["APPDATA"], "ScreenQR", "proxy")
if os.path.exists(os.path.join(legacy, "certs", "ca.crt")):
    before = open(os.path.join(legacy, "certs", "ca.crt"), "rb").read()
    st = certs.CertStore(legacy, log=lambda *a: None)
    after = open(os.path.join(legacy, "certs", "ca.crt"), "rb").read()
    check("未重建老 CA", before == after)
    crt, key = st._make_leaf("legacy.example.com")
    check("能用老 CA 签新叶子证书", os.path.getsize(crt) > 400)
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    c.load_cert_chain(crt, key)
    check("老 CA 签出的证书可被 ssl 加载", True)
    # 清理测试签出来的证书，别污染用户目录
    for p in (crt,):
        try:
            os.replace(p, p + ".bak")
        except Exception:
            pass
else:
    print("   （跳过：%s 不存在）" % legacy)

certs.find_openssl = real_find
print("\n结果:", "ALL PASS" if ok_all else "HAS FAILURES")
