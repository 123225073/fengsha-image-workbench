"""CPA connections, model catalog and OpenAI-compatible transport."""

import base64
import binascii
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import struct
import time
from contextlib import contextmanager
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
import uuid
import xml.etree.ElementTree as ET
import zlib

from cryptography.fernet import Fernet, InvalidToken

from commercial_billing import MODEL_PRICE_MAX


CAPABILITIES = {
    "image": ("generate", "reference", "mask", "multiReference", "imageStream", "gif", "svg"),
    "chat": ("text", "vision", "stream"),
}
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9/_.:@+-]{0,199}\Z")
DIMENSIONS = re.compile(r"([1-9][0-9]{1,4})[x×]([1-9][0-9]{1,4})\Z", re.I)
MAX_IMAGE = 64 * 1024 * 1024
MAX_INPUT_IMAGES = 16
DEFAULT_INPUT_IMAGES = 9
MAX_RESPONSE = 96 * 1024 * 1024
MAX_CHAT = 2 * 1024 * 1024
TOKEN_UNIT = 1_000_000
COMPAT_IMAGE_SIZES = ("1024x1024", "1536x1024", "1024x1536")
# These models returned empty SSE streams on the reference-image route in live tests.
NON_STREAMING_IMAGE_EDITS = frozenset({
    "gpt-image-2.5", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst",
})
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
_SECRET_PATHS = {}
_MEMORY_KEY = Fernet.generate_key()
_TLS = ssl.create_default_context()


class ProviderError(Exception):
    def __init__(self, status, message, uncertain=False, request_id=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.uncertain = uncertain
        self.request_id = request_id
        self.size_rejection = None
        self.tools_unsupported = False
        self.stream_unsupported = False


def setup(db, secret_path=None):
    if secret_path is not None:
        _SECRET_PATHS[_database_file(db)] = Path(secret_path)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS cpa_connections (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
            secret BLOB NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
            created INTEGER NOT NULL, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cpa_models (
            id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES cpa_connections(id),
            model_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
            capabilities TEXT NOT NULL, sizes TEXT NOT NULL, max_references INTEGER NOT NULL,
            price INTEGER NOT NULL, enabled INTEGER NOT NULL, tests TEXT NOT NULL DEFAULT '{}',
            created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(connection_id,model_id)
        );
        CREATE TABLE IF NOT EXISTS cpa_defaults (
            kind TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES cpa_models(id)
        );
        CREATE TABLE IF NOT EXISTS cpa_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
            target TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL
        );
    """)
    columns = {row[1] for row in db.execute("PRAGMA table_info(cpa_models)")}
    for name in ("input_rate", "output_rate"):
        if name not in columns:
            db.execute(f"ALTER TABLE cpa_models ADD COLUMN {name} INTEGER")
    if "agent_mode" not in columns:
        db.execute("ALTER TABLE cpa_models ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'native'")
    if "context_window" not in columns:
        db.execute("ALTER TABLE cpa_models ADD COLUMN context_window INTEGER")
    # Legacy flat prices do not specify an input or output rate.
    db.execute("UPDATE cpa_models SET enabled=0 WHERE kind='chat' AND enabled=1 AND input_rate IS NULL")
    db.execute("DELETE FROM cpa_defaults WHERE kind='chat' AND model_id IN (SELECT id FROM cpa_models WHERE enabled=0)")


def _database_file(db):
    return db.execute("PRAGMA database_list").fetchone()[2]


def _cipher(db):
    supplied = os.getenv("FENGSHA_PROVIDER_ENCRYPTION_KEY")
    if supplied:
        key = supplied.encode("utf-8")
    else:
        filename = _database_file(db)
        if not filename and filename not in _SECRET_PATHS:
            return Fernet(_MEMORY_KEY)
        keyfile = _SECRET_PATHS[filename] if filename in _SECRET_PATHS else Path(filename).with_name("provider-secret.key")
        try:
            key = keyfile.read_bytes().strip()
        except FileNotFoundError:
            # An existing encrypted connection signals a missing secret file, not a fresh setup.
            has_upscale_keys = (db.execute("SELECT 1 FROM sqlite_master WHERE name='upscale_credentials'").fetchone()
                                and db.execute("SELECT 1 FROM upscale_credentials LIMIT 1").fetchone())
            if db.execute("SELECT 1 FROM cpa_connections LIMIT 1").fetchone() or has_upscale_keys:
                raise ProviderError(503, "模型密钥文件缺失，请恢复原密钥文件。") from None
            keyfile.parent.mkdir(parents=True, exist_ok=True)
            try:
                descriptor = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                key = keyfile.read_bytes().strip()
            else:
                key = Fernet.generate_key()
                with os.fdopen(descriptor, "wb") as output:
                    output.write(key)
        except OSError:
            raise ProviderError(503, "无法读取模型密钥文件。") from None
    try:
        return Fernet(key)
    except (TypeError, ValueError):
        raise ProviderError(503, "模型密钥配置无效。") from None


def _connection_key(db, row):
    try:
        return _cipher(db).decrypt(bytes(row["secret"])).decode("utf-8")
    except (InvalidToken, UnicodeError):
        raise ProviderError(503, "无法解密此连接的 API Key，请核对密钥配置。") from None


def _api_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[!-~]{1,4096}", value.strip()):
        raise ProviderError(400, "请填写有效的 API Key。")
    return value.strip()


def _clean_label(value, label):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 100 or any(ord(c) < 32 for c in value.strip()):
        raise ProviderError(400, f"请填写有效的{label}，最多 100 个字符。")
    return value.strip()


def _parse_url(url):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise ProviderError(400, "服务地址格式无效。")
    try:
        parsed = urlsplit(url)
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".") if parsed.hostname else ""
    except (ValueError, UnicodeError):
        raise ProviderError(400, "服务地址格式无效。") from None
    if not host or not port or parsed.scheme not in ("https", "http") or parsed.username is not None or parsed.fragment or "\\" in url or "%" in host:
        raise ProviderError(400, "请输入有效的 HTTPS 服务地址。")
    domain = f"[{host}]" if ":" in host else host
    if port != (443 if parsed.scheme == "https" else 80):
        domain += f":{port}"
    origin = f"{parsed.scheme}://{domain}"
    return parsed, host, port, origin


def _local_fixture(host, origin):
    try:
        return origin == os.getenv("FENGSHA_CPA_TEST_ORIGIN") and ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_url(url):
    parsed, host, _, origin = _parse_url(url.strip() if isinstance(url, str) else url)
    if parsed.query or (parsed.scheme != "https" and not _local_fixture(host, origin)):
        raise ProviderError(400, "Base URL 须为 HTTPS 基础地址，例如 https://api.example.com/v1。")
    path = parsed.path.rstrip("/")
    if not re.fullmatch(r"(?:/[A-Za-z0-9_.~-]+)*", path) or any(part in (".", "..") for part in path.split("/")):
        raise ProviderError(400, "请填写 API 基础地址。")
    if path.endswith(("/models", "/chat/completions", "/images/generations", "/images/edits", "/responses")):
        raise ProviderError(400, "请填写 API 基础地址，去掉 models、chat/completions 或 images 等接口后缀。")
    return origin + (path if path.endswith("/v1") else path + "/v1")


def _outbound(url):
    parsed, host, port, origin = _parse_url(url)
    fixture = _local_fixture(host, origin)
    if parsed.scheme != "https" and not fixture:
        raise ProviderError(400, "外部模型服务及图片下载地址必须使用 HTTPS。")
    allowed_private = {item.strip() for item in os.getenv("FENGSHA_CPA_PRIVATE_ORIGINS", "").split(",")}
    try:
        addresses = list(dict.fromkeys(result[4][0] for result in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    except OSError:
        raise ProviderError(502, "无法解析模型服务的地址。") from None
    parsed_addresses = [ipaddress.ip_address(address) for address in addresses]
    if any(address.is_multicast or address.is_unspecified for address in parsed_addresses):
        raise ProviderError(400, "模型服务必须使用可直接连接的单播地址。")
    if not addresses or any(not address.is_global for address in parsed_addresses):
        if not fixture and origin not in allowed_private:
            raise ProviderError(400, "当前环境未允许访问该模型服务的网络地址。")
    target = urlunsplit(("", "", quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(parsed.query, safe="%&=+?/:@!$'()*;,~-._"), ""))
    return parsed.scheme, host, port, origin, target, addresses


@contextmanager
def _response(url, *, key=None, data=None, content_type=None, timeout=180, extra_headers=None, public_only=False):
    scheme, host, port, origin, target, addresses = _outbound(url)
    if public_only and any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ProviderError(400, "联网资料必须来自公开互联网地址。")
    submission = data is not None
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    stream = None
    request_id = None
    try:
        for address in addresses:
            try:
                stream = socket.create_connection((address, port), timeout=min(timeout, 8))
                break
            except OSError:
                continue
        if stream is None:
            raise ProviderError(502, "无法连接模型服务，请检查网络和地址。")
        if scheme == "https":
            stream = _TLS.wrap_socket(stream, server_hostname=host)
        stream.settimeout(timeout)
        connection.sock = stream
        headers = {"Accept": "application/json, image/*, text/event-stream", "Host": origin.split("://", 1)[1]}
        if key:
            headers["Authorization"] = "Bearer " + key
        if content_type:
            headers["Content-Type"] = content_type
        if extra_headers:
            headers.update(extra_headers)
        connection.request("POST" if submission else "GET", target, data, headers)
        response = connection.getresponse()
        request_id = _safe_id(response.getheader("x-request-id"))
        yield response
    except (OSError, http.client.HTTPException):
        message = "模型请求已中断，结果待核对。" if submission else "读取模型服务响应失败。"
        raise ProviderError(502, message, uncertain=submission, request_id=request_id) from None
    finally:
        connection.close()
        if stream is not None:
            stream.close()


def _safe_id(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:+/-]{1,180}", value) else None


def _read(response, limit, submission=False):
    length = response.getheader("Content-Length")
    if length and length.isdecimal() and int(length) > limit:
        raise ProviderError(502, "模型服务响应超过大小限制。", uncertain=submission,
                            request_id=_safe_id(response.getheader("x-request-id")))
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ProviderError(502, "模型服务响应超过大小限制。", uncertain=submission,
                            request_id=_safe_id(response.getheader("x-request-id")))
    return data


def _image_rejection_message(detail, status):
    """Describe only known upstream codes and fields, never echo the response body."""
    code = str(detail.get("code") or "").lower()
    kind = str(detail.get("type") or "").lower()
    field = str(detail.get("param") or "").lower()
    policy_codes = {"content_policy_violation", "content_filter", "moderation_blocked", "safety_violation",
                    "image_safety_violation", "image_content_policy_violation"}
    if code in policy_codes or kind in policy_codes:
        return f"上游报告内容审核拒绝（HTTP {status}）。服务未说明具体触发项。", True
    if field in {"image", "image[]", "images", "reference_images", "mask"}:
        return f"上游拒绝了参考图、输入图片或蒙版字段（HTTP {status}）。请核对当前模型支持的输入格式、数量和尺寸。", False
    if field in {"size", "image_size", "aspect_ratio", "resolution", "width", "height"}:
        return f"上游拒绝了输出尺寸字段（HTTP {status}）。请核对当前模型支持的尺寸。", False
    return f"上游拒绝了生图请求（HTTP {status}），未能确认具体原因。", False


def _status_error(response, submission=False, *, image_request=False):
    status = response.status
    request_id = _safe_id(response.getheader("x-request-id"))
    errors = {
        400: "模型服务拒绝了请求参数。",
        401: "模型服务拒绝了当前 API Key。",
        402: "模型服务额度不足。",
        403: "当前 API Key 没有该接口或模型的权限。",
        404: "模型服务找不到该接口或模型，请核对地址和模型 ID。",
        408: "模型服务响应超时，请核对任务结果。",
        422: "模型服务拒绝了输入内容或格式。",
        429: "模型服务已限流或额度暂不可用。",
    }
    error = ProviderError(status if status in errors else 502, errors.get(status, "模型服务返回异常响应。"),
                          submission and (status == 408 or status >= 500), request_id)
    if submission and (status in (400, 422) or image_request and status == 403):
        # Inspect a bounded response without logging or exposing the upstream body.
        detail = response.read(32769)
        if len(detail) <= 32768:
            policy_blocked = False
            if image_request:
                try:
                    value = json.loads(detail)
                except (ValueError, UnicodeError):
                    value = None
                fields = value.get("error", value) if isinstance(value, dict) else None
                fields = fields if isinstance(fields, dict) else {}
                message, policy_blocked = _image_rejection_message(fields, status)
                if status != 403 or policy_blocked:
                    error = ProviderError(status, message, request_id=request_id)
            if status in (400, 422) and not policy_blocked:
                error.size_rejection = _size_rejection(detail)
                error.tools_unsupported = _tools_unsupported(detail)
                error.stream_unsupported = _stream_unsupported(detail)
    return error


def _tools_unsupported(raw):
    try:
        value = json.loads(raw)
    except (UnicodeError, ValueError):
        value = raw.decode("utf-8", errors="replace")
    detail = value.get("error", value) if isinstance(value, dict) else value
    if isinstance(detail, dict):
        parameter = str(detail.get("param") or "").lower()
        code = str(detail.get("code") or "").lower()
        message = str(detail.get("message") or "").lower()
    else:
        parameter, code, message = "", "", str(detail).lower()
    names = r"(?:tools|tool_choice|function calling|tool calling)"
    if parameter in {"tools", "tool_choice"} and code in {
        "unsupported_parameter", "unsupported_value", "unknown_parameter", "unrecognized_parameter", "unsupported_feature",
    }:
        return True
    return bool(re.search(
        rf"\b(?:unknown|unrecognized|unsupported|unexpected) (?:request )?(?:field|parameter|argument)(?: supplied)?\s*[:=]?\s*['`\"]?{names}\b"
        rf"|\b{names}['`\"]? (?:is |are )?not supported\b|\b(?:does not|doesn't) support {names}\b"
        r"|不支持(?:工具调用|函数调用|\s*tools\b|\s*tool_choice\b)",
        message,
    ))


def _stream_unsupported(raw):
    try:
        value = json.loads(raw)
    except (UnicodeError, ValueError):
        return False
    detail = value.get("error", value) if isinstance(value, dict) else {}
    return isinstance(detail, dict) and detail.get("param") in ("stream", "partial_images") and detail.get("code") in (
        "unsupported_parameter", "unsupported_value", "unknown_parameter", "unrecognized_parameter", "unsupported_feature")


def _json_request(config, endpoint, *, payload=None, raw=None, content_type=None, limit=MAX_RESPONSE, receipt=None):
    if payload is not None:
        raw, content_type = json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json"
    start = time.monotonic()
    with _response(config["baseUrl"] + endpoint, key=config["key"], data=raw, content_type=content_type) as response:
        if not 200 <= response.status < 300:
            raise _status_error(response, raw is not None, image_request=endpoint.startswith("/images/"))
        data = _read(response, limit, raw is not None)
        request_id = _safe_id(response.getheader("x-request-id"))
    try:
        value = json.loads(data)
    except (UnicodeError, ValueError):
        raise ProviderError(502, "模型服务没有返回有效 JSON。", raw is not None, request_id) from None
    if not isinstance(value, dict):
        raise ProviderError(502, "模型服务返回的 JSON 格式不正确。", raw is not None, request_id)
    if receipt is not None:
        receipt.update(endpoint=endpoint, requestId=request_id, responseId=_safe_id(value.get("id")),
                       elapsedMs=round((time.monotonic() - start) * 1000))
        if isinstance(value.get("usage"), dict):
            receipt["usage"] = {key: amount for key, amount in value["usage"].items()
                                if key in ("prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens")
                                and type(amount) is int and amount >= 0}
    return value


def discover(base_url, key):
    result = _json_request({"baseUrl": normalize_url(base_url), "key": _api_key(key)}, "/models", limit=8 * 1024 * 1024)
    data = result.get("data")
    if not isinstance(data, list):
        raise ProviderError(502, "模型目录格式不正确，请核对服务地址和协议。")
    models = {}
    for row in data:
        if not isinstance(row, dict):
            continue
        model_id = row.get("id")
        if isinstance(model_id, str) and MODEL_ID.fullmatch(model_id):
            label = row.get("name") or row.get("display_name")
            models[model_id] = {"id": model_id, "name": label[:100] if isinstance(label, str) else model_id}
            window = row.get('context_window') or row.get('context_length') or row.get('max_model_len')
            if type(window) is int and 16384 <= window <= 10_000_000:
                models[model_id]['contextWindowTokens'] = window
    if not models:
        raise ProviderError(404, "服务返回的模型目录为空，可以核对权限或手工添加模型 ID。")
    return {"models": sorted(models.values(), key=lambda model: model["id"].lower())}


def _dimensions(size):
    match = DIMENSIONS.fullmatch(size.strip()) if isinstance(size, str) else None
    return tuple(map(int, match.groups())) if match else None


def _size_rejection(raw):
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        data = raw.decode("utf-8", errors="replace")
    detail = data.get("error", data) if isinstance(data, dict) else data
    if isinstance(detail, dict):
        message, parameter, code = (str(detail.get(field) or "").lower() for field in ("message", "param", "code"))
    else:
        message, parameter, code = str(detail).lower(), "", ""
    input_size = re.search(r"(?:reference|input|uploaded|mask) (?:image|file|dimension)|参考图|上传的图片|蒙版尺寸", message)
    fields = {"size", "image_size", "aspect_ratio", "resolution", "width", "height"}
    if input_size or (parameter and parameter not in fields):
        return None
    omit = parameter in {"size", "image_size"} and code in {"unsupported_parameter", "unknown_parameter", "unrecognized_parameter"}
    omit = omit or bool(re.search(r"(?:unknown|unrecognized|unexpected|unsupported) (?:field|parameter|argument)\s*[:=]?\s*['\"`]?(?:image_)?size\b", message))
    if omit:
        return {"omit": True, "sizes": []}
    validation = re.search(r"invalid|unsupported|not support|must|only|one of|allowed|too (?:large|small)|不支持|无效|仅支持|必须|超出", message)
    size_code = re.fullmatch(r"(?:(?:invalid|unsupported)_(?:image_)?(?:size|resolution|aspect_ratio)|(?:size|resolution|aspect_ratio)_(?:not_supported|invalid))", code)
    output_size = re.search(r"['\"`]size['\"`]|\b(?:output|requested|unsupported|invalid) size\b|\b(?:size|resolution)\s+(?:must|is invalid|is not supported|not supported|should|only)|\bnot support (?:the )?(?:size|resolution)\b|\baspect ratio\b|输出尺寸|图片尺寸|分辨率|长宽比|宽高比", message)
    if not (size_code or parameter in fields and (validation or code == "invalid_value") or not parameter and output_size and validation):
        return None
    options = re.search(r"(?:supported (?:sizes|values|resolutions)|one of|only supports?|allowed (?:sizes|values)|仅支持|可选尺寸|支持的尺寸)\s*[:：]?([^\n]+)", message)
    structured = []
    if isinstance(detail, dict):
        for key in ("supported_sizes", "allowed_sizes", "allowed_values", "supported_values"):
            if isinstance(detail.get(key), list):
                structured.extend(item for item in detail[key] if _dimensions(item))
    choices = options.group(1) if options else ""
    sizes = structured + [f"{w}x{h}" for w, h in re.findall(r"\b([1-9]\d{1,4})\s*[x×]\s*([1-9]\d{1,4})\b", choices)]
    return {"omit": False, "sizes": sizes}


def _compat_sizes(requested, declared, configured):
    w, h = _dimensions(requested)
    ratio, area = w / h, w * h
    def distance(size):
        width, height = _dimensions(size)
        return abs(math.log((width / height) / ratio)) + 0.15 * abs(math.log((width * height) / area))
    def normalize(values):
        return ["x".join(map(str, dims)) for size in values if (dims := _dimensions(size)) and min(dims) >= 64 and max(dims) <= 4096]
    candidates = normalize(declared) or normalize(configured) or COMPAT_IMAGE_SIZES
    sizes = list(dict.fromkeys(size for size in candidates if size != requested))
    return sorted(sizes, key=distance)[:6] + ["auto", None]


def _multipart(fields, images, mask):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for key, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8"))
    files = [("image" if len(images) == 1 else "image[]", item) for item in images]
    if mask is not None:
        files.append(("mask", mask))
    for index, (field, item) in enumerate(files, 1):
        _, mime, data = item
        if mime not in IMAGE_TYPES or not isinstance(data, bytes) or not data:
            raise ProviderError(400, "请选择有效的 PNG、JPEG、WebP 或 GIF 素材。")
        filename = f"reference-{index}.{IMAGE_TYPES[mime]}"
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode("ascii"))
        body.extend(data)
        body.extend(b"\r\n")
        if len(body) > MAX_IMAGE:
            raise ProviderError(413, "本次图片请求总大小超过 64 MB，请缩小部分素材后再提交。")
    body.extend(f"--{boundary}--\r\n".encode("ascii"))
    return body, f"multipart/form-data; boundary={boundary}"


def _is_image(data):
    return data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a")) or data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def svg_dimensions(data):
    """Validate a static SVG before exposing it as a downloadable image."""
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("SVG exceeds the file size limit")
    try:
        source = data.decode("utf-8-sig")
        if re.search(r"<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\s)", source, re.I):
            raise ValueError("SVG contains external declarations")
        root = ET.fromstring(source)
    except (UnicodeError, ET.ParseError) as error:
        raise ValueError("Invalid SVG") from error
    namespace = "{http://www.w3.org/2000/svg}"
    shapes = {"path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "text"}
    permitted = shapes | {"svg", "g", "defs", "linearGradient", "radialGradient", "stop", "clipPath",
                          "mask", "symbol", "use", "title", "desc", "tspan", "pattern", "marker"}
    found_shape = False
    if root.tag != namespace + "svg":
        raise ValueError("Expected an SVG document")
    for node in root.iter():
        name = node.tag.removeprefix(namespace)
        if node.tag != namespace + name or name not in permitted:
            raise ValueError("SVG contains unsupported elements")
        found_shape |= name in shapes
        for key, value in node.attrib.items():
            attr = key.rsplit("}", 1)[-1].lower()
            if attr in {"href", "src"} and not re.fullmatch(r"#[\w:.-]+", value):
                raise ValueError("SVG contains an external resource")
            if (attr.startswith("on") or attr == "base" or re.search(r"[\\@]|/\*", value)
                    or re.search(r"url\s*\(", re.sub(r"url\s*\(\s*['\"]?#[\w:.-]+['\"]?\s*\)", "", value, flags=re.I), re.I)):
                raise ValueError("SVG contains unsupported attributes")
    if not found_shape:
        raise ValueError("SVG has no vector shapes")
    dimensions = [re.fullmatch(r"(\d+(?:\.\d+)?)(?:px)?", root.get(key, "")) for key in ("width", "height")]
    try:
        if all(dimensions):
            width, height = (float(match[1]) for match in dimensions)
        else:
            _, _, width, height = map(float, re.split(r"[\s,]+", root.get("viewBox", "").strip()))
        if not all(math.isfinite(value) and 1 <= value <= 16384 for value in (width, height)):
            raise ValueError("Invalid SVG dimensions")
    except (ValueError, OverflowError) as error:
        raise ValueError("Invalid SVG dimensions") from error
    return round(width), round(height)


def _valid_output(data, output_format):
    if output_format == "svg":
        try:
            svg_dimensions(data)
        except ValueError:
            return False
        return True
    if output_format == "gif":
        from io import BytesIO
        from PIL import Image

        try:
            with Image.open(BytesIO(data), formats=["GIF"]) as image:
                return 2 <= image.n_frames <= 16
        except (OSError, ValueError, Image.DecompressionBombError):
            return False
    return _is_image(data)


def _download_image(url, config):
    origin = _parse_url(config["baseUrl"])[3]
    try:
        url = urljoin(config["baseUrl"] + "/", url)
        key = config["key"]
        for _ in range(4):
            if _parse_url(url)[3] != origin:
                key = None
            with _response(url, key=key, timeout=45) as response:
                if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
                    url = urljoin(url, response.getheader("Location"))
                    continue
                if response.status != 200:
                    raise _status_error(response)
                return _read(response, MAX_IMAGE)
    except (ProviderError, ValueError, TypeError):
        raise ProviderError(502, "模型已返回结果，但暂时无法下载图片。请核对原任务。", True) from None
    raise ProviderError(502, "模型图片下载重定向过多，请核对原任务。", True)


def recover_image(config, url, output_format=None):
    """Recover bytes from the original result address without resubmitting a model request."""
    image = _download_image(url, config)
    if not _valid_output(image, output_format):
        raise ProviderError(502, "原任务返回的文件格式不符，请核对。", True)
    return image


def _image_result(value, config, receipt, output_format=None):
    request_id = receipt.get("requestId")
    entries = value.get("data")
    if isinstance(entries, list):
        for item in entries:
            if not isinstance(item, dict):
                continue
            encoded = item.get("b64_json")
            if isinstance(encoded, str) and 0 < len(encoded) <= MAX_RESPONSE:
                try:
                    image = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error):
                    image = b""
            elif isinstance(item.get("url"), str) and item["url"]:
                receipt["resultUrl"] = item["url"]
                try:
                    image = recover_image(config, item["url"], output_format)
                except ProviderError as error:
                    error.request_id = request_id
                    raise
            else:
                continue
            if 0 < len(image) <= MAX_IMAGE and _valid_output(image, output_format):
                return image
    if output_format:
        raise ProviderError(502, f"上游未返回有效的 {output_format.upper()} 成品，请核对原任务。", True, request_id)
    raise ProviderError(502, "模型已响应，但未返回可识别的图片。请核对原任务。", True, request_id)


def _stream_image(config, endpoint, payload, images, mask, receipt, on_preview):
    if images:
        raw, content_type = _multipart({**payload, "stream": "true"}, images, mask)
    else:
        raw, content_type = json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json"
    with _response(config["baseUrl"] + endpoint, key=config["key"], data=raw, content_type=content_type) as response:
        if not 200 <= response.status < 300:
            raise _status_error(response, True, image_request=True)
        request_id = _safe_id(response.getheader("x-request-id"))
        receipt["requestId"] = request_id
        if "text/event-stream" not in (response.getheader("Content-Type") or "").lower():
            # Some compatible services ignore stream options but deliver the final image in the same call.
            try:
                value = json.loads(_read(response, MAX_RESPONSE, True))
            except (ValueError, UnicodeError):
                raise ProviderError(502, "模型未返回可识别的生图结果。", True, request_id) from None
            return _image_result(value if isinstance(value, dict) else {}, config, receipt)
        named_event = None
        saw_event = False
        saw_preview = False
        total = 0
        while line := response.readline(MAX_RESPONSE + 1):
            total += len(line)
            if len(line) > MAX_RESPONSE or total > MAX_RESPONSE * 4:
                raise ProviderError(502, "流式图片超过大小限制。", True, request_id)
            if not line.strip():
                named_event = None
                continue
            if line.startswith(b"event:"):
                named_event = line[6:].strip().decode("ascii", errors="replace")
                continue
            if not line.startswith(b"data:"):
                continue
            chunk = line[5:].strip()
            if chunk == b"[DONE]":
                break
            try:
                event = json.loads(chunk)
            except (ValueError, UnicodeError):
                raise ProviderError(502, "模型返回了无效的流式图片。", True, request_id) from None
            saw_event = True
            if not isinstance(event, dict) or event.get("error") or named_event == "error":
                raise ProviderError(502, "模型服务在流式响应中报告了错误，未保存成品。", True, request_id)
            kind = event.get("type") or named_event
            if kind in ("image_generation.completed", "image_edit.completed"):
                if isinstance(event.get("data"), list):
                    return _image_result(event, config, receipt)
                return _image_result({"data": [event]}, config, receipt)
            if kind in ("image_generation.partial_image", "image_edit.partial_image"):
                try:
                    preview = _image_result({"data": [{"b64_json": event.get("b64_json")}]}, config, receipt)
                except ProviderError:
                    continue
                saw_preview = True
                on_preview(preview)
        if saw_preview:
            reason = "上游仅发送了预览图，未发送最终成品。"
        elif saw_event:
            reason = "上游结束了流式响应，未发送可识别的最终成品。"
        else:
            reason = "上游建立了流式连接，但没有返回任何图片事件，未保存成品。"
        raise ProviderError(502, reason, True, request_id)


def generate(config, prompt, size, images=None, mask=None, *, receipt=None, on_preview=None, output=None):
    """Return encoded image bytes and the size sent to the successful submission."""
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 14000:
        raise ProviderError(400, "请填写有效的生图提示词。")
    if not _dimensions(size):
        raise ProviderError(400, "请输入有效的生成尺寸。")
    size = "x".join(map(str, _dimensions(size)))
    images = images or []
    if len(images) > config.get("maxReferences", DEFAULT_INPUT_IMAGES) or mask is not None and not images:
        raise ProviderError(400, "参考素材数量或蒙版设置超出当前模型能力。")
    endpoint = "/images/edits" if images else "/images/generations"
    fields = {"model": config["model"], "prompt": prompt, "n": 1}
    output_format = output.get("format") if output else None
    if output_format:
        fields["output_format"] = output_format
        if output_format == "gif":
            fields.update(frame_count=output["frames"], frame_duration_ms=output["frameDurationMs"])
    received = receipt if receipt is not None else {}
    received["endpoint"] = endpoint
    candidate, alternatives, attempted = size, [], set()
    edit_stream_supported = not images or config["model"] not in NON_STREAMING_IMAGE_EDITS
    streaming = (edit_stream_supported and not output_format and on_preview is not None
                 and "imageStream" in config.get("capabilities", []))
    while True:
        attempted.add(candidate)
        payload = {**fields, "size": candidate} if candidate is not None else fields
        received["submittedSize"] = candidate
        try:
            if streaming:
                image = _stream_image(config, endpoint, {**payload, "stream": True, "partial_images": 2},
                                      images, mask, received, on_preview)
                return image, candidate
            if images:
                raw, content_type = _multipart(payload, images, mask)
                value = _json_request(config, endpoint, raw=raw, content_type=content_type, receipt=received)
            else:
                value = _json_request(config, endpoint, payload=payload, receipt=received)
        except ProviderError as error:
            if streaming and error.stream_unsupported and not error.uncertain:
                streaming = False
                continue
            rejection = error.size_rejection
            if not rejection or candidate is None:
                raise
            if rejection["omit"]:
                alternatives = [None]
            elif candidate == size or rejection["sizes"]:
                alternatives = _compat_sizes(size, rejection["sizes"], config.get("sizes", []))
            alternatives = [option for option in alternatives if option not in attempted]
            if not alternatives or len(attempted) >= 9:
                raise ProviderError(422, "模型拒绝了所选尺寸与兼容尺寸。", request_id=error.request_id) from None
            candidate = alternatives.pop(0)
            continue
        return _image_result(value, config, received, output_format), candidate


def _chat_message(value, field):
    choices = value.get("choices") if isinstance(value, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return {}
    message = choices[0].get(field)
    return message if isinstance(message, dict) else {}


def _chat_text(value, field):
    content = _chat_message(value, field).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part["text"] for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def _chat_events(config, payload, receipt, *, allow_json=False):
    endpoint = "/chat/completions"
    start = time.monotonic()
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with _response(config["baseUrl"] + endpoint, key=config["key"], data=data, content_type="application/json") as response:
        if not 200 <= response.status < 300:
            raise _status_error(response, True)
        request_id = _safe_id(response.getheader("x-request-id"))
        if receipt is not None:
            receipt.update(endpoint=endpoint, requestId=request_id)
        if "text/event-stream" not in (response.getheader("Content-Type") or "").lower():
            if allow_json:
                try:
                    event = json.loads(_read(response, MAX_CHAT, True))
                except (ValueError, UnicodeError):
                    raise ProviderError(502, "模型返回的回复格式无效。", True, request_id) from None
                if isinstance(event, dict) and not event.get("error"):
                    if receipt is not None:
                        receipt["usage"] = event.get("usage")
                    yield event
                    return
            raise ProviderError(502, "模型未返回流式对话。", True, request_id)
        total = 0
        completed = False
        while True:
            line = response.readline(MAX_CHAT + 1)
            if not line:
                break
            total += len(line)
            if total > MAX_CHAT:
                raise ProviderError(502, "流式对话超过大小限制。", True, request_id)
            if not line.startswith(b"data:"):
                continue
            chunk = line[5:].strip()
            if chunk == b"[DONE]":
                completed = True
                break
            try:
                event = json.loads(chunk)
            except (ValueError, UnicodeError):
                raise ProviderError(502, "模型返回了无效的流式对话。", True, request_id) from None
            if not isinstance(event, dict) or event.get("error"):
                raise ProviderError(502, "模型返回了异常的流式对话。", True, request_id)
            if receipt is not None:
                if _safe_id(event.get("id")):
                    receipt["responseId"] = event["id"]
                if isinstance(event.get("usage"), dict):
                    receipt["usage"] = {key: event["usage"][key] for key in ("prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens")
                                        if type(event["usage"].get(key)) is int and event["usage"][key] >= 0}
            yield event
            choices = event.get("choices")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict) and choices[0].get("finish_reason"):
                completed = True
        if receipt is not None:
            receipt["elapsedMs"] = round((time.monotonic() - start) * 1000)
        if not completed:
            raise ProviderError(502, "流式对话提前中断或未返回文本。", True, request_id)


def _chat_stream(config, payload, receipt):
    emitted = False
    for event in _chat_events(config, payload, receipt, allow_json=True):
        chunk = _chat_text(event, "delta") or _chat_text(event, "message")
        if chunk:
            emitted |= bool(chunk.strip())
            yield chunk
    if not emitted:
        raise ProviderError(502, "语言模型未返回文本。", True, (receipt or {}).get("requestId"))


def chat(config, messages, stream=False, *, receipt=None, max_output=None):
    """Return complete text, or an iterator of actual upstream SSE text deltas."""
    if not isinstance(messages, list) or not messages:
        raise ProviderError(400, "请填写对话内容。")
    payload = {"model": config["model"], "messages": messages, "stream": stream}
    if max_output is not None:
        payload["max_completion_tokens"] = max_output
    if stream:
        if receipt is not None:
            payload["stream_options"] = {"include_usage": True}
        return _chat_stream(config, payload, receipt)
    received = receipt if receipt is not None else {}
    value = _json_request(config, "/chat/completions", payload=payload, limit=MAX_CHAT, receipt=received)
    content = _chat_text(value, "message")
    if not content.strip():
        raise ProviderError(502, "语言模型未返回文本。", True, received.get("requestId"))
    return content


def _stream_plan(config, payload, receipt, emit):
    chunks = []
    calls = {}
    emitted = 0
    for event in _chat_events(config, payload, receipt, allow_json=True):
        message = _chat_message(event, "message")
        if message:
            return _chat_text(event, "message"), message.get("tool_calls") or []
        chunk = _chat_text(event, "delta")
        if chunk:
            chunks.append(chunk)
            reply = _plan_reply_preview("".join(chunks))
            if len(reply) > emitted:
                emit(reply[emitted:])
                emitted = len(reply)
        for fragment in _chat_message(event, "delta").get("tool_calls") or []:
            index = fragment.get("index") if isinstance(fragment, dict) else None
            if type(index) is not int or not 0 <= index < 64:
                raise ProviderError(502, "模型返回的工具顺序无效。", True, receipt.get("requestId"))
            call = calls.setdefault(index, {"type": "function", "function": {"name": "", "arguments": ""}})
            function = fragment.get("function") or {}
            if not isinstance(function, dict):
                raise ProviderError(502, "模型返回的工具参数无效。", True, receipt.get("requestId"))
            for key in ("name", "arguments"):
                part = function.get(key)
                if isinstance(part, str):
                    call["function"][key] += part
    return "".join(chunks), [calls[index] for index in sorted(calls)]


_REPLY_PREFIX = re.compile(
    r'^\s*(?:```(?:json)?\s*)?\{\s*"reply"\s*:\s*"((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)',
    re.IGNORECASE,
)


def _plan_reply_preview(raw):
    prefix = raw.lstrip()
    if not prefix:
        return ""
    if prefix[0] not in "{[`":
        return raw
    match = _REPLY_PREFIX.match(raw)
    if not match:
        return ""
    try:
        reply = json.loads('"' + match[1] + '"')
        # A high surrogate can arrive before its low surrogate in another chunk.
        reply.encode("utf-8")
    except (ValueError, UnicodeError):
        return ""
    return reply


def _stream_json_plan(config, messages, receipt, max_output, emit):
    payload = {"model": config["model"], "messages": messages, "stream": True,
               "max_completion_tokens": max_output, "stream_options": {"include_usage": True}}
    chunks = []
    emitted = 0
    for event in _chat_events(config, payload, receipt, allow_json=True):
        if _chat_message(event, "message"):
            return _chat_text(event, "message")
        chunk = _chat_text(event, "delta")
        if not chunk:
            continue
        chunks.append(chunk)
        reply = _plan_reply_preview("".join(chunks))
        if len(reply) > emitted:
            emit(reply[emitted:])
            emitted = len(reply)
    return "".join(chunks)


def plan_chat(config, messages, tools, fallback_instruction, *, receipt, max_output, emit=None):
    """Read one tool plan. Retry as JSON only after explicit rejection of tool calling."""
    def json_plan():
        fallback = [{"role": "system", "content": messages[0]["content"] + "\n" + fallback_instruction}, *messages[1:]]
        if emit is not None and "stream" in config["capabilities"]:
            return _stream_json_plan(config, fallback, receipt, max_output, emit), []
        return chat(config, fallback, receipt=receipt, max_output=max_output), []

    if config.get("agentMode") == "json":
        return json_plan()
    payload = {"model": config["model"], "messages": messages, "stream": False,
               "max_completion_tokens": max_output, "tools": tools, "tool_choice": "auto"}
    try:
        if emit is not None and "stream" in config["capabilities"]:
            content, calls = _stream_plan(config, {**payload, "stream": True, "stream_options": {"include_usage": True}}, receipt, emit)
        else:
            value = _json_request(config, "/chat/completions", payload=payload, limit=MAX_CHAT, receipt=receipt)
            message = _chat_message(value, "message")
            content = _chat_text(value, "message")
            calls = message.get("tool_calls") or []
    except ProviderError as error:
        if not error.tools_unsupported or error.uncertain:
            raise
        return json_plan()
    content = content.strip()
    if not content and not calls:
        raise ProviderError(502, "语言模型未返回对话内容或工具计划。", True, receipt.get("requestId"))
    return content, calls


def _lookup(db, table, identifier, label):
    row = db.execute(f"SELECT * FROM {table} WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise ProviderError(404, f"未找到{label}。")
    return row


def _connection_view(row):
    return {"id": row["id"], "name": row["name"], "baseUrl": row["base_url"],
            "hasKey": bool(row["secret"]), "enabled": bool(row["enabled"])}


def _model_view(row):
    tests = json.loads(row["tests"])
    return {"id": row["id"], "name": row["name"], "kind": row["kind"], "modelId": row["model_id"],
            "connectionId": row["connection_id"], "capabilities": json.loads(row["capabilities"]),
            "sizes": json.loads(row["sizes"]), "maxReferences": row["max_references"],
            "enabled": bool(row["enabled"]), "price": row["price"], "tests": tests,
            "tokenRates": {"input": row["input_rate"], "output": row["output_rate"]} if row["input_rate"] is not None else None,
            "agentMode": row["agent_mode"],
            "contextWindowTokens": row["context_window"] or 65536,
            "contextWindowSource": "configured" if row["context_window"] else "default",
            "verified": [name for name, result in tests.items() if result.get("ok")]}


def _defaults(db):
    values = {"image": None, "chat": None}
    for row in db.execute("SELECT kind,model_id FROM cpa_defaults"):
        values[row["kind"]] = row["model_id"]
    return values


def _active_models(db):
    return db.execute("""SELECT m.* FROM cpa_models m JOIN cpa_connections c ON c.id=m.connection_id
                         WHERE m.enabled=1 AND c.enabled=1 ORDER BY m.created,m.id""").fetchall()


def catalog(db):
    models = []
    for row in _active_models(db):
        entry = _model_view(row)
        models.append({**{key: entry[key] for key in ("id", "name", "kind", "price", "sizes", "maxReferences")},
                       "capabilities": entry["capabilities"], "tokenRates": entry["tokenRates"],
                       "contextWindowTokens": entry["contextWindowTokens"], "contextWindowSource": entry["contextWindowSource"]})
    return {"models": models, "defaults": _defaults(db)}


def _config(db, model):
    connection = _lookup(db, "cpa_connections", model["connectionId"], "模型连接")
    return {**model, "model": model["modelId"], "baseUrl": connection["base_url"], "key": _connection_key(db, connection)}


def resolve(db, kind, model_id=None, capability=None):
    if not isinstance(kind, str) or kind not in CAPABILITIES or capability is not None and capability not in CAPABILITIES[kind]:
        raise ProviderError(400, "模型类型或能力无效。")
    capability = capability or CAPABILITIES[kind][0]
    listing = catalog(db)
    available = [item for item in listing["models"] if item["kind"] == kind and capability in item["capabilities"]]
    selected = model_id or listing["defaults"][kind]
    if not selected and available:
        selected = available[0]["id"]
    if not any(item["id"] == selected for item in available):
        raise ProviderError(409, "请选择已上架且支持当前操作的模型。")
    return _config(db, _model_view(_lookup(db, "cpa_models", selected, "模型")))


def _audit(db, actor, action, target, detail=None):
    db.execute("INSERT INTO cpa_audit(actor,action,target,detail,created) VALUES (?,?,?,?,?)",
               (str(actor), action, target, json.dumps(detail or {}, ensure_ascii=False), int(time.time())))


def _invalidate_connection(db, connection_id):
    db.execute("DELETE FROM cpa_defaults WHERE model_id IN (SELECT id FROM cpa_models WHERE connection_id=?)", (connection_id,))
    db.execute("UPDATE cpa_models SET tests='{}', enabled=0 WHERE connection_id=?", (connection_id,))


def _save_connection(db, payload, actor, row=None):
    name = _clean_label(payload.get("name", row["name"] if row else None), "连接名称")
    base_url = normalize_url(payload.get("baseUrl", row["base_url"] if row else None))
    key = payload.get("key")
    old_url = row["base_url"] if row else None
    if not key and (not row or _parse_url(base_url)[3] != _parse_url(old_url)[3]):
        raise ProviderError(400, "新增连接或变更服务主机时，请填写 API Key。")
    enabled = payload.get("enabled", bool(row["enabled"]) if row else True)
    if type(enabled) is not bool:
        raise ProviderError(400, "连接启用状态无效。")
    changed_key = bool(key) and (not row or _api_key(key) != _connection_key(db, row))
    secret = _cipher(db).encrypt(_api_key(key).encode("utf-8")) if changed_key else row["secret"]
    identifier, now = (row["id"] if row else uuid.uuid4().hex), int(time.time())
    if row:
        changed = changed_key or base_url != old_url
        db.execute("UPDATE cpa_connections SET name=?,base_url=?,secret=?,enabled=?,revision=revision+?,updated=? WHERE id=?",
                   (name, base_url, secret, enabled, int(changed or enabled != bool(row["enabled"])), now, identifier))
        if changed:
            _invalidate_connection(db, identifier)
        if not enabled:
            db.execute("DELETE FROM cpa_defaults WHERE model_id IN (SELECT id FROM cpa_models WHERE connection_id=?)", (identifier,))
    else:
        db.execute("INSERT INTO cpa_connections(id,name,base_url,secret,enabled,created,updated) VALUES (?,?,?,?,?,?,?)",
                   (identifier, name, base_url, secret, enabled, now, now))
    _audit(db, actor, "connection.update" if row else "connection.create", identifier, {"enabled": enabled})
    return {"connection": _connection_view(_lookup(db, "cpa_connections", identifier, "连接"))}


def _save_model(db, payload, actor, row=None):
    old = _model_view(row) if row else {}
    name = _clean_label(payload.get("name", old.get("name")), "模型名称")
    identifier = old.get("id") or uuid.uuid4().hex
    connection_id = payload.get("connectionId", old.get("connectionId"))
    if not isinstance(connection_id, str):
        raise ProviderError(400, "请选择所属连接。")
    connection = _lookup(db, "cpa_connections", connection_id, "模型连接")
    model_id = payload.get("modelId", old.get("modelId"))
    kind = payload.get("kind", old.get("kind"))
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id) or not isinstance(kind, str) or kind not in CAPABILITIES:
        raise ProviderError(400, "请输入有效的模型 ID，并选择模型类型。")
    capabilities = payload.get("capabilities", old["capabilities"] if old.get("kind") == kind else [CAPABILITIES[kind][0]])
    if not isinstance(capabilities, list) or len(capabilities) > len(CAPABILITIES[kind]) or any(cap not in CAPABILITIES[kind] for cap in capabilities) or CAPABILITIES[kind][0] not in capabilities:
        raise ProviderError(400, "模型能力须包含对应类型的基础能力。")
    if kind == "image" and any(cap in capabilities for cap in ("mask", "multiReference")) and "reference" not in capabilities:
        raise ProviderError(400, "选择蒙版或多参考能力前，请启用参考图能力。")
    sizes = payload.get("sizes", old.get("sizes", []))
    if not isinstance(sizes, list) or len(sizes) > 80 or any(not _dimensions(size) or not 64 <= min(_dimensions(size)) <= max(_dimensions(size)) <= 4096 for size in sizes):
        raise ProviderError(400, "兼容尺寸格式应为 1024x1024，宽高各为 64–4096 像素，最多填写 80 项。")
    sizes = list(dict.fromkeys("x".join(map(str, _dimensions(size))) for size in sizes))
    maximum = payload.get("maxReferences", old.get("maxReferences", DEFAULT_INPUT_IMAGES))
    if type(maximum) is not int or not 1 <= maximum <= MAX_INPUT_IMAGES or "multiReference" in capabilities and maximum < 2:
        raise ProviderError(400, "参考图数量须在 1 至 16 张之间，多参考模型至少支持两张。")
    price = payload.get("price", old.get("price", 0))
    enabled = payload.get("enabled", old.get("enabled", False))
    if type(price) is not int or not 0 <= price <= MODEL_PRICE_MAX or type(enabled) is not bool:
        raise ProviderError(400, "请填写有效的积分价格和上架状态。")
    rates = payload.get("tokenRates", old.get("tokenRates")) if kind == "chat" else None
    if rates is not None and (not isinstance(rates, dict) or set(rates) != {"input", "output"} or
                              any(type(rate) is not int or not 0 <= rate <= MODEL_PRICE_MAX for rate in rates.values())):
        raise ProviderError(400, "请分别填写有效的输入和输出 Token 单价。")
    if kind == "chat" and enabled and rates is None:
        raise ProviderError(400, "请先设置输入和输出 Token 单价，再上架语言模型。")
    if kind == "chat":
        price = 0
    agent_mode = payload.get("agentMode", old.get("agentMode", "native")) if kind == "chat" else "native"
    if agent_mode not in ("native", "json"):
        raise ProviderError(400, "请选择有效的 Agent 调用方式。")
    same = row and (connection_id, model_id, kind) == (row["connection_id"], row["model_id"], row["kind"])
    window = payload.get('contextWindowTokens', row['context_window'] if same else None) if kind == 'chat' else None
    if window is not None and (type(window) is not int or not 16384 <= window <= 10_000_000):
        raise ProviderError(400, '上下文窗口须为 16384 至 10000000 的整数 Token 数；留空使用保守默认值。')
    tests = {cap: value for cap, value in old.get("tests", {}).items() if cap in capabilities} if same else {}
    if maximum > old.get("maxReferences", maximum):
        tests.pop("multiReference", None)
    if enabled and not connection["enabled"]:
        raise ProviderError(409, "请先启用模型所属的服务连接。")
    if db.execute("SELECT 1 FROM cpa_models WHERE connection_id=? AND model_id=? AND id<>?", (connection_id, model_id, identifier)).fetchone():
        raise ProviderError(409, "这条连接已添加同名模型 ID。")
    fields = (connection_id, model_id, name, kind, json.dumps(list(dict.fromkeys(capabilities))),
              json.dumps(sizes), maximum, price, enabled, json.dumps(tests, ensure_ascii=False), int(time.time()),
              rates["input"] if rates else None, rates["output"] if rates else None, agent_mode, window)
    if row:
        db.execute("""UPDATE cpa_models SET connection_id=?,model_id=?,name=?,kind=?,capabilities=?,sizes=?,max_references=?,
                      price=?,enabled=?,tests=?,updated=?,input_rate=?,output_rate=?,agent_mode=?,context_window=? WHERE id=?""", (*fields, identifier))
        if not enabled or old["kind"] != kind:
            db.execute("DELETE FROM cpa_defaults WHERE model_id=?", (identifier,))
    else:
        db.execute("""INSERT INTO cpa_models(connection_id,model_id,name,kind,capabilities,sizes,max_references,
                      price,enabled,tests,updated,input_rate,output_rate,agent_mode,context_window,id,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (*fields, identifier, int(time.time())))
    _audit(db, actor, "model.update" if row else "model.create", identifier, {"enabled": enabled, "agentMode": agent_mode})
    return {"model": _model_view(_lookup(db, "cpa_models", identifier, "模型"))}


def _png_sample(mask=False):
    def chunk(name, data):
        return struct.pack("!I", len(data)) + name + data + struct.pack("!I", zlib.crc32(name + data))
    width = height = 128
    if mask:
        rows = [b"\0" + bytes((255, 255, 255, 0 if 32 <= index <= 95 and 32 <= row <= 95 else 255)[color]
                                for index in range(width) for color in range(4)) for row in range(height)]
    else:
        rows = [b"\0" + bytes((102, 153, 204, 255)) * width] * height
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", width, height, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")
    return ("mask.png" if mask else "sample.png", "image/png", data)


def _probe(db, row, capability, actor):
    model = _model_view(row)
    if capability not in model["capabilities"]:
        raise ProviderError(400, "请先为模型添加这项能力。")
    connection = _lookup(db, "cpa_connections", row["connection_id"], "模型连接")
    if not connection["enabled"]:
        raise ProviderError(409, "请先启用模型连接。")
    config = _config(db, model)
    received = {}
    start = time.monotonic()
    try:
        if model["kind"] == "image":
            from io import BytesIO
            from PIL import Image, UnidentifiedImageError

            images = [_png_sample()] if capability in ("reference", "mask", "multiReference") else []
            if capability == "multiReference":
                images *= model["maxReferences"]
            mask = _png_sample(mask=True) if capability == "mask" else None
            prompt = "A small green circle centered on a plain light gray background. No text."
            previews = []
            preview_callback = (lambda image: previews.append(True)) if capability == "imageStream" else None
            format_options = {"format": "gif", "frames": 3, "frameDurationMs": 200} if capability == "gif" else {"format": "svg"} if capability == "svg" else None
            if capability == "gif":
                prompt = "A small green circle pulses in size on a pale gray background in a short seamless loop. No text."
            output, submitted = generate(config, prompt, "1024x1024", images, mask, receipt=received,
                                         on_preview=preview_callback, output=format_options)
            if capability == "imageStream" and not previews:
                raise ProviderError(422, "已交付成品，本次未收到中间预览。", request_id=received.get("requestId"))
            try:
                if capability == "svg":
                    width, height = svg_dimensions(output)
                    received["actualSize"] = f"{width}x{height}"
                else:
                    with Image.open(BytesIO(output)) as image:
                        received["actualSize"] = f"{image.width}x{image.height}"
                        image.verify()
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
                raise ProviderError(502, "模型返回的图片无法解码。", True, received.get("requestId")) from None
            received["submittedSize"] = submitted
        else:
            content = "请用一个中文词回复，表示你已收到。"
            if capability == "vision":
                data = base64.b64encode(_png_sample()[2]).decode("ascii")
                content = [{"type": "text", "text": "What is the background color? Answer with one English color word."},
                           {"type": "image_url", "image_url": {"url": "data:image/png;base64," + data}}]
            answer = chat(config, [{"role": "user", "content": content}], stream=capability == "stream", receipt=received)
            if capability == "stream":
                answer = "".join(answer)
            if capability == "vision" and not re.search(r"\bblue\b|蓝", answer, re.I):
                raise ProviderError(422, "模型已响应，但未通过样图颜色识别验证。", request_id=received.get("requestId"))
        result = {"ok": True, "message": "调用通过。"}
    except ProviderError as error:
        result = {"ok": False, "message": error.message, "uncertain": error.uncertain}
        if error.request_id:
            received["requestId"] = error.request_id
    result.update({key: value for key, value in received.items() if key != "resultUrl"})
    result["elapsedMs"] = round((time.monotonic() - start) * 1000)
    result["testedAt"] = int(time.time())
    result["capability"] = capability
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    current = _lookup(db, "cpa_models", model["id"], "模型")
    new_connection = _lookup(db, "cpa_connections", row["connection_id"], "模型连接")
    fingerprint = ("connection_id", "model_id", "kind", "capabilities", "sizes", "max_references")
    if new_connection["revision"] != connection["revision"] or any(current[field] != row[field] for field in fingerprint):
        raise ProviderError(409, "测试期间模型配置已变化，请按新配置重新测试。")
    tests = json.loads(current["tests"])
    # A transient failure is shown in the audit history and preserves earlier verification.
    if result["ok"] or not tests.get(capability, {}).get("ok"):
        tests[capability] = result
        db.execute("UPDATE cpa_models SET tests=? WHERE id=?", (json.dumps(tests, ensure_ascii=False), model["id"]))
    _audit(db, actor, "model.probe", model["id"], result)
    return {"model": _model_view(_lookup(db, "cpa_models", model["id"], "模型")), "result": result}


def _save_defaults(db, payload, actor):
    for kind in CAPABILITIES:
        if kind not in payload:
            continue
        identifier = payload[kind]
        if identifier is None or identifier == "":
            db.execute("DELETE FROM cpa_defaults WHERE kind=?", (kind,))
        else:
            if not isinstance(identifier, str):
                raise ProviderError(400, "默认模型设置无效。")
            resolve(db, kind, identifier)
            db.execute("INSERT INTO cpa_defaults VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET model_id=excluded.model_id", (kind, identifier))
    defaults = _defaults(db)
    _audit(db, actor, "defaults.update", "defaults", defaults)
    return {"defaults": defaults}


def _batch_models(db, payload, actor):
    kind = payload.get("kind")
    action = payload.get("action")
    if not isinstance(kind, str) or kind not in CAPABILITIES:
        raise ProviderError(400, "请选择图片模型或语言模型。")
    if action in ("publish", "unpublish"):
        ids = payload.get("ids")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(
            not isinstance(item, str) or not re.fullmatch(r"[a-f0-9]{32}", item) for item in ids
        ):
            raise ProviderError(400, "请选择 1 至 100 个模型。")
        rows = [_lookup(db, "cpa_models", item, "模型") for item in dict.fromkeys(ids)]
        if any(row["kind"] != kind for row in rows):
            raise ProviderError(400, "批量操作中的模型必须属于同一分类。")
        enabled = action == "publish"
        changed = [row for row in rows if bool(row["enabled"]) != enabled]
        for row in changed:
            try:
                _save_model(db, {"enabled": enabled}, actor, row)
            except ProviderError as error:
                raise ProviderError(error.status, f"{row['name']}：{error}") from error
        return {"updated": len(changed), "skipped": len(rows) - len(changed)}
    if action != "import":
        raise ProviderError(400, "无效的模型批量操作。")
    connection_id = payload.get("connectionId")
    entries = payload.get("entries")
    enabled = payload.get("enabled")
    if not isinstance(connection_id, str) or type(enabled) is not bool:
        raise ProviderError(400, "请选择服务连接和导入方式。")
    _lookup(db, "cpa_connections", connection_id, "模型连接")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 100 or any(
        not isinstance(item, dict) or not isinstance(item.get("modelId"), str)
        or not MODEL_ID.fullmatch(item["modelId"]) for item in entries
    ):
        raise ProviderError(400, "请选择 1 至 100 个有效的上游模型。")
    if kind == "image" and enabled and "price" not in payload:
        raise ProviderError(400, "请填写图片模型每张单价。")
    shared = {key: payload[key] for key in ("price", "tokenRates", "capabilities", "maxReferences", "agentMode") if key in payload}
    unique = {item["modelId"]: item for item in entries}
    existing = {row[0] for row in db.execute("SELECT model_id FROM cpa_models WHERE connection_id=?", (connection_id,))}
    imported = 0
    for model_id, item in unique.items():
        if model_id in existing:
            continue
        _save_model(db, {**shared, "kind": kind, "connectionId": connection_id, "enabled": enabled,
                         "contextWindowTokens": item.get('contextWindowTokens'),
                         "modelId": model_id, "name": item.get("name") or model_id}, actor)
        imported += 1
    return {"updated": imported, "skipped": len(unique) - imported}


def admin(db, method, path, payload, actor):
    """Handle a model-center API call after administrator authorization."""
    payload = payload if isinstance(payload, dict) else {}
    if path == "/api/admin/models/batch" and method == "POST":
        return _batch_models(db, payload, actor)
    match = re.fullmatch(r"/api/admin/(connections|models|defaults|model-audit)(?:/([a-f0-9]{32}|discover))?(?:/(discover|probe))?", path)
    if not match:
        raise ProviderError(404, "模型中心接口不存在。")
    collection, identifier, action = match.groups()
    if collection == "defaults" and not identifier:
        if method == "GET":
            return {"defaults": _defaults(db)}
        if method == "PUT":
            return _save_defaults(db, payload, actor)
    elif collection == "model-audit" and not identifier and method == "GET":
        rows = db.execute("SELECT * FROM cpa_audit ORDER BY id DESC LIMIT 150")
        return {"items": [{**dict(row), "detail": json.loads(row["detail"])} for row in rows]}
    elif collection == "connections":
        if identifier == "discover" and not action and method == "POST":
            return discover(payload.get("baseUrl"), payload.get("key"))
        if not identifier:
            if method == "GET":
                return {"connections": [_connection_view(row) for row in db.execute("SELECT * FROM cpa_connections ORDER BY created,id")]}
            if method == "POST":
                return _save_connection(db, payload, actor)
        else:
            row = _lookup(db, "cpa_connections", identifier, "连接")
            if action == "discover" and method == "POST":
                base_url = normalize_url(payload.get("baseUrl") or row["base_url"])
                key = payload.get("key")
                if not key and _parse_url(base_url)[3] != _parse_url(row["base_url"])[3]:
                    raise ProviderError(400, "变更服务主机时，请重新填写 API Key。")
                return discover(base_url, key or _connection_key(db, row))
            if not action:
                if method == "GET":
                    return {"connection": _connection_view(row)}
                if method == "PUT":
                    return _save_connection(db, payload, actor, row)
                if method == "DELETE":
                    if db.execute("SELECT 1 FROM cpa_models WHERE connection_id=?", (identifier,)).fetchone():
                        raise ProviderError(409, "此连接仍关联模型，请先移除关联模型或停用连接。")
                    db.execute("DELETE FROM cpa_connections WHERE id=?", (identifier,))
                    _audit(db, actor, "connection.delete", identifier)
                    return {"ok": True}
    elif collection == "models":
        if not identifier:
            if method == "GET":
                return {"models": [_model_view(row) for row in db.execute("SELECT * FROM cpa_models ORDER BY created,id")]}
            if method == "POST":
                return _save_model(db, payload, actor)
        else:
            row = _lookup(db, "cpa_models", identifier, "模型")
            if action == "probe" and method == "POST":
                return _probe(db, row, payload.get("capability"), actor)
            if not action:
                if method == "GET":
                    return {"model": _model_view(row)}
                if method == "PUT":
                    return _save_model(db, payload, actor, row)
                if method == "DELETE":
                    db.execute("DELETE FROM cpa_defaults WHERE model_id=?", (identifier,))
                    db.execute("DELETE FROM cpa_models WHERE id=?", (identifier,))
                    _audit(db, actor, "model.delete", identifier)
                    return {"ok": True}
    raise ProviderError(405, "模型中心不支持该操作。")
