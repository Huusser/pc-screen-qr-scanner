#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
零依赖 HTTPS 中间人代理：只做一件事——把「桌面版微信」的 User-Agent 换成移动微信 UA。

设计取舍（都是为了"任意链接都能用"）：
1. 判定条件与域名无关：只要 UA 里同时有 MicroMessenger 和桌面平台标记（Windows NT /
   WindowsWechat / Macintosh），就改写。换多少个业务系统都不用改代码。
2. 只改写请求头里的 User-Agent（并清掉自相矛盾的 sec-ch-ua 系列），
   请求体、响应体一个字节都不动。
3. 非桌面微信流量（普通浏览器、微信自身 API）原样透传，不做任何解析。
4. 腾讯系域名直接走隧道不解密，避免影响微信自身的连接与快速登录通道。
5. HTTP/1.1 + 强制 Connection: close：牺牲一点性能，换实现简单与行为可预测。
"""
import argparse
import html
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from socketserver import ThreadingTCPServer, BaseRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from certs import CertStore  # noqa: E402

# 数据目录（可写）。由 run_proxy.py 通过 QRSCAN_PROXY_DATA 传下来；
# 单独跑时退回代码目录，保持老用法。
DATA = os.environ.get("QRSCAN_PROXY_DATA") or BASE
try:
    os.makedirs(DATA, exist_ok=True)
except Exception:
    DATA = BASE

STATE_FILE = os.path.join(DATA, "state.json")
LEARNED_FILE = os.path.join(DATA, "learned.json")
STATS_FILE = os.path.join(DATA, "stats.json")
DEBUG_LOG = os.path.join(DATA, "proxy-debug.log")

# 收窄模式下，跳到新域名时必须**在把 302 写回客户端之前**让父进程把该域加进
# PAC 范围。否则客户端拿到 302 立刻查 PAC，那时范围还没更新 → 新域走直连，
# 页面回到 PC 版（这就是"默认只接管目标站"最大的坑）。
# 这两个值由 run_proxy.py 通过命令行传进来；不去猜、也不从文件里读。
ADMIN_PORT = 0          # 0 = 未启用（全量模式）
SCOPE_MODE = False

# 请求日志粒度（隐私）：off 不记（默认）| host 只记域名 | full 记完整路径
# full 会把用户访问的完整 URL（含查询串）明文落盘，所以不是默认值。
LOG_MODE = (os.environ.get("QRSCAN_PROXY_LOG") or "off").strip().lower()
if LOG_MODE not in ("off", "host", "full"):
    LOG_MODE = "off"
LOG_MAX_BYTES = 2 * 1024 * 1024      # 日志上限 2MB，超了直接从头上截断

UA_ANDROID = (
    "Mozilla/5.0 (Linux; Android 13; SM-S9180 Build/TP1A.220624.014; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 "
    "Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20231202 MMWEBID/1234 "
    "MicroMessenger/8.0.47.2560(0x28002F30) WeChat/arm64 Weixin NetType/WIFI "
    "Language/zh_CN ABI/arm64"
)
UA_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.47(0x18002f2c) NetType/WIFI Language/zh_CN"
)
UA_MAP = {"android": UA_ANDROID, "iphone": UA_IPHONE}

# 不解密的域名：微信自身通信（含快速登录 14013）、支付、系统更新
EXCLUDE = (
    "qq.com", "weixin.com", "wechat.com", "tencent.com", "tenpay.com",
    "gtimg.cn", "qpic.cn", "qlogo.cn", "servicewechat.com", "weixinbridge.com",
    "wechatpay.cn", "wechatpay.com", "weixincloud.com",
    "microsoft.com", "windowsupdate.com", "msftconnecttest.com", "msftncsi.com",
    "localhost", "local",
)

_WX = re.compile(rb"MicroMessenger", re.I)
_DESKTOP_MARKERS = (b"WindowsWechat", b"Windows NT", b"MacWechat", b"Macintosh", b"wechatdevtools")
_UA_LINE = re.compile(rb"(?im)^user-agent:\s*(.*?)\s*$")
_HINT_LINES = re.compile(rb"(?im)^(sec-ch-ua[^\r\n]*|device-memory:[^\r\n]*|dpr:[^\r\n]*|viewport-width:[^\r\n]*)\r\n")

CTX = {
    "ua_mode": "android",
    "proxy_all": True,
    "scope": [],
    "rewritten": 0,
    "hosts": {},
    "last": "",
}
_lock = threading.Lock()
_last_flush = [0.0]


_rotated = [False]


def _host_only(msg):
    """把 'REWRITE host GET /path?q=1 HTTP/1.1' 压成 'REWRITE host'。

    host 模式是为排查"某个域名没有被改写"用的：域名够定位问题，
    路径与查询串只会泄露用户看了什么页面。
    """
    parts = str(msg).split(" ")
    if len(parts) >= 2:
        return "%s %s" % (parts[0], parts[1])
    return str(msg)


def _rotate_if_needed():
    """超过上限就只留最后一半 —— 不新建文件，用户点"清空日志"才彻底删。"""
    if _rotated[0]:
        return
    _rotated[0] = True
    try:
        if not os.path.exists(DEBUG_LOG):
            return
        if os.path.getsize(DEBUG_LOG) <= LOG_MAX_BYTES:
            return
        with open(DEBUG_LOG, "rb") as f:
            f.seek(-(LOG_MAX_BYTES // 2), os.SEEK_END)
            tail = f.read()
        with open(DEBUG_LOG, "wb") as f:
            f.write(tail)
    except Exception:
        pass


def log(msg):
    # off：一个字节都不写（默认）。这是隐私默认值，别改成 host。
    if LOG_MODE == "off":
        return
    line = _host_only(msg) if LOG_MODE == "host" else msg
    try:
        _rotate_if_needed()
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), line))
    except Exception:
        pass


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        with _lock:
            CTX["ua_mode"] = data.get("ua_mode", "android")
            CTX["proxy_all"] = bool(data.get("proxy_all", True))
            CTX["scope"] = [str(s).lower() for s in (data.get("scope") or [])]
    except Exception:
        pass


def host_excluded(host):
    h = host.lower()
    return any(h == e or h.endswith("." + e) for e in EXCLUDE)


def host_in_scope(host):
    if CTX["proxy_all"]:
        return True
    h = host.lower()
    for s in CTX["scope"]:
        if not s:
            continue
        if s == "*" or h == s or h.endswith("." + s):
            return True
    return False


def flush_stats(force=False):
    now = time.time()
    if not force and now - _last_flush[0] < 1.0:
        return
    _last_flush[0] = now
    try:
        with _lock:
            data = {
                "rewritten": CTX["rewritten"],
                "hosts": dict(CTX["hosts"]),
                "last": CTX["last"],
                "ua_mode": CTX["ua_mode"],
                "ts": int(now),
            }
        tmp = STATS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, STATS_FILE)
    except Exception:
        pass


def learn(host):
    if not host or "." not in host or host_excluded(host):
        return
    try:
        data = {}
        if os.path.exists(LEARNED_FILE):
            with open(LEARNED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        if host in data:
            warm_cert(host)
            push_scope(host)
            return
        data[host.lower()] = int(time.time())
        tmp = LEARNED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, LEARNED_FILE)
    except Exception:
        pass
    warm_cert(host)
    push_scope(host)


def push_scope(host):
    """把跳转域同步推给父进程的 /scope/add（只在收窄模式下）。

    这一步是同步的、有超时的本地调用：父进程收到就立刻重建 PAC 并换版本号，
    等我们把 302 写回客户端时，范围已经生效。失败也不影响转发——
    父进程那边还有 0.25 秒一次的 merge_learned 兜底（那次会晚一拍，但不会永久丢）。
    """
    if not SCOPE_MODE or not ADMIN_PORT:
        return
    try:
        urllib.request.urlopen(
            "http://127.0.0.1:%d/scope/add?host=%s" % (ADMIN_PORT, urllib.parse.quote(host)),
            timeout=2).read()
    except Exception:
        pass


_warmed = set()
_warmed_lock = threading.Lock()


def warm_cert(host):
    """后台预签证书。

    登录流程会连着跳好几个域（业务域 → 授权域 → 回跳域），
    每个新域首次访问都要现签一张证书，慢的话要等几秒，
    用户会看到"点了没反应"。这里在拿到 302 Location 时就提前签好。
    """
    h = host.lower()
    with _warmed_lock:
        if h in _warmed or CERTS is None:
            return
        _warmed.add(h)

    def run():
        try:
            CERTS.server_context(h)
        except Exception as e:
            log("预签发失败 %s: %s" % (h, e))

    threading.Thread(target=run, daemon=True).start()


# ---------------- 读取工具 ----------------

class Reader:
    def __init__(self, sock):
        self.s = sock
        self.buf = b""

    def read_until(self, delim, limit=256 * 1024):
        while delim not in self.buf:
            if len(self.buf) > limit:
                raise ValueError("head too large")
            chunk = self.s.recv(65536)
            if not chunk:
                return self.buf if self.buf else None
            self.buf += chunk
        i = self.buf.find(delim) + len(delim)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(min(65536, n - len(self.buf)))
            if not chunk:
                break
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def read_all(self):
        while True:
            chunk = self.s.recv(65536)
            if not chunk:
                break
            self.buf += chunk
        out, self.buf = self.buf, b""
        return out


def parse_head(head):
    lines = head.split(b"\r\n")
    start = lines[0].decode("latin1", "replace")
    hdrs = {}
    raw = []
    for ln in lines[1:]:
        if b":" in ln:
            k, v = ln.split(b":", 1)
            key = k.strip().lower().decode("latin1")
            hdrs[key] = v.strip().decode("latin1")
            raw.append((key, v.strip()))
    return start, hdrs, raw


def read_chunked(r):
    out = b""
    while True:
        line = r.read_until(b"\r\n")
        if not line:
            break
        out += line
        size_str = line.split(b";")[0].strip()
        try:
            size = int(size_str, 16)
        except ValueError:
            break
        if size == 0:
            trailer = r.read_until(b"\r\n")
            out += trailer or b""
            break
        body = r.read_exact(size + 2)
        out += body
    return out


def read_body(r, hdrs):
    te = (hdrs.get("transfer-encoding") or "").lower()
    if "chunked" in te:
        return read_chunked(r)
    if "content-length" in hdrs:
        try:
            n = int(hdrs["content-length"])
        except ValueError:
            return b""
        return r.read_exact(n)
    return b""


# ---------------- 连接处理 ----------------

def tunnel(a, b):
    """双向裸转发（用于排除域名 / WebSocket）。"""
    def pump(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    t = threading.Thread(target=pump, args=(a, b), daemon=True)
    t.start()
    pump(b, a)
    t.join(timeout=5)


def connect_upstream(host, port, tls=True):
    """连接上游站点。TLS 校验失败时降级重试一次（企业自签/中间证书场景）。

    tls 由**调用方声明**，不由端口推断。之前写的是 `if port != 443: return s`，
    于是 8443/9443 这类端口的 HTTPS 被当成明文：客户端那侧已经是 TLS，
    上游那侧却收到一条明文 HTTP 请求，OpenSSL 直接
    `HTTP_REQUEST` 报错 → 客户端看到 502。CONNECT 过来的流量一定是 TLS，
    与端口号无关。
    """
    s = socket.create_connection((host, port), timeout=20)
    s.settimeout(30)
    if not tls:
        return s
    ctx = ssl.create_default_context()
    ctx.set_alpn_protocols(["http/1.1"])
    try:
        return ctx.wrap_socket(s, server_hostname=host)
    except ssl.SSLError as e:
        log("上游证书校验失败 %s: %s（降级重试）" % (host, e))
        try:
            s.close()
        except Exception:
            pass
        s2 = socket.create_connection((host, port), timeout=20)
        s2.settimeout(30)
        ctx2 = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx2.check_hostname = False
        ctx2.verify_mode = ssl.CERT_NONE
        ctx2.set_alpn_protocols(["http/1.1"])
        return ctx2.wrap_socket(s2, server_hostname=host)


def rewrite_head(head, mode):
    """把请求头里的 User-Agent 换成移动微信 UA；没有则原样返回。"""
    m = _UA_LINE.search(head)
    if not m:
        return head, False
    ua = m.group(1)
    if not _WX.search(ua):
        return head, False
    if not any(mk in ua for mk in _DESKTOP_MARKERS):
        return head, False
    target = UA_MAP.get(mode, UA_ANDROID).encode()
    new_head = head[:m.start(1)] + target + head[m.end(1):]
    new_head = _HINT_LINES.sub(b"", new_head)
    return new_head, True


def force_close(head):
    """把请求改成 Connection: close。

    注意：替换时 **必须保留行尾的 CRLF**。原来写成 `^connection:.*$`，
    `.*` 会把 \\r 一起吃掉，替换后那一行只剩 \\n，头部结束标记 \\r\\n\\r\\n
    就没了 —— 上游会一直等剩余的头，最后超时断连，客户端看到的就是
    「意外终止了连接」。这是个非常隐蔽但必现的 bug。
    """
    if re.search(rb"(?im)^connection:", head):
        return re.sub(rb"(?im)^connection:[^\r\n]*(\r\n)", rb"Connection: close\1", head)
    if re.search(rb"(?im)^proxy-connection:", head):
        return re.sub(rb"(?im)^proxy-connection:[^\r\n]*(\r\n)", rb"Connection: close\1", head)
    end = head.rfind(b"\r\n\r\n")
    if end < 0:
        return head
    return head[:end] + b"\r\nConnection: close" + head[end:]


def drop_expect(head):
    """去掉 Expect: 100-continue。我们整包转发，留着会让两边互相干等。"""
    return re.sub(rb"(?im)^expect:[^\r\n]*\r\n", b"", head)


def mark_close(head):
    """响应头里强制 Connection: close。

    我们一次只服务一条请求，写完整条连接就关。如果原样转发上游的
    `Connection: keep-alive`，浏览器会以为连接还能复用，把下一个请求
    发到一条已经关掉的连接上 —— 又是「意外终止了连接」。
    """
    if re.search(rb"(?im)^connection:", head):
        return re.sub(rb"(?im)^connection:[^\r\n]*(\r\n)", rb"Connection: close\1", head)
    end = head.rfind(b"\r\n\r\n")
    if end < 0:
        return head
    return head[:end] + b"\r\nConnection: close" + head[end:]


def read_response(up, method):
    """按 Content-Length / chunked 精确读一条响应，不靠 EOF 判断结束。

    靠 EOF 读会在服务器坚持 keep-alive 时一直等到 socket 超时（30s），
    表现为页面白屏很久然后报错。
    """
    r = Reader(up)
    head = r.read_until(b"\r\n\r\n")
    if not head:
        return b""
    _, hdrs, _ = parse_head(head)
    code = 0
    try:
        code = int(head.split(b"\r\n", 1)[0].split(b" ")[1])
    except Exception:
        pass
    head = mark_close(head)
    if method == "HEAD" or code in (204, 304) or 100 <= code < 200:
        return head
    if "chunked" in (hdrs.get("transfer-encoding") or "").lower():
        return head + read_chunked(r)
    if "content-length" in hdrs:
        try:
            n = int(hdrs["content-length"])
        except ValueError:
            n = 0
        return head + (r.read_exact(n) if n > 0 else b"")
    try:
        return head + r.read_all()
    except Exception:
        return head


def send_error_502(sock, msg):
    """把内部错误变成一张看得见的页面，而不是裸断连接。"""
    try:
        body = (
            "<!doctype html><meta charset='utf-8'>"
            "<body style=\"font:14px/1.9 -apple-system,Segoe UI,sans-serif;"
            "padding:48px;background:#14181f;color:#e6ebf5;max-width:720px;margin:0 auto\">"
            "<h3 style='color:#ff8f8f;margin:0 0 12px'>本机扫码代理出错了</h3>"
            "<p style='background:#1d232e;padding:12px 14px;border-radius:8px;"
            "border-left:3px solid #ff8f8f;word-break:break-all'>%s</p>"
            "<p style='color:#8b98ad;font-size:12.5px'>这是本机代理自己的问题，不是目标网站坏了。"
            "关掉代理后重新打开链接就能恢复；把这段文字发给我可以定位。</p></body>"
            % html.escape(str(msg))
        ).encode("utf-8")
        sock.sendall(
            b"HTTP/1.1 502 Bad Gateway\r\n"
            b"Content-Type: text/html; charset=utf-8\r\n"
            b"Connection: close\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
    except Exception:
        pass


class Handler(BaseRequestHandler):
    def handle(self):
        try:
            self._handle()
        except Exception as e:
            log("ERR %s: %s" % (self.client_address, e))

    def _handle(self):
        csock = self.request
        csock.settimeout(30)
        r = Reader(csock)
        head = r.read_until(b"\r\n\r\n")
        if not head:
            return
        start, hdrs, _ = parse_head(head)

        if start.upper().startswith("CONNECT "):
            target = start.split()[1]
            host, _, port_s = target.rpartition(":")
            port = int(port_s) if port_s.isdigit() else 443
            csock.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            load_state()

            if host_excluded(host):
                up = socket.create_connection((host, port), timeout=20)
                up.settimeout(30)
                tunnel(csock, up)
                return

            # 解密：用为该域名临时签发的证书与客户端握手
            try:
                ctx = CERTS.server_context(host)
            except Exception as e:
                log("证书签发失败 %s: %s" % (host, e))
                # 握手前无法回 HTTP，只能记录 + 断连；但日志里能查到真因
                return
            try:
                tls = ctx.wrap_socket(csock, server_side=True)
            except Exception as e:
                log("TLS 握手失败 %s: %s" % (host, e))
                return
            tls.settimeout(30)
            try:
                self._serve_http(tls, host, port)
            except Exception as e:
                log("处理失败 %s: %r" % (host, e))
                send_error_502(tls, "%s: %s" % (host, e))
            return

        # 明文 HTTP 代理请求（少见）：解析绝对 URL 后转发
        self._serve_plain(csock, head, r, start, hdrs)

    def _serve_plain(self, csock, head, r, start, hdrs):
        m = re.match(r"^([A-Z]+)\s+http://([^/\s]+)(\S*)", start, re.I)
        if not m:
            csock.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            return
        hostport = m.group(2)
        host, _, port_s = hostport.rpartition(":")
        port = int(port_s) if port_s.isdigit() else 80
        body = read_body(r, hdrs)
        new_head, changed = rewrite_head(drop_expect(head), CTX["ua_mode"])
        if changed:
            with _lock:
                CTX["rewritten"] += 1
                CTX["hosts"][host] = CTX["hosts"].get(host, 0) + 1
                CTX["last"] = host
            flush_stats()
        up = socket.create_connection((host, port), timeout=20)
        up.sendall(force_close(new_head) + body)
        up.settimeout(30)
        resp = read_response(up, start.split(" ")[0].upper())
        csock.sendall(resp)
        up.close()

    def _serve_http(self, tls, host, port):
        r = Reader(tls)
        while True:
            head = r.read_until(b"\r\n\r\n")
            if not head:
                return
            start, hdrs, _ = parse_head(head)
            if not start:
                return
            method = start.split(" ")[0].upper()

            # 客户端带 Expect: 100-continue 时会先不发 body，等我们这句；
            # 不先回它，双方的 read 会互相干等到超时。
            if "100-continue" in (hdrs.get("expect") or "").lower():
                try:
                    tls.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
                except Exception:
                    pass

            body = read_body(r, hdrs)
            new_head, changed = rewrite_head(drop_expect(head), CTX["ua_mode"])
            if changed:
                with _lock:
                    CTX["rewritten"] += 1
                    CTX["hosts"][host] = CTX["hosts"].get(host, 0) + 1
                    CTX["last"] = host
                flush_stats()
                log("REWRITE %s %s" % (host, start[:60]))

            if "upgrade" in hdrs or method == "CONNECT":
                # 走到这里的连接一定是 CONNECT + TLS，上游也必须 TLS
                up = connect_upstream(host, port, tls=True)
                up.sendall(new_head + body)
                tunnel(tls, up)
                return

            up = connect_upstream(host, port, tls=True)
            try:
                up.sendall(force_close(new_head) + body)
                resp = read_response(up, method)
            finally:
                try:
                    up.close()
                except Exception:
                    pass

            # 从响应头里学习跳转目标域名
            try:
                loc = re.search(rb"(?im)^location:\s*https?://([^/\s:]+)", resp)
                if loc:
                    learn(loc.group(1).decode("latin1"))
            except Exception:
                pass

            if not resp:
                send_error_502(tls, "上游 %s 没有返回任何数据（可能被网络中断）" % host)
                return
            tls.sendall(resp)
            flush_stats()
            return  # 强制短连接，写完即关


class Server(ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


CERTS = None


def pid_alive(pid):
    """父进程是否还活着（Windows 上不能用 os.kill(pid,0)，那会真的杀掉对方）。"""
    if not pid:
        return True
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
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


def main():
    global CERTS, ADMIN_PORT, SCOPE_MODE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8888)
    ap.add_argument("--state-check", type=float, default=1.0)
    ap.add_argument("--admin-port", type=int, default=0,
                    help="父进程的管理口；收窄模式下用它同步推送跳转域")
    ap.add_argument("--scope-mode", type=int, default=0,
                    help="1=只接管指定域（跳转域需要边跑边推），0=全量")
    ap.add_argument("--parent-pid", type=int, default=0,
                    help="拉起我的进程 PID；它消失时我也退出，避免占着端口变孤儿")
    args = ap.parse_args()

    ADMIN_PORT = max(0, int(args.admin_port or 0))
    SCOPE_MODE = bool(int(args.scope_mode or 0))

    CERTS = CertStore(DATA)
    # 启动自检：真的签一张证书并加载一次。
    # 这样"缺 openssl / 证书损坏"这类问题会在启动时就暴露成明确报错，
    # 而不是等到用户打开链接时变成一句「意外终止了连接」。
    try:
        CERTS.selftest()
    except Exception as e:
        print("[mitm] 启动自检失败：%s" % e, flush=True)
        sys.exit(3)
    load_state()

    def prewarm():
        """把上次用过的域名证书全部签好，下次用同一个系统时零等待。"""
        time.sleep(2)
        try:
            if not os.path.exists(LEARNED_FILE):
                return
            with open(LEARNED_FILE, "r", encoding="utf-8") as f:
                hosts = list(json.load(f).keys())
        except Exception:
            return
        for h in hosts[-40:]:
            try:
                CERTS.server_context(h)
            except Exception:
                pass
        log("预热完成，共 %d 个域名" % len(hosts))

    threading.Thread(target=prewarm, daemon=True).start()

    def watcher():
        while True:
            load_state()
            time.sleep(args.state_check)

    threading.Thread(target=watcher, daemon=True).start()

    # 父进程（run_proxy.py）被强杀时，我这边不会收到任何通知。
    # 如果就这么赖着，会一直占着 8888 端口，下一次启动的新代理根本绑不上，
    # 用户看到的是"代理开着但所有网页报错"。所以自己盯着父进程。
    if args.parent_pid:
        def guard_parent():
            while True:
                time.sleep(2)
                if not pid_alive(args.parent_pid):
                    log("父进程 %d 已退出，代理自行结束" % args.parent_pid)
                    # 关键兜底：主进程若是被任务管理器强杀的，它没机会还原系统代理。
                    # 这时候系统代理还指着 127.0.0.1:8888（兼容模式）或 PAC，
                    # 用户会整台上不了网。所以由我替它还原一次。
                    try:
                        subprocess.run(
                            [sys.executable, os.path.join(BASE, "run_proxy.py"), "--restore"],
                            capture_output=True, timeout=20,
                        )
                        log("已代为还原系统代理")
                    except Exception as e:
                        log("代为还原失败: %s" % e)
                    os._exit(0)

        threading.Thread(target=guard_parent, daemon=True).start()

    srv = Server(("127.0.0.1", args.port), Handler)
    print("[mitm] listening 127.0.0.1:%d" % args.port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        flush_stats(force=True)


if __name__ == "__main__":
    main()
