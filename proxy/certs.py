#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地 CA 与按域名签发站点证书。
============================================================

默认后端是 **native**：完全用标准库生成 RSA 密钥与 X.509 证书
（见 certgen.py），不需要 openssl、不需要管理员、不下载任何东西。

为什么改成这样
--------------
历史版本用 `openssl` 命令行签发证书，原因写在下面的旧注释里（当时 pip 被
屏蔽、装不了 MITM 库）。但那种做法对"公开发布"是致命的：Windows 不自带
openssl，普通用户机器上大概率没有，于是「手机环境」一点就报"找不到
openssl"。让用户为了扫码去装 Git 或 OpenSSL 是不可接受的。

native 后端顺带解决了两件事：
  - 快。签发一张叶子证书从 openssl 的 1~6 秒（进程启动 + 密钥生成）降到
    0.1 秒以内，跳到新域名时不再卡顿；
  - 稳。不再有 "-CAcreateserial 并发写坏 ca.srl"、"-extfile 临时文件"、
    "EOL 转换把 PEM 写坏"这类命令行特有的坑。

openssl 后端仍然保留（QRSCAN_CERT_BACKEND=openssl），只作为排查手段：
万一 native 在某个环境下签出来的证书有问题，可以立刻退回去对比。

关于 openssl 的旧注释（保留，说明当时为什么这么做）
--------------------------------------------------
1. 本机 pip 被环境屏蔽，装不了现成的 MITM 库，只能用 openssl 命令行。
2. **openssl 不在 PATH 里**。从 Electron 启动的 Python 继承的是系统 PATH，
   而 Windows 上 openssl 通常只随 Git 一起装（<Git>\\usr\\bin\\openssl.exe），
   不在系统 PATH 中。之前正是这个原因导致「新域名签发失败 → 连接被掐断 →
   浏览器报『意外终止了连接』」。所以这里做全面探测，绝不依赖 PATH。
"""
import os
import random
import re
import shutil
import subprocess
import sys
import threading

import certgen


def _candidates():
    """按可信度从高到低列出 openssl 可能的位置（仅 openssl 后端与自检使用）。"""
    out = []

    env = os.environ.get("QRSCAN_OPENSSL")
    if env:
        out.append(env)

    exe = "openssl.exe" if os.name == "nt" else "openssl"
    same_dir = os.path.join(os.path.dirname(sys.executable), exe)
    out.append(same_dir)

    w = shutil.which("openssl")
    if w:
        out.append(w)

    # 从 git.exe 反推：<Git>\cmd\git.exe → <Git>\usr\bin\openssl.exe
    g = shutil.which("git")
    if g:
        root = os.path.dirname(os.path.dirname(os.path.abspath(g)))
        for sub in ("usr/bin", "mingw64/bin", "usr/local/bin"):
            out.append(os.path.join(root, *sub.split("/"), exe))

    roots = [
        r"C:\Program Files\Git\usr\bin",
        r"C:\Program Files\Git\mingw64\bin",
        r"C:\Program Files (x86)\Git\usr\bin",
        r"C:\Program Files (x86)\Git\mingw64\bin",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\usr\bin"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\mingw64\bin"),
        r"C:\Program Files\OpenSSL-Win64\bin",
        r"C:\Program Files\OpenSSL\bin",
        r"C:\Program Files (x86)\OpenSSL-Win32\bin",
        r"C:\Program Files\OpenSSL-Win64",
        r"C:\Windows\System32",
        r"D:\Program Files\Git\usr\bin",
        r"D:\Git\usr\bin",
        r"E:\Git\usr\bin",
        r"C:\msys64\usr\bin",
        r"C:\cygwin64\bin",
    ]
    for r in roots:
        out.append(os.path.join(r, exe))

    # 去重保序
    seen, res = set(), []
    for p in out:
        if not p:
            continue
        k = p.lower()
        if k in seen:
            continue
        seen.add(k)
        res.append(p)
    return res


_OPENSSL = [None]


def find_openssl():
    """返回可用的 openssl 可执行文件路径；找不到返回 None。

    现在只有 openssl 后端与设置页的环境自检会用到它 —— native 后端不需要。
    """
    if _OPENSSL[0]:
        return _OPENSSL[0]
    for p in _candidates():
        if not os.path.isfile(p):
            continue
        try:
            r = subprocess.run([p, "version"], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and "OpenSSL" in (r.stdout or ""):
                _OPENSSL[0] = p
                return p
        except Exception:
            continue
    return None


def _write_text(path, text):
    """先写临时文件再改名：进程被杀时不会留下半个 PEM。

    注意不做"删旧文件"这一步 —— 本环境下 os.remove 会被安全策略改写成
    "移到回收站"（实测每次约 2 秒），os.replace 是原子操作，不需要先删。
    """
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def _write_bytes(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class CertStore:
    def __init__(self, base_dir, log=print):
        self.dir = os.path.join(base_dir, "certs")
        os.makedirs(self.dir, exist_ok=True)
        # 叶子证书单独放一层子目录。
        # 原因：本机环境下 os.remove 会被安全策略改写成"移到回收站"（实测每次 2 秒），
        # 所以绝不用"删掉旧证书"的方式做升级或清理 —— 换目录最省事，旧的留着也无害。
        self.leaf_dir = os.path.join(self.dir, "leaf")
        os.makedirs(self.leaf_dir, exist_ok=True)
        # native 后端用独立子目录：老版本留下的是 openssl + ECDSA 组合，
        # 混在一起会出现"证书是 A 密钥签的、私钥文件却是 B"的错配。
        #
        # v2：早期 certgen 把 AuthorityKeyIdentifier 的 keyIdentifier 编成了
        # [0] EXPLICIT（A0 16 04 14 ...），正确应是 [0] IMPLICIT（80 14 ...）。
        # OpenSSL / Windows 都容忍，Chromium 直接 ERR_CERT_INVALID。
        # 那些证书已经写盘并被复用，所以换一个目录 —— 与上面同样的理由：
        # 不删旧文件，只让新代码不去读它。
        self.native_leaf_dir = os.path.join(self.dir, "leaf-native2")
        os.makedirs(self.native_leaf_dir, exist_ok=True)
        self.ca_crt = os.path.join(self.dir, "ca.crt")
        self.ca_cer = os.path.join(self.dir, "ca.cer")
        self.ca_key = os.path.join(self.dir, "ca.key")
        self.log = log
        self._ctx_cache = {}
        # 浏览器一次会并发开 6 条连接，同一域名可能被多条连接同时要求签发。
        # 按域名分别加锁：同域串行（避免把同一个 crt 写坏），不同域并行（不互相拖慢）。
        self._leaf_locks = {}
        self._leaf_locks_guard = threading.Lock()
        self._leaf_lock = threading.Lock()
        self._ca_lock = threading.Lock()
        self._ca_der = None
        self._ca_native_key = None
        self._leaf_native_key = None

        backend = (os.environ.get("QRSCAN_CERT_BACKEND") or "native").strip().lower()
        # self.openssl 只表示"用 openssl 后端"（签发分支按它走）。
        # 探测到的系统 openssl 另存一个字段，仅用于日志/自检展示 ——
        # 之前把探测结果写进 self.openssl，结果 native 模式**静默走了 openssl**，
        # 在没有 Git 的机器上会直接失败，而那正是这次改造要消灭的场景。
        self.openssl = None
        self.openssl_path = None
        if backend == "openssl":
            self.openssl_path = find_openssl()
            if not self.openssl_path:
                raise RuntimeError(
                    "已指定 QRSCAN_CERT_BACKEND=openssl，但找不到 openssl。\n"
                    "去掉这个环境变量即可使用内置的纯 Python 签发（推荐）。"
                )
            self.openssl = self.openssl_path
            self.log("[ca] 后端 = openssl（%s）" % self.openssl_path)
        else:
            self.openssl_path = find_openssl()
            self.log("[ca] 后端 = native（纯 Python）；系统 openssl = %s" % (self.openssl_path or "未安装（不影响使用）"))

        self._ensure_ca()

    # ---------- openssl 后端（兼容保留） ----------

    def _run(self, args):
        _t0 = __import__("time").time()
        r = subprocess.run(
            [self.openssl] + args, capture_output=True, text=True, timeout=60
        )
        if os.environ.get("QRSCAN_DEBUG_TIMING"):
            self.log("[timing] %-12s %.2fs" % (args[0], __import__("time").time() - _t0))
        if r.returncode != 0:
            raise RuntimeError(
                "openssl 失败: %s\n%s" % (" ".join(args[:4]), (r.stderr or "").strip()[:400])
            )
        return r.stdout

    # ---------- CA ----------

    def _ca_ok(self):
        return (
            os.path.exists(self.ca_crt)
            and os.path.exists(self.ca_key)
            and os.path.getsize(self.ca_crt) > 0
            and os.path.getsize(self.ca_key) > 0
        )

    def _ensure_ca(self):
        with self._ca_lock:
            if self._ca_ok():
                if not os.path.exists(self.ca_cer) or os.path.getsize(self.ca_cer) == 0:
                    if self.openssl:
                        self._run(["x509", "-in", self.ca_crt, "-outform", "DER", "-out", self.ca_cer])
                    else:
                        with open(self.ca_crt, "r", encoding="ascii") as f:
                            _write_bytes(self.ca_cer, certgen.load_certificate(f.read()))
                return
            self.log("[ca] 生成本地根证书（首次运行，约 1 秒）")
            if self.openssl:
                self._run([
                    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", self.ca_key, "-out", self.ca_crt,
                    "-days", "3650",
                    "-subj", "/CN=QRScan Local CA/O=QRScan",
                    "-addext", "basicConstraints=critical,CA:TRUE",
                    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                ])
                self._run(["x509", "-in", self.ca_crt, "-outform", "DER", "-out", self.ca_cer])
                return

            der, key = certgen.build_ca("QRScan Local CA", "QRScan", days=3650)
            _write_text(self.ca_crt, certgen.pem_certificate(der))
            _write_text(self.ca_key, certgen.pem_private_key(key))
            _write_bytes(self.ca_cer, der)

    def _load_ca_native(self):
        """读取 native 签发所需的 CA 证书 DER 与私钥。

        懒加载 + 缓存：CA 是本机自签的，文件只有自己会改，不需要每次签发都读盘。
        锁在这里是必须的：并发首连时多条连接会同时走到这里。
        """
        if self._ca_der is not None and self._ca_native_key is not None:
            return self._ca_der, self._ca_native_key
        with self._ca_lock:
            if self._ca_der is not None and self._ca_native_key is not None:
                return self._ca_der, self._ca_native_key
            with open(self.ca_crt, "r", encoding="ascii") as f:
                der = certgen.load_certificate(f.read())
            with open(self.ca_key, "r", encoding="ascii") as f:
                key = certgen.load_private_key(f.read())
            self._ca_der, self._ca_native_key = der, key
            return der, key

    # ---------- 叶子证书 ----------

    def _leaf_paths(self, host):
        safe = re.sub(r"[^a-z0-9._-]", "_", host.lower())
        return os.path.join(self.leaf_dir, safe + ".crt")

    def _native_leaf_paths(self, host):
        safe = re.sub(r"[^a-z0-9._-]", "_", host.lower())
        return os.path.join(self.native_leaf_dir, safe + ".crt")

    def _host_lock(self, host):
        k = host.lower()
        with self._leaf_locks_guard:
            lk = self._leaf_locks.get(k)
            if lk is None:
                lk = threading.Lock()
                self._leaf_locks[k] = lk
            return lk

    def _ensure_leaf_key(self):
        """所有站点证书共用一把叶私钥。

        这么做只为一件事：快。原来每个域名都现生成一把 RSA 2048，
        实测要 6 秒多（openssl 进程启动 + 密钥生成），跳到新域名时
        页面会明显卡住。共用一把 ECDSA P-256 后只剩"签名"这一步。
        这是本机临时解密用的证书，共用私钥不引入额外风险。
        """
        p = os.path.join(self.leaf_dir, "_leaf.key")
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
        with self._leaf_lock:
            if os.path.exists(p) and os.path.getsize(p) > 0:
                return p
            try:
                self._run([
                    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p,
                ])
            except Exception as e:
                # 极老的 openssl 可能不支持，退回到 RSA
                self.log("[ca] ECDSA 不可用（%s），改用 RSA" % e)
                self._run([
                    "genpkey", "-algorithm", "RSA",
                    "-pkeyopt", "rsa_keygen_bits:2048", "-out", p,
                ])
            return p

    def _ensure_leaf_key_native(self):
        """native 后端的共享叶子私钥（RSA 2048，首次约 0.5 秒，之后直接复用）。

        返回 (路径, 私钥对象)：路径给 ssl.load_cert_chain，对象用于签证书时
        导出公钥 —— 两者必须是同一把钥匙，所以放在一起返回，避免调用方
        各读一遍文件。
        """
        p = os.path.join(self.native_leaf_dir, "_leaf.key")
        if self._leaf_native_key is not None and os.path.exists(p):
            return p, self._leaf_native_key
        with self._leaf_lock:
            if self._leaf_native_key is not None and os.path.exists(p):
                return p, self._leaf_native_key
            if os.path.exists(p) and os.path.getsize(p) > 0:
                with open(p, "r", encoding="ascii") as f:
                    key = certgen.load_private_key(f.read())
            else:
                key = certgen.generate_key(2048)
                _write_text(p, certgen.pem_private_key(key))
            self._leaf_native_key = key
            return p, key

    def _make_leaf(self, host):
        with self._host_lock(host):
            return self._make_leaf_unlocked(host)

    def _make_leaf_unlocked(self, host):
        if self.openssl:
            return self._make_leaf_openssl(host)
        return self._make_leaf_native(host)

    def _make_leaf_native(self, host):
        crt = self._native_leaf_paths(host)
        key_path, key = self._ensure_leaf_key_native()
        # 文件存在但为 0 字节（上次签发半途而废）必须重签，
        # 否则 load_cert_chain 会抛异常，表现又是一个"连接被掐断"。
        if os.path.exists(crt) and os.path.getsize(crt) > 0:
            return crt, key_path
        ca_der, ca_key = self._load_ca_native()
        der = certgen.build_leaf(host, ca_der, ca_key, key)
        _write_text(crt, certgen.pem_certificate(der))
        self.log("[ca] 已为 %s 签发临时证书" % host)
        return crt, key_path

    def _make_leaf_openssl(self, host):
        crt = self._leaf_paths(host)
        key = self._ensure_leaf_key()
        # 文件存在但为 0 字节（上次签发半途而废）必须重签，
        # 否则 load_cert_chain 会抛异常，表现又是一个"连接被掐断"。
        if os.path.exists(crt) and os.path.getsize(crt) > 0:
            return crt, key
        csr = crt + ".csr"
        ext = crt + ".ext"
        is_ip = re.match(r"^\d+\.\d+\.\d+\.\d+$", host) is not None
        san = ("IP:" if is_ip else "DNS:") + host
        with open(ext, "w", encoding="ascii") as f:
            f.write(
                "subjectAltName=%s\n"
                "basicConstraints=CA:FALSE\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                "extendedKeyUsage=serverAuth\n" % san
            )
        # 注意：这里刻意不删 csr / ext 中间文件。
        # 本环境下 os.remove 被安全策略改写成"移到回收站"，每删一个要 2 秒，
        # 删两个就让"打开一个新网站"卡 4 秒。留着每个才几百字节，下次覆盖写即可。
        self._run([
            "req", "-new", "-key", key, "-out", csr, "-subj", "/CN=" + host,
        ])
        # 用 -set_serial 自己给序列号，不再用 -CAcreateserial。
        # 后者要读写共享的 ca.srl，多域名并发签发时会互相踩，报 TXT_DB error。
        serial = "0x%032x" % random.getrandbits(128)
        self._run([
            "x509", "-req", "-in", csr,
            "-CA", self.ca_crt, "-CAkey", self.ca_key,
            "-set_serial", serial,
            "-out", crt, "-days", "3650", "-extfile", ext,
        ])
        self.log("[ca] 已为 %s 签发临时证书" % host)
        return crt, key

    # ---------- 对外 ----------

    def selftest(self):
        """启动自检：真正签一张证书并加载，失败就当场抛错。"""
        crt, key = self._make_leaf("selftest.local")
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        return True

    def server_context(self, host):
        """取该域名的 SSLContext（带缓存）。"""
        import ssl
        host = host.lower()
        if host in self._ctx_cache:
            return self._ctx_cache[host]
        with self._host_lock(host):
            if host in self._ctx_cache:
                return self._ctx_cache[host]
            crt, key = self._make_leaf_unlocked(host)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(crt, key)
            # 只声明 http/1.1：客户端就不会改用 HTTP/2 帧，我们的解析器只认 HTTP/1.1
            ctx.set_alpn_protocols(["http/1.1"])
            self._ctx_cache[host] = ctx
            return ctx
