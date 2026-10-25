# -*- coding: utf-8 -*-
"""P0-A 验收：根证书装不上时必须"停手"，而不是假装成功。

为什么单独写这个测试：这个缺陷的后果是「整机 HTTPS 全红 + 提示成功」，
属于最容易被当成病毒的失败模式，而它只在"装证书失败"的机器上出现，
正常机器永远测不到。所以用注入故障的方式直接验判定逻辑。

三条断言，全程临时目录，不装证书、不改系统代理：
  A1  install_ca() 失败时返回 (False, 人话原因)，不再是一个裸 False
  A2  run() 在证书失败时返回 4：ready 不置位、不写系统代理、不留 previous.json、
      并写下 last_exit.json（桌面端据此显示原因）
  A3  装完回查 -Verify 能分辨"真在库里"与"不在库里"
"""
import json
import os
import shutil
import sys
import tempfile
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

fails = []


def check(cond, label, extra=""):
    print(("ok   " if cond else "FAIL ") + label + (("  " + extra) if extra and not cond else ""))
    if not cond:
        fails.append(label)


tmp = tempfile.mkdtemp(prefix="qr-caguard-")
import run_proxy as rp  # noqa: E402

# ---- A1：三种失败各有可读原因 ----
real_cer, real_ps1 = rp.CA_CER, rp.INSTALL_CA_PS1
# 真实存在的那张证书（%APPDATA%\ScreenQR\proxy\certs\ca.cer）：
# 源码目录里的 proxy/certs 已被开源清理移走，所以不能拿它当"存在"的样本。
live_ca = os.path.join(os.environ.get("APPDATA", ""), "ScreenQR", "proxy", "certs", "ca.cer")

rp.CA_CER = os.path.join(tmp, "nope.cer")
ok, why = rp.install_ca()
check(ok is False and "ca.cer" in why, "A1 缺证书文件 → False + 原因", repr(why))

rp.CA_CER = live_ca if os.path.exists(live_ca) else real_cer
rp.INSTALL_CA_PS1 = os.path.join(tmp, "nope.ps1")
ok, why = rp.install_ca()
check(ok is False and "install-ca.ps1" in why, "A1 缺安装脚本 → False + 原因", repr(why))

rp.INSTALL_CA_PS1 = real_ps1

# ---- A2：run() 的判定（把副作用全部替换成探针）----
calls = []
rp.EXIT_FILE = os.path.join(tmp, "last_exit.json")
rp.STATE_FILE = os.path.join(tmp, "state.json")
rp.LEARNED_FILE = os.path.join(tmp, "learned.json")
rp.STATS_FILE = os.path.join(tmp, "stats.json")
rp.PREV_FILE = os.path.join(tmp, "previous.json")
rp.start_mitm = lambda: True
rp.stop_mitm = lambda: calls.append("stop_mitm")
rp.install_ca = lambda: (False, "模拟：写入根存储被拒绝")
rp.start_admin = lambda: None
rp.refresh_pac = lambda: None
rp.kill_stale = lambda *a, **k: []
rp.merge_learned = lambda: None
rp.parent_alive = lambda pid: True
rp.set_system_proxy = lambda *a, **k: calls.append("set_system_proxy")
rp.restore_system_proxy = lambda: calls.append("restore_system_proxy")
rp.log = lambda msg: None

args = SimpleNamespace(
    port=18888, admin_port=18899, mode="android", scope="",
    no_ca_install=False, no_system_proxy=False, global_proxy=False,
    parent_pid=0, ttl=0, quit_exit=False,
)
rp.CTX["ready"] = False
rc = rp.run(args)

check(rc == 4, "A2 证书失败 → 退出码 4", "rc=%r" % rc)
check(rp.CTX["ready"] is False, "A2 ready 未被置位（桌面端不会认为启动成功）")
check("set_system_proxy" not in calls, "A2 没有把系统代理指到本地代理", repr(calls))
check("stop_mitm" in calls, "A2 已收掉 mitm 子进程", repr(calls))
check("restore_system_proxy" in calls, "A2 兜底还原了一次系统代理", repr(calls))
check(not os.path.exists(rp.PREV_FILE), "A2 未留下 previous.json")

info = {}
try:
    with open(rp.EXIT_FILE, "r", encoding="utf-8") as f:
        info = json.load(f)
except Exception as e:
    info = {"_err": repr(e)}
check(info.get("code") == 4 and "根证书未能安装" in (info.get("error") or ""),
      "A2 last_exit.json 写下了可读原因", repr(info))
check(bool(info.get("time")), "A2 last_exit.json 带时间戳（桌面端判新旧）", repr(info.get("time")))

# 成功路径回归：install_ca 返回 True 时不应误判为失败
rp.install_ca = lambda: (True, "")
ran = {"system": 0}


def fake_set(*a, **k):
    ran["system"] += 1
    rp.STOP.set()          # 立刻结束主循环，只验"有没有走到设系统代理这一步"


rp.set_system_proxy = fake_set
rp.CTX["ready"] = False
rp.STOP.clear()
rc2 = rp.run(args)
check(rc2 == 0 and rp.CTX["ready"] is True and ran["system"] == 1,
      "A2' 证书成功时照旧置 ready 并设置系统代理", "rc=%r ready=%r set=%r"
      % (rc2, rp.CTX["ready"], ran["system"]))

# ---- A3：回查真的能分辨"在库/不在库" ----
# 用真正被装进系统的那张证书（%APPDATA%\ScreenQR\proxy\certs\ca.cer）
rp.CA_CER, rp.INSTALL_CA_PS1 = live_ca, real_ps1
if os.path.exists(live_ca):
    got = rp.verify_ca()
    check(got is True, "A3 已装证书回查 → PRESENT", repr(got))
else:
    print("skip  A3 本机没有 %s" % live_ca)

sys.path.insert(0, HERE)
import certs  # noqa: E402

fresh = os.path.join(tmp, "fresh")
try:
    certs.CertStore(fresh, log=lambda *a: None)
except Exception as e:
    print("skip  A3 生成临时 CA 失败: %r" % (e,))
else:
    rp.CA_CER = os.path.join(fresh, "certs", "ca.cer")
    got = rp.verify_ca()
    check(got is False, "A3 未装过的证书回查 → ABSENT", repr(got))

print("数据目录:", tmp)
print("结果:", "ALL PASS" if not fails else ("HAS FAILURES: " + ", ".join(fails)))
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if not fails else 1)
