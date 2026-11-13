"""Local and DashScope super-resolution for the image job queue."""

import base64
import io
import json
import math
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

import commercial_provider as provider


BASE_URL = "https://dashscope.aliyuncs.com"
MODEL = "wanx2.1-imageedit"
LOCAL_MODEL = "realesrgan-x4plus"
LIGHT_LOCAL_MODEL = "realesrgan-x4plus-anime"
LOW_MEMORY_MODEL = "realesr-animevideov3"
METHODS = {"local": ("本地 Real-ESRGAN", LOCAL_MODEL), "aliyun": ("阿里云万相超分", MODEL)}
KEY_URL = "https://bailian.console.aliyun.com/model/settings/api-key"
ENGINE_URL = "https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0"
ENGINE_DIR = Path(__file__).resolve().parent / ".workspace-data" / "vendor" / "realesrgan"
LOCAL_GPU = threading.Lock()
MAX_PIXELS = 40_000_000
MAX_CLOUD_BYTES = 10_000_000


def setup(db):
    db.execute("""CREATE TABLE IF NOT EXISTS upscale_credentials (
        owner INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, secret BLOB NOT NULL
    )""")


def engine_path():
    name = "realesrgan-ncnn-vulkan.exe" if os.name == "nt" else "realesrgan-ncnn-vulkan"
    location = Path(os.environ.get("FENGSHA_UPSCALE_ENGINE_DIR", str(ENGINE_DIR))).resolve()
    engine = location / name
    if engine.is_file() and model_available(engine, LOCAL_MODEL):
        return engine
    return None


def model_available(engine, filename):
    return all((engine.parent / "models" / (filename + ext)).is_file() for ext in (".param", ".bin"))


def credential(db, owner):
    return db.execute("SELECT secret FROM upscale_credentials WHERE owner=?", (owner,)).fetchone()


def settings(db, owner):
    return {"configured": credential(db, owner) is not None, "localReady": engine_path() is not None,
            "keyUrl": KEY_URL, "engineUrl": ENGINE_URL, "model": MODEL}


def save_settings(db, owner, body):
    if not isinstance(body, dict):
        raise provider.ProviderError(400, "超分设置格式无效。")
    if body == {"clear": True}:
        db.execute("DELETE FROM upscale_credentials WHERE owner=?", (owner,))
    elif set(body) == {"key"}:
        key = provider._api_key(body["key"])
        secret = provider._cipher(db).encrypt(key.encode("utf-8"))
        db.execute("""INSERT INTO upscale_credentials(owner,secret) VALUES(?,?)
            ON CONFLICT(owner) DO UPDATE SET secret=excluded.secret""", (owner, secret))
    else:
        raise provider.ProviderError(400, "超分设置格式无效。")
    return settings(db, owner)


def ready(db, owner, method):
    if method == "local" and engine_path() is None:
        raise provider.ProviderError(503, "本机缺少 Real-ESRGAN。请在超分设置中查看安装方法。")
    if method == "aliyun" and credential(db, owner) is None:
        raise provider.ProviderError(409, "请在超分设置中保存阿里云百炼北京地域的 API Key。")


def source_image(data, max_pixels=MAX_PIXELS):
    try:
        with Image.open(io.BytesIO(data), formats=("PNG", "JPEG", "WEBP", "GIF")) as opened:
            if getattr(opened, "is_animated", False):
                raise provider.ProviderError(400, "超分支持静态图片，请选择一张 PNG、JPEG 或 WebP。")
            if opened.width * opened.height > max_pixels:
                raise provider.ProviderError(400, "图片超过可处理的像素上限。")
            return ImageOps.exif_transpose(opened)
    except (OSError, ValueError, Image.DecompressionBombError):
        raise provider.ProviderError(422, "无法读取原图，请重新上传。") from None


def dimensions(source, target, method):
    if target == "4k":
        scale = 4096 / max(source)
        if scale <= 1:
            raise provider.ProviderError(400, "原图长边已达到 4096 像素，请选择倍率放大。")
        if scale > 4:
            raise provider.ProviderError(400, "原图长边小于 1024 像素，请选择 4 倍放大。")
    else:
        scale = int(target)
    result = tuple(round(edge * scale) for edge in source)
    if max(result) > 8192 or result[0] * result[1] > MAX_PIXELS:
        raise provider.ProviderError(400, "目标尺寸超过 8192 像素长边或 4000 万像素，请降低倍率。")
    if method == "aliyun" and not all(512 <= edge <= 4096 for edge in source):
        raise provider.ProviderError(400, "万相要求原图宽高均为 512–4096 像素，可尝试本地超分。")
    if method == "local" and source[0] * source[1] * 16 > 64_000_000:
        raise provider.ProviderError(400, "原图过大，当前本地模型无法处理，请缩小原图后再试。")
    return result


def local_image(source, target):
    engine = engine_path()
    if engine is None:
        raise provider.ProviderError(503, "本机缺少 Real-ESRGAN。")
    with LOCAL_GPU, tempfile.TemporaryDirectory(prefix="fengsha-upscale-") as folder:
        input_path, output_path = Path(folder) / "input.png", Path(folder) / "output.png"
        pixels = source.convert("RGBA" if "A" in source.getbands() or "transparency" in source.info else "RGB")
        pixels.save(input_path)
        native_scale = max(2, math.ceil(max(target) / max(pixels.size)))
        attempts = [(LOCAL_MODEL, 4)]
        if model_available(engine, f"{LOW_MEMORY_MODEL}-x{native_scale}"):
            attempts.append((LOW_MEMORY_MODEL, native_scale))
        if model_available(engine, LIGHT_LOCAL_MODEL):
            attempts.append((LIGHT_LOCAL_MODEL, 4))
        try:
            for model, scale in attempts:
                output_path.unlink(missing_ok=True)
                result = run_local_engine(engine, input_path, output_path, model, scale)
                memory_error = result.returncode and any(message in result.stderr for message in (
                    b"vkAllocateMemory failed", b"VK_ERROR_OUT_OF_DEVICE_MEMORY", b"VK_ERROR_OUT_OF_HOST_MEMORY",
                ))
                if not memory_error:
                    break
            else:
                raise provider.ProviderError(503, "Vulkan 无法分配足够显存，本地超分未交付成品。")
        except subprocess.TimeoutExpired:
            raise provider.ProviderError(504, "本地超分运行超时，请尝试较小的原图。") from None
        except OSError:
            raise provider.ProviderError(503, "无法启动本地超分引擎，请检查安装。") from None
        try:
            if result.returncode:
                raise ValueError
            with Image.open(output_path, formats=("PNG",)) as output:
                if output.size != (source.width * scale, source.height * scale):
                    raise ValueError
                if not output.convert("RGB").getbbox() and pixels.convert("RGB").getbbox():
                    raise ValueError
                return png(output if output.size == target else output.resize(target, Image.Resampling.LANCZOS)), model
        except (UnidentifiedImageError, OSError, ValueError):
            raise provider.ProviderError(502, "本地引擎未输出有效图片。") from None


def run_local_engine(engine, input_path, output_path, model, scale):
    return subprocess.run(
        [str(engine), "-i", str(input_path), "-o", str(output_path), "-m", "models",
         "-n", model, "-s", str(scale), "-t", "64", "-j", "1:1:1"],
        cwd=engine.parent, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=240,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
    )


def png(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def aliyun_request(key, path, payload=None, task_id=None):
    raw = json.dumps(payload).encode("utf-8") if payload is not None else None
    with provider._response(BASE_URL + path, key=key, data=raw, timeout=25,
                            content_type="application/json" if raw is not None else None,
                            extra_headers={"X-DashScope-Async": "enable"} if raw is not None else None) as response:
        if not 200 <= response.status < 300:
            if response.status in (401, 403):
                raise provider.ProviderError(response.status, "百炼拒绝请求，请核对北京地域 API Key 和模型权限。")
            if response.status == 429:
                raise provider.ProviderError(429, "百炼请求频率达到限制，请稍后再试。")
            if response.status >= 500:
                raise provider.ProviderError(502, "百炼服务暂时异常。", uncertain=True, request_id=task_id)
            raise provider.ProviderError(422, f"百炼拒绝了请求（HTTP {response.status}）。")
        try:
            result = json.loads(provider._read(response, 1024 * 1024, raw is not None))
            if not isinstance(result, dict):
                raise ValueError
        except (UnicodeError, ValueError):
            raise provider.ProviderError(502, "百炼返回了无法识别的结果。", uncertain=True, request_id=task_id) from None
        return result


def submit_aliyun(key, source, target):
    encoded = png(source.convert("RGBA" if "A" in source.getbands() or "transparency" in source.info else "RGB"))
    if len(encoded) > MAX_CLOUD_BYTES:
        raise provider.ProviderError(400, "发送给百炼的图片超过 10 MB，请使用较小的原图。")
    factor = next(value for value in (2, 3, 4) if max(target) <= max(source.size) * value)
    result = aliyun_request(key, "/api/v1/services/aigc/image2image/image-synthesis", {
        "model": MODEL,
        "input": {"function": "super_resolution", "prompt": "图像超分。",
                  "base_image_url": "data:image/png;base64," + base64.b64encode(encoded).decode("ascii")},
        "parameters": {"upscale_factor": factor, "n": 1, "watermark": False},
    })
    if result.get("code"):
        raise provider.ProviderError(422, "百炼未接受超分任务，请检查 Key、额度和原图。")
    task = result.get("output")
    task_id = task.get("task_id") if isinstance(task, dict) else None
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", task_id):
        raise provider.ProviderError(502, "百炼未返回可查询的任务编号。", uncertain=True)
    return task_id


def wait_aliyun(key, task_id, target):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            task = aliyun_request(key, "/api/v1/tasks/" + task_id, task_id=task_id).get("output")
        except provider.ProviderError:
            raise provider.ProviderError(502, "暂时无法查询百炼任务，可在任务详情继续核对。",
                                         uncertain=True, request_id=task_id) from None
        status = task.get("task_status") if isinstance(task, dict) else None
        if status in ("PENDING", "RUNNING"):
            time.sleep(2)
            continue
        if status in ("FAILED", "CANCELED"):
            code = task.get("code")
            suffix = f"（{code}）" if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", code) else ""
            raise provider.ProviderError(422, f"百炼超分任务{('失败' if status == 'FAILED' else '已取消')}{suffix}。",
                                         request_id=task_id)
        if status == "SUCCEEDED":
            try:
                url = task["results"][0]["url"]
                data = provider.recover_image({"baseUrl": BASE_URL, "key": None}, url)
                result = source_image(data, max_pixels=80_000_000)
                width, height = target
                if result.width >= width and result.height >= height and abs(result.width * height - result.height * width) <= max(width, height, result.width, result.height):
                    result = result.resize(target, Image.Resampling.LANCZOS) if result.size != target else result
                return png(result)
            except (KeyError, IndexError, TypeError, OSError, provider.ProviderError):
                raise provider.ProviderError(502, "百炼已完成，暂时无法保存成品，可在任务详情继续核对。",
                                             uncertain=True, request_id=task_id) from None
        break
    raise provider.ProviderError(504, "百炼成品尚未取回，可在任务详情继续核对原任务。",
                                 uncertain=True, request_id=task_id)
