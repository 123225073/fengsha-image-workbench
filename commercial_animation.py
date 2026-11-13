"""Join existing image assets into an animated GIF without a model call."""

import io
import re

from PIL import Image, ImageOps, ImageSequence

from commercial_workspace import CommercialError, owned_asset


MAX_CLIPS = 16
MAX_FRAMES = 96
MAX_DURATION_MS = 60_000
MAX_SOURCE_PIXELS = 192_000_000
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 12 * 1024 * 1024
MAX_EDGE = 768
CANVASES = {"1:1": (768, 768), "16:9": (768, 432), "9:16": (432, 768)}
IMAGE_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")
MATTE = "#151a18"


def fit_frame(frame, canvas_size):
    width, height = canvas_size
    scale = min(width / frame.width, height / frame.height)
    fitted = max(1, round(frame.width * scale)), max(1, round(frame.height * scale))
    pixels = frame.convert("RGBA").resize(fitted, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", canvas_size, MATTE)
    position = ((width - pixels.width) // 2, (height - pixels.height) // 2)
    canvas.paste(pixels, position, pixels)
    return canvas.quantize()


def compose(db, store, owner, payload, *, canvas_size=None, include_trash=False):
    clips = payload.get("clips")
    ratio = payload.get("ratio", "auto")
    loop = payload.get("loop", True)
    if not isinstance(clips, list) or not 2 <= len(clips) <= MAX_CLIPS:
        raise CommercialError(400, "请选择 2 到 16 张图片或动图。")
    if not isinstance(ratio, str) or (ratio != "auto" and ratio not in CANVASES) or type(loop) is not bool:
        raise CommercialError(400, "画面比例或循环设置无效。")

    sources = []
    for clip in clips:
        asset_id = clip.get("assetId") if isinstance(clip, dict) else None
        duration = clip.get("durationMs", 1000) if isinstance(clip, dict) else None
        if not isinstance(asset_id, str) or not re.fullmatch(r"[a-f0-9]{32}", asset_id):
            raise CommercialError(400, "素材编号无效，请重新添加该素材。")
        if type(duration) is not int or not 100 <= duration <= 10_000:
            raise CommercialError(400, "静态图片停留时间应在 0.1 到 10 秒之间。")
        asset = owned_asset(db, owner, asset_id, image_only=True, include_trash=include_trash)
        if asset["size"] > MAX_SOURCE_BYTES:
            raise CommercialError(413, "其中一张素材超过 32 MB，请换用较小的文件。")
        sources.append((asset_id, duration))

    frames, delays = [], []
    canvas_size = canvas_size or CANVASES.get(ratio)
    total_ms = 0
    source_pixels = 0
    for index, (asset_id, still_delay) in enumerate(sources, start=1):
        try:
            with Image.open(io.BytesIO(store.read(asset_id)), formats=IMAGE_FORMATS) as source:
                if source.width * source.height > 24_000_000:
                    raise CommercialError(413, f"第 {index} 项素材像素过高，请缩小后再添加。")
                animated = getattr(source, "is_animated", False)
                has_default_frame = source.format == "PNG" and source.info.get("default_image", False)
                if not animated:
                    source = ImageOps.exif_transpose(source)
                if canvas_size is None:
                    width, height = source.size
                    scale = min(1, MAX_EDGE / max(width, height))
                    canvas_size = max(1, round(width * scale)), max(1, round(height * scale))
                start = len(frames)
                for frame_index, frame in enumerate(ImageSequence.Iterator(source)):
                    if has_default_frame and frame_index == 0:
                        continue
                    source_pixels += frame.width * frame.height
                    if len(frames) >= MAX_FRAMES or source_pixels > MAX_SOURCE_PIXELS:
                        raise CommercialError(413, "这段动图帧数过多或素材太大，请减少素材或帧数。")
                    frame.load()
                    delay = frame.info.get("duration", 100) if animated else still_delay
                    delay = max(10, round(float(delay or 100) / 10) * 10)
                    total_ms += delay
                    if total_ms > MAX_DURATION_MS:
                        raise CommercialError(413, "动图最长 60 秒，请减少素材或缩短停留时间。")
                    frames.append(fit_frame(frame, canvas_size))
                    delays.append(delay)
                if len(frames) == start:
                    raise ValueError("no playable frames")
        except (OSError, ValueError, TypeError, OverflowError, Image.DecompressionBombError) as error:
            raise CommercialError(422, f"第 {index} 项素材无法读取，请换用 PNG、JPG、WebP 或 GIF。") from error

    output = io.BytesIO()
    animation_options = {"loop": 0} if loop else {}
    frames[0].save(output, "GIF", save_all=True, append_images=frames[1:], duration=delays,
                   disposal=1, optimize=False, **animation_options)
    if output.tell() > MAX_OUTPUT_BYTES:
        raise CommercialError(413, "导出的 GIF 超过 12 MB，请减少素材或使用帧数较少的动图。")
    return output.getvalue(), "image/gif"
