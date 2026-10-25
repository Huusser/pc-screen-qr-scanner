# -*- coding: utf-8 -*-
"""certgen 验收：签出来的证书必须能被 Python 的 ssl 以 ca.crt 为根验过。"""
import os
import socket
import ssl
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../proxy")
import certgen  # noqa: E402

OUT = os.path.join(os.environ["TEMP"], "certgen-test")
os.makedirs(OUT, exist_ok=True)


def p(name):
    return os.path.join(OUT, name)


def serve(ctx, port_holder, ready):
    def run():
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(4)
        port_holder.append(srv.getsockname()[1])
        ready.set()
        for _ in range(2):
            try:
                conn, _ = srv.accept()
                conn = ctx.wrap_socket(conn, server_side=True)
                conn.recv(16)
                conn.sendall(b"ok")
                conn.close()
            except Exception:
                pass
        srv.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def connect(port, cafile, server_hostname):
    ctx = ssl.create_default_context(cafile=cafile)
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    with socket.create_connection(("127.0.0.1", port), timeout=6) as raw:
        with ctx.wrap_socket(raw, server_hostname=server_hostname) as s:
            s.sendall(b"hi")
            return s.recv(8)


def one_round(tag, ca_der, ca_key, leaf_key):
    ok = True

    def check(label, cond, extra=""):
        nonlocal ok
        if not cond:
            ok = False
        print(("ok   " if cond else "FAIL ") + label + ("  " + extra if extra else ""))

    ca_pem_path = p(tag + "-ca.crt")
    with open(ca_pem_path, "w", encoding="ascii") as f:
        f.write(certgen.pem_certificate(ca_der))

    t0 = time.time()
    leaf_der = certgen.build_leaf("example.com", ca_der, ca_key, leaf_key)
    dt = time.time() - t0
    crt = p(tag + "-leaf.crt")
    key = p(tag + "-leaf.key")
    with open(crt, "w", encoding="ascii") as f:
        f.write(certgen.pem_certificate(leaf_der))
    with open(key, "w", encoding="ascii") as f:
        f.write(certgen.pem_private_key(leaf_key))
    check("%s 签发叶子证书" % tag, len(leaf_der) > 400, "%.3fs / %d 字节" % (dt, len(leaf_der)))

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        ctx.load_cert_chain(crt, key)
        check("%s ssl 能加载证书+私钥" % tag, True)
    except Exception as e:
        check("%s ssl 能加载证书+私钥" % tag, False, repr(e))
        return ok

    port_holder, ready = [], threading.Event()
    serve(ctx, port_holder, ready)
    ready.wait(3)
    port = port_holder[0]

    # 1) 正例：域名正确，用自签 CA 验证
    try:
        data = connect(port, ca_pem_path, "example.com")
        check("%s 客户端验证通过" % tag, data == b"ok")
    except Exception as e:
        check("%s 客户端验证通过" % tag, False, repr(e))

    # 2) 反例：域名不匹配必须失败（证明 SAN 真的参与校验）
    try:
        connect(port, ca_pem_path, "wrong.example.net")
        check("%s 域名不符应失败" % tag, False, "竟然连上了")
    except ssl.SSLError as e:
        check("%s 域名不符应失败" % tag, "hostname" in str(e).lower() or "mismatch" in str(e).lower(), str(e)[:60])
    except Exception as e:
        check("%s 域名不符应失败" % tag, True, type(e).__name__)

    # 3) 反例：不信任这个 CA 时必须失败
    other_ca, _ = certgen.build_ca("Other CA")
    other_path = p(tag + "-other-ca.crt")
    with open(other_path, "w", encoding="ascii") as f:
        f.write(certgen.pem_certificate(other_ca))
    try:
        connect(port, other_path, "example.com")
        check("%s 陌生 CA 应失败" % tag, False, "竟然连上了")
    except Exception as e:
        check("%s 陌生 CA 应失败" % tag, True, type(e).__name__)

    # 4) IP 证书
    ip_der = certgen.build_leaf("127.0.0.1", ca_der, ca_key, leaf_key)
    ip_crt = p(tag + "-ip.crt")
    with open(ip_crt, "w", encoding="ascii") as f:
        f.write(certgen.pem_certificate(ip_der))
    ip_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ip_ctx.load_cert_chain(ip_crt, key)
    ph2, rdy2 = [], threading.Event()
    serve(ip_ctx, ph2, rdy2)
    rdy2.wait(3)
    try:
        connect(ph2[0], ca_pem_path, "127.0.0.1")
        check("%s IP 证书（SAN IP）可用" % tag, True)
    except Exception as e:
        check("%s IP 证书（SAN IP）可用" % tag, False, repr(e))

    return ok


def check_aki_encoding():
    """回归：AKI 的 keyIdentifier 必须是 [0] IMPLICIT（80 xx）。

    写成 [0] EXPLICIT（A0 xx 04 xx）时 OpenSSL 与 Windows 都肯认，
    但 Chromium 的 BoringSSL 判为非法扩展 → ERR_CERT_INVALID，
    表现是"所有 HTTPS 走代理都提示连接不是私密连接"。
    """
    ca, ca_key = certgen.build_ca()
    leaf_key = certgen.generate_key()
    der = certgen.build_leaf("aki.example.com", ca, ca_key, leaf_key)
    # 正确的 AKI 扩展值以 30 16 80 14 开头（SEQUENCE, [0] IMPLICIT, OCTET STRING 20 字节）
    good = b"\x30\x16\x80\x14" in der
    bad = b"\xa0\x16\x04\x14" in der  # 早期错误编码：[0] EXPLICIT 套 OCTET STRING
    ok = good and not bad
    print(("ok   " if ok else "FAIL ") + "AKI 用 [0] IMPLICIT 编码  " +
          ("30 16 80 14" if good else "未找到 30 16 80 14") +
          (" / 仍存在 A0 16 04 14" if bad else ""))
    return ok


def main():
    print("== 场景 A：全新自建 CA ==")
    t0 = time.time()
    ca1, key1 = certgen.build_ca()
    print("   CA 生成 %.2fs" % (time.time() - t0))
    t0 = time.time()
    leaf_key = certgen.generate_key()
    print("   叶子密钥生成 %.2fs" % (time.time() - t0))

    # 私钥 PEM 往返
    rt = certgen.load_private_key(certgen.pem_private_key(key1))
    print("   私钥 PEM 往返 n 一致:", rt.n == key1.n, "| d 一致:", rt.d == key1.d)

    ok_a = one_round("A", ca1, key1, leaf_key)

    print("\n== 场景 B：复用已有 openssl 生成的 CA（升级兼容） ==")
    legacy_dir = os.path.join(os.environ["APPDATA"], "ScreenQR", "proxy", "certs")
    ca_crt = os.path.join(legacy_dir, "ca.crt")
    ca_key_path = os.path.join(legacy_dir, "ca.key")
    if os.path.exists(ca_crt) and os.path.exists(ca_key_path):
        with open(ca_crt, "r", encoding="ascii") as f:
            # 只取第一个 PEM 块（ca.crt 里可能带注释）
            text = f.read()
        _, ca_der = certgen._pem_body(text)
        with open(ca_key_path, "r", encoding="ascii") as f:
            legacy_key = certgen.load_private_key(f.read())
        print("   已解析老 CA：模长 %d 位" % legacy_key.n.bit_length())
        ok_b = one_round("B", ca_der, legacy_key, leaf_key)
    else:
        print("   （跳过：没有历史 CA）")
        ok_b = True

    ok_aki = check_aki_encoding()

    print("\n结果:", "ALL PASS" if (ok_a and ok_b and ok_aki) else "HAS FAILURES")


main()
