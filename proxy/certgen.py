#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
纯标准库的本地 CA 与站点证书签发
============================================================

为什么需要它
------------
「手机环境」原本靠 openssl 命令行签发证书（见 certs.py 的历史注释）。
这在开发机上没问题，但公开发布后是个硬门槛：Windows 不自带 openssl，
普通用户只有装了 Git for Windows 才可能间接拥有它。要求用户为了一个
扫码工具去装 Git，等于把功能砍掉。

这个模块用 **只依赖标准库** 的方式把 openssl 的活干掉：

    RSA 密钥生成    →  自实现 Miller-Rabin + 大数运算（CPython 的 pow 是 C 实现，够快）
    ASN.1 / DER    →  手写最小编码器（只需 SEQUENCE/INTEGER/OID/BIT STRING…）
    X.509 v3 证书  →  按 RFC 5280 组装 TBSCertificate + 扩展
    签名           →  PKCS#1 v1.5（RSASSA-PKCS1-v1_5 + SHA-256）

明确不做的事：不校验别的证书、不做 TLS、不读系统证书库。这里只需要
"生成一把钥匙 + 签一张证书"，多余的能力一律不要，代码越少越好审。

正确性怎么保证：不靠肉眼读 DER。certs.py 的自检会真的起一个 TLS 服务端
加载签出来的证书，再用 `ssl` 模块以 ca.crt 作为信任根去连 —— 能连上说明
密钥、签名、扩展、链全部成立；故意用错域名必须连不上，说明校验真的生效。
"""

import base64
import hashlib
import random
import re
import time

_rand = random.SystemRandom()

# ---------------------------------------------------------------- ASN.1 / DER


def _der_len(n):
    if n < 0x80:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def tlv(tag, body):
    """打一个 TLV。tag 是完整首字节（含 constructed / class 位）。"""
    return bytes([tag]) + _der_len(len(body)) + body


def seq(*items):
    return tlv(0x30, b"".join(items))


def setof(*items):
    # DER 要求 SET OF 的元素按编码升序排列；这里元素少，直接排一下更稳妥
    return tlv(0x31, b"".join(sorted(items)))


def integer(v):
    if v < 0:
        raise ValueError("只支持非负整数")
    body = v.to_bytes(max(1, (v.bit_length() + 7) // 8), "big")
    if body[0] & 0x80:
        body = b"\x00" + body
    return tlv(0x02, body)


def boolean(v):
    return tlv(0x01, b"\xff" if v else b"\x00")


def octet_string(data):
    return tlv(0x04, data)


def utf8_string(s):
    return tlv(0x0C, s.encode("utf-8"))


def bit_string(data, unused=0):
    return tlv(0x03, bytes([unused]) + data)


def explicit(n, body):
    return tlv(0xA0 | n, body)


def _oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    if len(parts) < 2:
        raise ValueError("OID 至少要两段")
    out = bytearray([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        chunk = [p & 0x7F]
        p >>= 7
        while p:
            chunk.append(0x80 | (p & 0x7F))
            p >>= 7
        out.extend(reversed(chunk))
    return tlv(0x06, bytes(out))


def _time(tm):
    if tm.tm_year < 2050:
        return tlv(0x17, time.strftime("%y%m%d%H%M%SZ", tm).encode("ascii"))
    return tlv(0x18, time.strftime("%Y%m%d%H%M%SZ", tm).encode("ascii"))


def _read_tlv(data, i=0):
    """返回 (tag, content_start, content_len)；tag 只取首字节（够用）。"""
    tag = data[i]
    i += 1
    ln = data[i]
    i += 1
    if ln & 0x80:
        cnt = ln & 0x7F
        if cnt == 0 or cnt > 4:
            raise ValueError("不支持的 DER 长度形式")
        ln = int.from_bytes(data[i:i + cnt], "big")
        i += cnt
    if i + ln > len(data):
        raise ValueError("DER 越界")
    return tag, i, ln


def _walk(data):
    """逐个产出 (tag, tlv_start, content_start, content_len)。"""
    i = 0
    while i < len(data):
        tag, cs, cl = _read_tlv(data, i)
        yield tag, i, cs, cl
        i = cs + cl


# ---------------------------------------------------------------- OID 常量

OID_RSA = "1.2.840.113549.1.1.1"
OID_SHA256 = "2.16.840.1.101.3.4.2.1"
OID_SHA256_RSA = "1.2.840.113549.1.1.11"   # sha256WithRSAEncryption
OID_CN = "2.5.4.3"
OID_O = "2.5.4.10"
OID_BASIC_CONSTRAINTS = "2.5.29.19"
OID_KEY_USAGE = "2.5.29.15"
OID_EXT_KEY_USAGE = "2.5.29.37"
OID_SAN = "2.5.29.17"
OID_SKI = "2.5.29.14"
OID_AKI = "2.5.29.35"
OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

_NULL = b"\x05\x00"
_SIG_ALG = seq(_oid(OID_SHA256_RSA), _NULL)

# keyUsage 位：bit0 digitalSignature、bit2 keyEncipherment、bit5 keyCertSign、bit6 cRLSign
KU_CA = bit_string(bytes([0x06]), 1)        # keyCertSign | cRLSign
KU_LEAF = bit_string(bytes([0xA0]), 5)      # digitalSignature | keyEncipherment


# ---------------------------------------------------------------- RSA

_SMALL_PRIMES = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
    73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151,
    157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233,
    239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317,
    331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419,
    421, 431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503,
    509, 521, 523, 541, 547, 557, 563, 569, 571, 577, 587, 593, 599, 601, 607,
    613, 617, 619, 631, 641, 643, 647, 653, 659, 661, 673, 677, 683, 691, 701,
    709, 719, 727, 733, 739, 743, 751, 757, 761, 769, 773, 787, 797, 809, 811,
    821, 823, 827, 829, 839, 853, 857, 859, 863, 877, 881, 883, 887, 907, 911,
    919, 929, 937, 941, 947, 953, 967, 971, 977, 983, 991, 997,
]


def _is_probable_prime(n, rounds=16):
    if n < 2:
        return False
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d = n - 1
    s = 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = _rand.randrange(2, n - 1)
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits):
    while True:
        cand = _rand.getrandbits(bits) | (1 << (bits - 1)) | 1
        # 先过一遍小素数筛，省掉绝大多数 Miller-Rabin
        if any(cand % p == 0 for p in _SMALL_PRIMES):
            continue
        if _is_probable_prime(cand):
            return cand


class RSAKey(object):
    """只保存 RSA 的数学参数，够做密钥导出与 PKCS#1 v1.5 签名。"""

    def __init__(self, n, e, d, p=None, q=None):
        self.n = n
        self.e = e
        self.d = d
        self.p = p
        self.q = q

    @property
    def size(self):
        """模长的字节数（RSA 签名的输出长度）。"""
        return (self.n.bit_length() + 7) // 8

    def sign_sha256(self, data):
        """RSASSA-PKCS1-v1_5 + SHA-256（RFC 8017 §8.2）。"""
        digest = hashlib.sha256(data).digest()
        digest_info = seq(seq(_oid(OID_SHA256), _NULL), octet_string(digest))
        k = self.size
        pad_len = k - len(digest_info) - 3
        if pad_len < 8:
            raise ValueError("密钥太短，无法容纳 DigestInfo")
        em = b"\x00\x01" + b"\xff" * pad_len + b"\x00" + digest_info
        return pow(int.from_bytes(em, "big"), self.d, self.n).to_bytes(k, "big")


def generate_key(bits=2048):
    """生成 RSA 密钥。2048 位在纯 Python 里约 0.3~1.5 秒（只在首次运行发生一次）。"""
    e = 65537
    half = bits // 2
    while True:
        p = _gen_prime(half)
        q = _gen_prime(bits - half)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        if abs(p - q) < (1 << (half - 100)):
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        d = pow(e, -1, phi)
        return RSAKey(n, e, d, p, q)


# ---------------------------------------------------------------- PEM


def _pem(label, der):
    b64 = base64.b64encode(der).decode("ascii")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (label, "\n".join(lines), label)


def pem_private_key(key):
    """导出 PKCS#1 私钥 PEM（Python 的 ssl 能直接 load_cert_chain）。"""
    if not (key.p and key.q):
        raise ValueError("导出私钥需要 p / q")
    dmp1 = key.d % (key.p - 1)
    dmq1 = key.d % (key.q - 1)
    iqmp = pow(key.q, -1, key.p)
    der = seq(
        integer(0), integer(key.n), integer(key.e), integer(key.d),
        integer(key.p), integer(key.q), integer(dmp1), integer(dmq1), integer(iqmp),
    )
    return _pem("RSA PRIVATE KEY", der)


def pem_certificate(der):
    return _pem("CERTIFICATE", der)


def load_certificate(pem_text):
    """从 PEM 文本读出证书 DER（忽略文件里的额外说明与多余空行）。"""
    label, der = _pem_body(pem_text)
    if label != "CERTIFICATE":
        raise ValueError("不是证书：%s" % label)
    return der


def _pem_body(text):
    m = re.search(r"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", text, re.S)
    if not m:
        raise ValueError("不是 PEM 文件")
    return m.group(1), base64.b64decode(re.sub(r"\s+", "", m.group(2)))


def _seq_integers(der):
    tag, cs, cl = _read_tlv(der, 0)
    if tag != 0x30:
        raise ValueError("期望 SEQUENCE")
    # 注意：_walk 给的是**相对切片**的偏移，必须落在切片上，不能拿回全量 buffer 用
    body = der[cs:cs + cl]
    return [int.from_bytes(body[c:c + l], "big") for (t, _, c, l) in _walk(body) if t == 0x02]


def load_private_key(pem_text):
    """读取 PKCS#1 或 PKCS#8 的 RSA 私钥（兼容老版本 openssl 留下的 ca.key）。"""
    label, der = _pem_body(pem_text)
    if label == "RSA PRIVATE KEY":
        ints = _seq_integers(der)
    elif label == "PRIVATE KEY":
        # PKCS#8: SEQUENCE { version, AlgorithmIdentifier, OCTET STRING(PKCS#1) }
        _, cs, cl = _read_tlv(der, 0)
        parts = list(_walk(der[cs:cs + cl]))
        octets = [p for p in parts if p[0] == 0x04]
        if not octets:
            raise ValueError("PKCS#8 里没有私钥")
        _, _, ocs, ocl = octets[0]
        ints = _seq_integers(der[cs:cs + cl][ocs:ocs + ocl])
    else:
        raise ValueError("不支持的私钥类型：%s" % label)
    if len(ints) < 6:
        raise ValueError("私钥参数不全")
    _, n, e, d, p, q = ints[:6]
    return RSAKey(n, e, d, p, q)


# ---------------------------------------------------------------- X.509


def _name(common_name, org=None):
    rdns = [setof(seq(_oid(OID_CN), utf8_string(common_name)))]
    if org:
        rdns.append(setof(seq(_oid(OID_O), utf8_string(org))))
    return seq(*rdns)


def _validity(days):
    # notBefore 提前一天：用户机器时钟略慢时也不会被判"证书还没生效"
    nb = time.gmtime(time.time() - 86400)
    na = time.gmtime(time.time() + days * 86400)
    return seq(_time(nb), _time(na))


def _public_key_der(key):
    return seq(integer(key.n), integer(key.e))


def _spki(key):
    return seq(seq(_oid(OID_RSA), _NULL), bit_string(_public_key_der(key)))


def _key_id_from_spki(spki_der):
    """RFC 5280 方法 1：subjectPublicKey BIT STRING 内容的 SHA-1。"""
    _, cs, cl = _read_tlv(spki_der, 0)
    body = spki_der[cs:cs + cl]
    for tag, _, pcs, pcl in _walk(body):
        if tag == 0x03:
            return hashlib.sha1(body[pcs + 1:pcs + pcl]).digest()
    raise ValueError("SPKI 结构异常")


def _key_id(key):
    return hashlib.sha1(_public_key_der(key)).digest()


def _extension(oid, critical, body_der):
    return seq(*([_oid(oid)] + ([boolean(True)] if critical else []) + [octet_string(body_der)]))


def _extensions(*exts):
    return explicit(3, seq(*exts))


def _serial():
    # 128 位随机正整数，最高位清零避免被当成负数
    return _rand.getrandbits(127) | 1


def _sign_cert(tbs, issuer_key):
    return seq(tbs, _SIG_ALG, bit_string(issuer_key.sign_sha256(tbs)))


def build_ca(common_name="QRScan Local CA", org="QRScan", days=3650, bits=2048):
    """生成自签名根证书。返回 (证书 DER, RSAKey)。"""
    key = generate_key(bits)
    subject = _name(common_name, org)
    tbs = seq(
        explicit(0, integer(2)),          # v3
        integer(_serial()),
        _SIG_ALG,
        subject,                          # issuer == subject
        _validity(days),
        subject,
        _spki(key),
        _extensions(
            _extension(OID_BASIC_CONSTRAINTS, True, seq(boolean(True))),
            _extension(OID_KEY_USAGE, True, KU_CA),
            _extension(OID_SKI, False, octet_string(_key_id(key))),
        ),
    )
    return _sign_cert(tbs, key), key


def parse_cert(der):
    """取出证书的 subject 与 SPKI 原始 TLV（签发叶子证书时要逐字节复用）。"""
    _, cs, cl = _read_tlv(der, 0)
    tbs_tag, tbs_start, tbs_cs, tbs_cl = next(_walk(der[cs:cs + cl]))
    if tbs_tag != 0x30:
        raise ValueError("证书结构异常")
    tbs = der[cs:cs + cl][tbs_cs:tbs_cs + tbs_cl]
    items = list(_walk(tbs))
    # tbs 字段顺序（RFC 5280）：[0]version?, serial, sigAlg, issuer, validity, subject, spki, ...
    idx = 0
    if items and items[0][0] == 0xA0:
        idx = 1
    if len(items) < idx + 6:
        raise ValueError("TBSCertificate 字段不全")
    subject_tlv = tbs[items[idx + 4][1]:items[idx + 4][2] + items[idx + 4][3]]
    spki_tlv = tbs[items[idx + 5][1]:items[idx + 5][2] + items[idx + 5][3]]
    return {"subject": subject_tlv, "spki": spki_tlv}


def build_leaf(host, ca_cert_der, ca_key, leaf_key, org="QRScan", days=3650):
    """用 CA 给某个域名（或 IP）签一张叶子证书。"""
    host = (host or "").strip()
    if not host:
        raise ValueError("host 不能为空")
    info = parse_cert(ca_cert_der)
    is_ip = re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host) is not None

    if is_ip:
        san = tlv(0x87, bytes(int(x) for x in host.split(".")))
    else:
        try:
            ascii_host = host.encode("idna").decode("ascii")
        except Exception:
            ascii_host = host
        san = tlv(0x82, ascii_host.encode("ascii"))

    tbs = seq(
        explicit(0, integer(2)),
        integer(_serial()),
        _SIG_ALG,
        info["subject"],                  # issuer：逐字节复用 CA 的 subject
        _validity(days),
        _name(host, org),
        _spki(leaf_key),
        _extensions(
            _extension(OID_BASIC_CONSTRAINTS, False, seq()),
            _extension(OID_KEY_USAGE, True, KU_LEAF),
            _extension(OID_EXT_KEY_USAGE, False, seq(_oid(OID_SERVER_AUTH))),
            _extension(OID_SAN, False, seq(san)),
            _extension(OID_AKI, False,
                       # keyIdentifier 是 [0] **IMPLICIT** OCTET STRING（tag 0x80）。
                       # 早期这里写成 explicit(0, octet_string(...))，编出的是
                       # A0 16 04 14 ... —— OpenSSL 与 Windows 都肯忍，但 Chromium
                       # 的 BoringSSL 判为非法扩展，直接报 ERR_CERT_INVALID
                       # （表现：所有 HTTPS 走代理都"您的连接不是私密连接"）。
                       seq(tlv(0x80, _key_id_from_spki(info["spki"])))),
            _extension(OID_SKI, False, octet_string(_key_id(leaf_key))),
        ),
    )
    return _sign_cert(tbs, ca_key)
