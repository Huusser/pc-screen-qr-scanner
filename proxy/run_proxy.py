#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地代理管理器：让「桌面版微信」在打开网页时被服务器识别为移动端微信。

它做四件事：
1. 在本机 127.0.0.1:8888 起一个 mitmproxy（HTTPS 解密 + UA 改写，见 addon.py）。
2. 在 127.0.0.1:8899 提供 PAC 与一个极小的管理接口。
3. 把 Windows 系统代理指向 PAC（只影响走系统代理的程序，随时可还原）。
4. 动态维护"改写范围"：支持按域名收窄，也支持全量代理（默认，覆盖任意链接）。

用法：
    python run_proxy.py                      # 全量代理，UA=android
    python run_proxy.py --mode iphone        # 改用 iPhone UA
    python run_proxy.py --scope zhiye.com    # 只代理该域及其子域
    python run_proxy.py --restore            # 只还原系统代理
    python run_proxy.py --remove-ca          # 卸载根证书

由桌面端按需启动时（推荐用法，正常使用绝不启动）：
    python run_proxy.py --mode android --parent-pid <PID> --ttl 180
  --parent-pid  父进程消失就自动收尾并还原（防止桌面端被强杀后代理残留）
  --ttl         秒数到点自动收尾并还原

管理接口：
    GET /status                 当前状态
    GET /scope/add?host=x.com   追加代理范围
    GET /ua?mode=iphone         运行时切换 UA
    GET /quit                   退出并还原
"""
import argparse
import ctypes
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import winreg
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))     # 代码目录（只读）
# 数据目录（可写）：证书、状态、日志都落在这里。
# 桌面端通过 QRSCAN_PROXY_DATA 传入 %APPDATA%\ScreenQR\proxy；
# 单独用命令行跑时不传就退回 BASE，保持老用法不变。
DATA = os.environ.get("QRSCAN_PROXY_DATA") or BASE
try:
    os.makedirs(DATA, exist_ok=True)
except Exception:
    DATA = BASE

CERT_DIR = os.path.join(DATA, "certs")
STATE_FILE = os.path.join(DATA, "state.json")
LEARNED_FILE = os.path.join(DATA, "learned.json")
STATS_FILE = os.path.join(DATA, "stats.json")
PREV_FILE = os.path.join(DATA, "previous.json")
# 失败退出的原因（给人看的一句话）。桌面端在等待超时后读它，
# 把"启动超时或失败"换成真正的原因，否则用户只知道失败、不知道为什么。
EXIT_FILE = os.path.join(DATA, "last_exit.json")
MITM_LOG = os.path.join(DATA, "mitm.log")
CA_CER = os.path.join(CERT_DIR, "ca.cer")
CA_PEM = os.path.join(CERT_DIR, "ca.crt")
INSTALL_CA_PS1 = os.path.join(BASE, "install-ca.ps1")
MITM_PY = os.path.join(BASE, "mitm_proxy.py")

IE_KEY = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"

# 不劫持的域名：微信自身通信（含快速登录 14013）、支付、系统更新。
# 一旦 MITM 这些，微信可能连不上或误判环境，得不偿失。
EXCLUDE = [
    "qq.com", "weixin.com", "wechat.com", "tencent.com", "tenpay.com",
    "gtimg.cn", "qpic.cn", "qlogo.cn", "servicewechat.com", "weixinbridge.com",
    "wechatpay.cn", "wechatpay.com", "weixincloud.com",
    "microsoft.com", "windowsupdate.com", "msftconnecttest.com", "msftncsi.com",
    "localhost", "local",
]

STOP = threading.Event()
CTX = {
    "port": 8888,
    "admin_port": 8899,
    "ua_mode": "android",
    "proxy_all": True,
    "scope": [],
    "pac": "",
    "pac_lock": threading.Lock(),
    "dirty": False,
    "proxy_proc": None,
    "system_proxy_set": False,
    "parent_pid": 0,
    "ttl": 0,
    "ttl_deadline": 0.0,
    # 管理端口比"真正可用"更早就绪（证书、系统代理还在装）。
    # 拉起我的程序必须等这个为真，否则会抢在系统代理设置生效之前把链接打开。
    "ready": False,
}


def parent_alive(pid):
    """判断父进程是否还在。父进程被强杀时，本进程必须自己收尾还原系统代理。"""
    if not pid:
        return True
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return False
    try:
        code = ctypes.c_ulong()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


# ---------------- 系统代理（WinINET）----------------

def read_ie():
    out = {"ProxyEnable": None, "ProxyServer": None, "AutoConfigURL": None, "ProxyOverride": None}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, IE_KEY) as k:
            for name in list(out.keys()):
                try:
                    out[name] = winreg.QueryValueEx(k, name)[0]
                except FileNotFoundError:
                    out[name] = None
    except FileNotFoundError:
        pass
    return out


def write_ie(values):
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, IE_KEY, 0, winreg.KEY_SET_VALUE) as k:
        for name, val in values.items():
            if val is None:
                try:
                    winreg.DeleteValue(k, name)
                except FileNotFoundError:
                    pass
            elif isinstance(val, int):
                winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, val)
            else:
                winreg.SetValueEx(k, name, 0, winreg.REG_SZ, val)
    notify_wininet()


def notify_wininet():
    try:
        wininet = ctypes.windll.Wininet
        wininet.InternetSetOptionW(0, 39, 0, 0)  # SETTINGS_CHANGED
        wininet.InternetSetOptionW(0, 37, 0, 0)  # REFRESH
    except Exception:
        pass


def set_system_proxy(mode="pac", port=8888):
    if not os.path.exists(PREV_FILE):
        with open(PREV_FILE, "w", encoding="utf-8") as f:
            json.dump(read_ie(), f, ensure_ascii=False)
    if mode == "global":
        # 传统全局代理：个别客户端不认 PAC，但认这个。
        # 注意它**没有"只接管目标站"的能力**（ProxyOverride 做不了按域收窄），
        # 所以范围设置只在 PAC 模式下有意义，桌面端也会据此把范围选项置灰。
        write_ie({"ProxyEnable": 1,
                  "ProxyServer": "127.0.0.1:%d" % port,
                  "AutoConfigURL": None,
                  "ProxyOverride": "<local>"})
    else:
        write_ie({"AutoConfigURL": pac_url(), "ProxyEnable": 0})
    CTX["system_proxy_set"] = True
    CTX["proxy_mode"] = mode


def pac_url():
    """带版本号的 PAC 地址。

    为什么非要版本号：范围收窄后，新域名是"边跑边学"进来的（见 add_scope）。
    只改 PAC 的**内容**、URL 不变时，Chromium/WinINET 很可能继续用缓存里的旧脚本，
    结果学到的域名仍然直连 —— 表现就是"代理开着但页面还是 PC 版"。
    把版本号拼进查询串，等于换了个 URL，客户端不得不重新取一次。
    """
    return "http://127.0.0.1:%d/proxy.pac?v=%d" % (CTX["admin_port"],
                                                   CTX.get("pac_ver", 0))



def restore_system_proxy():
    if not os.path.exists(PREV_FILE):
        return False
    try:
        with open(PREV_FILE, "r", encoding="utf-8") as f:
            prev = json.load(f)
        write_ie(prev)
        os.remove(PREV_FILE)
        CTX["system_proxy_set"] = False
        return True
    except Exception as e:
        log("[warn] 还原系统代理失败: %s" % e)
        return False


# ---------------- PAC ----------------

def _js_array(items):
    return "[" + ",".join('"%s"' % i for i in items) + "]"


def build_pac():
    port = CTX["port"]
    ex = _js_array(EXCLUDE)
    if CTX["proxy_all"]:
        rule = 'return "PROXY 127.0.0.1:%d; DIRECT";' % port
        sc_js = "[]"
    else:
        sc_js = _js_array(CTX["scope"])
        rule = ('if (_m(host, sc)) return "PROXY 127.0.0.1:%d; DIRECT";\n  return "DIRECT";'
                % port)
    return """// 由 run_proxy.py 动态生成，勿手改
var EX = %s;
var sc = %s;
function _m(host, arr) {
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (host === e || host.slice(-(e.length + 1)) === "." + e) return true;
  }
  return false;
}
function FindProxyForURL(url, host) {
  host = (host || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return "DIRECT";
  if (_m(host, EX)) return "DIRECT";
  %s
}
""" % (ex, sc_js, rule)


def refresh_pac():
    with CTX["pac_lock"]:
        CTX["pac"] = build_pac()
        # 版本号一变，pac_url() 就变，客户端会被迫重新取脚本（见 pac_url 的注释）
        CTX["pac_ver"] = CTX.get("pac_ver", 0) + 1


def republish_pac():
    """范围变了之后，把新的 PAC 地址重新写进系统代理。

    只在"已经设过 PAC"时才需要；没设过（--no-system-proxy）就只刷内存里的脚本。
    """
    if CTX.get("system_proxy_set") and CTX.get("proxy_mode") == "pac":
        write_ie({"AutoConfigURL": pac_url()})   # write_ie 内部会 notify_wininet
    else:
        notify_wininet()



# ---------------- 管理接口 ----------------

class AdminHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path == "/proxy.pac":
            with CTX["pac_lock"]:
                pac = CTX["pac"]
            self._send(200, pac, "application/x-ns-proxy-autoconfig; charset=utf-8")
            return

        if path == "/status":
            stats = {}
            try:
                with open(STATS_FILE, "r", encoding="utf-8") as f:
                    stats = json.load(f)
            except Exception:
                pass
            self._send(200, json.dumps({
                "ok": True,
                "ready": CTX["ready"],
                "listen": CTX["port"],
                "ua_mode": CTX["ua_mode"],
                "proxy_all": CTX["proxy_all"],
                "scope": CTX["scope"],
                "scope_count": len(CTX["scope"]),
                "system_proxy": CTX["system_proxy_set"],
                "ttl": CTX["ttl"],
                "remain": max(0, int(CTX["ttl_deadline"] - time.time())) if CTX["ttl_deadline"] else 0,
                "parent_pid": CTX["parent_pid"],
                "stats": stats,
            }, ensure_ascii=False))
            return

        if path == "/scope/add":
            host = (q.get("host") or [""])[0].strip().lower()
            if host:
                add_scope([host])
                self._send(200, json.dumps({"ok": True, "scope": CTX["scope"]}))
            else:
                self._send(400, json.dumps({"ok": False, "error": "host required"}))
            return

        if path == "/ua":
            mode = (q.get("mode") or [""])[0].strip().lower()
            if mode in ("android", "iphone"):
                CTX["ua_mode"] = mode
                write_state()
                log("[ua] 切换为 %s" % mode)
                self._send(200, json.dumps({"ok": True, "ua_mode": mode}))
            else:
                self._send(400, json.dumps({"ok": False, "error": "mode=android|iphone"}))
            return

        if path == "/quit":
            self._send(200, json.dumps({"ok": True, "bye": True}))
            STOP.set()
            return

        self._send(404, json.dumps({"ok": False}))


def start_admin():
    srv = ThreadingHTTPServer(("127.0.0.1", CTX["admin_port"]), AdminHandler)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ---------------- 状态 ----------------

def log(msg):
    print(msg, flush=True)


def write_state():
    data = {
        "ua_mode": CTX["ua_mode"],
        "proxy_all": CTX["proxy_all"],
        "scope": CTX["scope"],
    }
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def add_scope(hosts):
    changed = False
    for h in hosts:
        h = (h or "").strip().lower()
        if not h or h in CTX["scope"]:
            continue
        if any(h == e or h.endswith("." + e) for e in EXCLUDE):
            continue
        CTX["scope"].append(h)
        changed = True
    if changed:
        CTX["proxy_all"] = False
        write_state()
        refresh_pac()
        republish_pac()
        log("[scope] 已加入: %s" % ", ".join(CTX["scope"]))
    return changed


def merge_learned():
    """把 addon 学到的跳转域名并入范围（扫码登录常跨域）。"""
    if CTX["proxy_all"]:
        return
    try:
        with open(LEARNED_FILE, "r", encoding="utf-8") as f:
            learned = json.load(f)
    except Exception:
        return
    add_scope(list(learned.keys()))


# ---------------- 证书 ----------------

def write_exit(code, error):
    """记下"为什么退出"。

    只写失败原因，不写成功；桌面端读不到（或读到过期的）就回落到通用文案。
    """
    try:
        with open(EXIT_FILE, "w", encoding="utf-8") as f:
            json.dump({"code": int(code), "error": error or "",
                       "time": time.strftime("%Y-%m-%dT%H:%M:%S")}, f,
                      ensure_ascii=False)
    except Exception as e:
        log("[exit] 写失败原因失败: %s" % e)


def install_ca():
    """把根证书装进「当前用户\受信任的根证书颁发机构」。

    返回 (ok, reason)。reason 是给人看的一句话，ok=False 时由调用方写进
    last_exit.json，最终显示在桌面端的提示里。

    三种失败都要区分出来，否则用户只会看到"启动失败"：
      - 证书/脚本不在（安装包残缺、被安全软件删了）
      - powershell 调不起来（被组策略或杀软拦、PATH 异常）
      - 脚本报 FAIL（写 Root 存储被拒，最常见的是非管理员 + 组策略）
    """
    if not os.path.exists(CA_CER):
        log("[ca] 未找到证书文件: %s" % CA_CER)
        return False, "未找到根证书文件 ca.cer"
    if not os.path.exists(INSTALL_CA_PS1):
        log("[ca] 缺少 install-ca.ps1")
        return False, "缺少安装脚本 install-ca.ps1"
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", INSTALL_CA_PS1, "-CerPath", CA_CER],
            capture_output=True, text=True, errors="replace", timeout=60,
        )
        out = (r.stdout or "").strip()
        log("[ca] %s" % (out or r.stderr.strip()))
        if "OK" not in out:
            detail = out or (r.stderr or "").strip()
            return False, ("安装脚本执行失败" + ("：" + detail if detail else ""))
    except FileNotFoundError:
        log("[ca] 找不到 powershell")
        return False, "无法执行 powershell（可能被安全软件拦截）"
    except Exception as e:
        log("[ca] 安装失败: %s" % e)
        return False, "安装异常：%s" % e

    # 脚本说 OK 不等于真的进库：个别安全软件会在写入后立刻回滚。
    # 装完再以只读方式回查一次，确认能在存储里看到这张证书。
    seen = verify_ca()
    if seen is False:
        return False, "证书未能进入「受信任的根证书」存储（可能被安全软件拦截）"
    return True, ""


def verify_ca():
    """回查根证书是否真的在 CurrentUser\\Root 里。

    返回 True/False；查不动（脚本缺失、powershell 不可用）时返回 None，
    表示"无法确认"——这种情况不阻塞启动，只在日志里留一条。
    """
    if not os.path.exists(INSTALL_CA_PS1) or not os.path.exists(CA_CER):
        return None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", INSTALL_CA_PS1, "-CerPath", CA_CER, "-Verify"],
            capture_output=True, text=True, errors="replace", timeout=60,
        )
        out = (r.stdout or "").strip()
        log("[ca] 回查: %s" % (out or (r.stderr or "").strip()))
        if "OK PRESENT" in out:
            return True
        if "ABSENT" in out:
            return False
        return None
    except Exception as e:
        log("[ca] 回查失败: %s" % e)
        return None


def remove_ca():
    if not os.path.exists(INSTALL_CA_PS1):
        return False
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", INSTALL_CA_PS1, "-CerPath", CA_CER, "-Remove"],
            capture_output=True, text=True, errors="replace", timeout=60,
        )
        log("[ca] %s" % (r.stdout or r.stderr).strip())
        return True
    except Exception as e:
        log("[ca] 卸载失败: %s" % e)
        return False


# ---------------- mitmproxy ----------------

def pids_listening(port):
    """列出所有在监听该端口的 PID。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                              errors="replace", timeout=15).stdout
    except Exception:
        return []
    res = []
    for ln in (out or "").splitlines():
        if "LISTENING" not in ln.upper():
            continue
        parts = ln.split()
        if len(parts) < 5:
            continue
        if parts[1].endswith(":" + str(port)):
            try:
                res.append(int(parts[-1]))
            except ValueError:
                pass
    return res


def process_cmdline(pid):
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d').CommandLine" % pid],
            capture_output=True, text=True, errors="replace", timeout=20)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def kill_stale(port, script_name):
    """端口被上一次异常退出留下的自己人占着时，先清掉。

    这是"网页打不开"的另一个隐藏原因：旧进程还listen在 8888，
    新代理绑不上端口，但流程照样把系统代理指向 8888 —— 流量全都
    进了那个旧进程（老代码、证书签不出来），于是每个页面都异常。
    只杀命令行里确实带本脚本名的进程，绝不误伤别人的程序。
    """
    killed = []
    for pid in pids_listening(port):
        if pid == os.getpid():
            continue
        cmd = process_cmdline(pid)
        if script_name not in cmd:
            continue
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True, timeout=15)
            killed.append(pid)
            log("[clean] 清理残留进程 PID=%d（%s）" % (pid, script_name))
        except Exception as e:
            log("[clean] 清理 PID=%d 失败: %s" % (pid, e))
    return killed


def start_mitm():
    os.makedirs(CERT_DIR, exist_ok=True)
    kill_stale(CTX["port"], "mitm_proxy.py")
    # 清掉自己人之后还绑不上，就是别人占着（Fiddler/Charles 默认 8888）。
    # 这里先判一次，免得拉起子进程再等它崩，日志里也只剩一句 traceback。
    if port_busy(CTX["port"]):
        log("[error] 端口 %d 已被其他程序占用" % CTX["port"])
        return False
    args = [
        sys.executable, MITM_PY,
        "--port", str(CTX["port"]),
        # 把管理口交给它：收窄模式下它要能在返回 302 之前
        # 把跳转目标域同步推给 /scope/add（见 mitm_proxy.learn）
        "--admin-port", str(CTX["admin_port"]),
        "--scope-mode", "0" if CTX["proxy_all"] else "1",
        # 把父进程 PID 交给它：父进程一旦消失，它自己也退出，不留孤儿占端口
        "--parent-pid", str(os.getpid()),
    ]
    logf = open(MITM_LOG, "wb")
    p = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=BASE)
    CTX["proxy_proc"] = p
    # 等代理起来并生成 CA（首次会现场签一张根证书）
    for _ in range(150):
        if os.path.exists(CA_CER):
            break
        if p.poll() is not None:
            log("[error] 代理启动失败，见 %s" % MITM_LOG)
            return False
        time.sleep(0.2)
    # 再确认端口真的能连上
    for _ in range(50):
        if port_open("127.0.0.1", CTX["port"]):
            return True
        time.sleep(0.1)
    log("[error] 端口 %d 未就绪" % CTX["port"])
    return False


def port_open(host, port, timeout=1.0):
    import socket as _s
    try:
        with _s.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def port_busy(port):
    """这个端口现在能不能自己绑上（绑不上＝被别的程序占着）。

    注意不是"能不能连上"：没人监听的端口连不上，但可以绑；
    TIME_WAIT 的端口在 Windows 上也能绑（SO_REUSEADDR 语义）。
    """
    import socket as _s
    s = _s.socket(_s.AF_INET, _s.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", int(port)))
        return False
    except OSError:
        return True
    finally:
        try:
            s.close()
        except Exception:
            pass


def stop_mitm():
    p = CTX.get("proxy_proc")
    if not p:
        return
    try:
        p.terminate()
        p.wait(timeout=5)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


# ---------------- 主流程 ----------------

def run(args):
    CTX["port"] = args.port
    CTX["admin_port"] = args.admin_port
    CTX["ua_mode"] = args.mode
    CTX["proxy_all"] = not args.scope
    CTX["scope"] = [s.strip().lower() for s in (args.scope or []) if s.strip()]
    CTX["parent_pid"] = max(0, int(getattr(args, "parent_pid", 0) or 0))
    CTX["ttl"] = max(0, int(getattr(args, "ttl", 0) or 0))
    CTX["ttl_deadline"] = time.time() + CTX["ttl"] if CTX["ttl"] else 0.0

    write_state()
    for f in (LEARNED_FILE, STATS_FILE, EXIT_FILE):
        try:
            if os.path.exists(f):
                os.remove(f)
        except Exception:
            pass
    # 管理端口如果被上一次残留的自己人占着，先清掉，否则新实例绑不上，
    # 桌面端会看到"代理已启动"但 /status 一直是旧进程在应答。
    kill_stale(CTX["admin_port"], "run_proxy.py")

    refresh_pac()
    # 先自己判一次管理口：HTTPServer 默认带 SO_REUSEADDR，Windows 上这会
    # 允许"两个程序同时监听同一端口"（谁收包不确定），所以不能只靠 bind 抛错。
    if port_busy(CTX["admin_port"]):
        msg = ("管理端口 %d 已被其他程序占用，无法提供 PAC 与管理接口。"
               "可换端口重试：--admin-port 8890" % CTX["admin_port"])
        log("[error] " + msg)
        write_exit(1, msg)
        return 1
    try:
        start_admin()
    except OSError as e:
        msg = ("管理端口 %d 无法监听（可能被其他程序占用）：%s。"
               "可换端口重试：--admin-port 8890" % (CTX["admin_port"], e))
        log("[error] " + msg)
        write_exit(1, msg)
        return 1
    log("[pac] http://127.0.0.1:%d/proxy.pac" % CTX["admin_port"])

    if not start_mitm():
        if port_busy(CTX["port"]):
            msg = ("端口 %d 已被其他程序占用（Fiddler / Charles 等调试代理常用 8888），"
                   "关掉它们或换端口（--port 8889）后重试。" % CTX["port"])
        else:
            msg = ("本地代理进程未能启动，详见 %s（常见原因：运行时被安全软件隔离）。"
                   % MITM_LOG)
        log("[error] " + msg)
        write_exit(2, msg)
        return 2
    log("[mitm] 已启动 127.0.0.1:%d" % CTX["port"])

    # 证书必须真的装上，否则后面把系统代理指过来就等于让整机 HTTPS 报错。
    # 所以这一步在"设系统代理"之前，失败就当场收尾，绝不留半开状态。
    if not args.no_ca_install:
        ok, reason = install_ca()
        if not ok:
            msg = "根证书未能安装：%s。已停止启用移动端环境，系统代理未改动。" % reason
            log("[ca] 失败，停止启动 —— %s" % reason)
            stop_mitm()
            restore_system_proxy()   # 幂等：顺带清掉上次可能残留的设置
            write_exit(4, msg)
            log("[exit] 已停止（未设置系统代理）")
            return 4

    if not args.no_system_proxy:
        set_system_proxy("global" if args.global_proxy else "pac", CTX["port"])
        if args.global_proxy:
            log("[sys] 系统代理已设置（全局代理）—— 此模式不支持按域收窄，全量接管")
        else:
            log("[sys] 系统代理已设置（PAC，%s）"
                % ("全量" if CTX["proxy_all"] else "只接管 %d 个域" % len(CTX["scope"])))
            log("[sys] PAC 地址: %s" % pac_url())
        log("[sys] 若微信内不生效：完全退出微信后重新打开（设置只在启动时读取）")

    log("[ua] 当前 UA = %s（切换：http://127.0.0.1:%d/ua?mode=iphone）"
        % (CTX["ua_mode"], CTX["admin_port"]))
    log("[scope] %s" % ("全量（排除腾讯/系统域名）" if CTX["proxy_all"]
                        else ", ".join(CTX["scope"])))
    log("[hint] 按 Ctrl+C 或访问 /quit 退出；退出会自动还原系统代理")

    # 证书装好、系统代理设好之后才对外宣布"可用"
    CTX["ready"] = True
    log("[ready] 可以开始使用了")

    last_report = 0.0
    try:
        while not STOP.is_set():
            merge_learned()

            # 出口一：TTL 到点（桌面端正常会先一步发 /quit，这里是兜底）
            if CTX["ttl_deadline"] and time.time() >= CTX["ttl_deadline"]:
                log("[guard] 到达自动关闭时间（%ds），开始收尾" % CTX["ttl"])
                break

            # 出口二：拉起我的程序没了（被强杀 / 崩溃），必须自己还原系统代理
            if CTX["parent_pid"] and not parent_alive(CTX["parent_pid"]):
                log("[guard] 父进程 %d 已退出，开始收尾" % CTX["parent_pid"])
                break

            now = time.time()
            if now - last_report >= 3:
                last_report = now
                try:
                    with open(STATS_FILE, "r", encoding="utf-8") as f:
                        s = json.load(f)
                    log("[stat] 已改写 %d 次 · 最近: %s" % (s.get("rewritten", 0), s.get("last") or "-"))
                except Exception:
                    pass
            time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        log("[exit] 正在还原...")
        stop_mitm()
        if not args.no_system_proxy:
            restore_system_proxy()
        log("[exit] 完成")
        # 若是被外部 /quit 触发，直接退出进程
        if STOP.is_set() and args.quit_exit:
            os._exit(0)
    return 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--port", type=int, default=8888)
    ap.add_argument("--admin-port", type=int, default=8899)
    ap.add_argument("--mode", choices=["android", "iphone"], default="android")
    ap.add_argument("--scope", default="", help="逗号分隔的域名，留空=全量代理")
    ap.add_argument("--no-ca-install", action="store_true")
    ap.add_argument("--no-system-proxy", action="store_true")
    ap.add_argument("--global-proxy", action="store_true",
                    help="用传统全局代理代替 PAC（个别客户端不认 PAC 时用）")
    ap.add_argument("--restore", action="store_true", help="只还原系统代理后退出")
    ap.add_argument("--remove-ca", action="store_true", help="卸载根证书后退出")
    ap.add_argument("--parent-pid", type=int, default=0,
                    help="拉起我的进程 PID；它消失时自动收尾并还原")
    ap.add_argument("--ttl", type=int, default=0,
                    help="自动关闭倒计时（秒），0=不限")
    ap.add_argument("--quit-exit", action="store_true", default=True)
    args = ap.parse_args()

    if args.scope:
        args.scope = args.scope.split(",")

    if args.restore:
        # 先尝试让运行中的实例自己退出（它会顺手还原）。
        # 管理端口现在是启动时现挑的（桌面端会顺延），所以从默认口往上扫一段，
        # 否则 `restore-proxy-now.bat` 在端口顺延过之后就找不到实例了。
        hit = 0
        for p in range(args.admin_port, args.admin_port + 20):
            try:
                urllib.request.urlopen(
                    "http://127.0.0.1:%d/quit" % p, timeout=1).read()
                hit = p
                log("[restore] 已通知实例退出（管理口 %d）" % p)
            except Exception:
                continue
        if hit:
            time.sleep(1)
        ok = restore_system_proxy()
        log("[restore] %s" % ("已还原" if ok else "没有需要还原的设置"))
        if args.remove_ca:
            remove_ca()
        return 0

    if args.remove_ca:
        remove_ca()
        return 0

    try:
        return run(args)
    finally:
        pass


if __name__ == "__main__":
    sys.exit(main())
