# -*- coding: utf-8 -*-
"""P1-A 验收：端口被占用时必须"说清原因"，而不是整体失败或只报超时。

两条断言：
  B1  代理口（默认 8888）被别人占着 → 退出码 2，last_exit.json 写明"已被其他程序占用"
  B2  管理口被占着 → 退出码 1，原因写明"管理端口 … 无法监听"
两条都要求：没有设置系统代理、没有留下 previous.json。

占用由本进程自己 listen 制造（模拟 Fiddler 占 8888），全程临时数据目录，不装证书、不碰注册表。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(HERE), "desktop", "vendor", "python", "python.exe")
if not os.path.exists(PY):
    PY = sys.executable

fails = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + (("  " + extra) if extra and not cond else ""))
    if not cond:
        fails.append(label)


def occupy(port):
    # 故意**不加** SO_REUSEADDR：Fiddler 这类程序不会加，而加了之后
    # Windows 允许两个进程同时监听同一端口（谁收包不确定），测不出真实场景。
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", port))
    s.listen(4)
    return s


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def read_exit(data):
    try:
        with open(os.path.join(data, "last_exit.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def run_proxy(data, port, admin_port):
    env = dict(os.environ)
    env["QRSCAN_PROXY_DATA"] = data
    return subprocess.run(
        [PY, os.path.join(HERE, "run_proxy.py"),
         "--port", str(port), "--admin-port", str(admin_port),
         "--no-ca-install", "--no-system-proxy", "--ttl", "5"],
        cwd=HERE, env=env, capture_output=True, text=True, errors="replace", timeout=60,
    )


# ---------------- B1：代理口被占 ----------------
d1 = tempfile.mkdtemp(prefix="qr-port1-")
try:
    s1 = occupy(8888)
except OSError as e:
    print("skip  B1 8888 已被系统里别的程序占着，无法制造场景: %s" % e)
    s1 = None
if s1 is not None:
    p1 = run_proxy(d1, 8888, free_port())
    e1 = read_exit(d1)
    check(p1.returncode == 2, "B1 代理口被占 → 退出码 2", "rc=%r" % p1.returncode)
    msg = e1.get("error") or ""
    check("8888" in msg and "占用" in msg, "B1 原因写明端口被占用", repr(msg))
    check(e1.get("code") == 2, "B1 last_exit.json 的 code 同步", repr(e1))
    check(not os.path.exists(os.path.join(d1, "previous.json")),
          "B1 未留下 previous.json（系统代理没被改过）")
    s1.close()

# ---------------- B2：管理口被占 ----------------
d2 = tempfile.mkdtemp(prefix="qr-port2-")
admin = free_port()
try:
    s2 = occupy(admin)
except OSError as e:
    print("skip  B2 无法占用临时管理口: %s" % e)
    s2 = None
if s2 is not None:
    p2 = run_proxy(d2, free_port(), admin)
    e2 = read_exit(d2)
    check(p2.returncode == 1, "B2 管理口被占 → 退出码 1", "rc=%r" % p2.returncode)
    msg2 = e2.get("error") or ""
    check("管理端口" in msg2 and str(admin) in msg2, "B2 原因写明管理端口无法监听", repr(msg2))
    check(not os.path.exists(os.path.join(d2, "previous.json")),
          "B2 未留下 previous.json（系统代理没被改过）")
    s2.close()

print("数据目录:", d1, d2)
print("结果:", "ALL PASS" if not fails else ("HAS FAILURES: " + ", ".join(fails)))
shutil.rmtree(d1, ignore_errors=True)
shutil.rmtree(d2, ignore_errors=True)
sys.exit(0 if not fails else 1)
