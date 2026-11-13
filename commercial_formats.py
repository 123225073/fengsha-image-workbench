"""Compose GIF frames and trace SVG paths from a single generated raster."""

import importlib.util
import io
from math import gcd, log
from pathlib import Path
import re
import sys
from threading import Lock
import xml.etree.ElementTree as ET

from PIL import Image, ImageOps


GRID = {4: (2, 2), 6: (3, 2), 8: (4, 2), 9: (3, 3), 12: (4, 3), 16: (4, 4)}
GIF_MAX_EDGE = 768
GIF_MIN_FRAMES = 2
GIF_MAX_FRAMES = 16
GIF_MIN_FRAME_DURATION_MS = 20
GIF_MAX_FRAME_DURATION_MS = 2000
GIF_DURATION_STEP_MS = 10
RASTER_SIZES = ((1024, 1024), (1536, 1024), (1024, 1536))
_trace_lock = Lock()


def tracer_available():
    local = Path(__file__).resolve().parent / ".workspace-data" / "vendor"
    return (local / "vtracer").is_dir() or importlib.util.find_spec("vtracer") is not None


def _tracer():
    with _trace_lock:
        local = Path(__file__).resolve().parent / ".workspace-data" / "vendor"
        if (local / "vtracer").is_dir() and str(local) not in sys.path:
            sys.path.append(str(local))
        import vtracer
        return vtracer


def _raster_layout(size, frames=None):
    width, height = map(int, size.split("x"))
    grid = GRID[frames] if frames is not None else (1, 1)
    # Match the shape of each cell to the final frame using the existing upstream raster sizes.
    columns, rows, raster_width, raster_height = min(
        ((columns, rows, w, h) for columns, rows in (grid, grid[::-1]) for w, h in RASTER_SIZES),
        key=lambda option: abs(log(width * option[0] * option[3] / (height * option[1] * option[2]))),
    )
    return columns, rows, f"{raster_width}x{raster_height}"


def _motion_brief(prompt, output):
    frames = output["frames"]
    interval = output["frameDurationMs"]
    start = max(1, round(frames * .2))
    recovery = max(start + 2, round(frames * .75) + 1)
    ending = "按描述停在本段的结束姿势" if output.get("sequence") else "回到起始姿势，使末帧自然接回首帧"
    head_motion = ""
    if re.search(r"摇头|左右转头|头部.{0,10}左右|头部.{0,12}向左.{0,24}向右|\bshak(?:e|es|ing)\b.{0,18}\bhead\b", prompt, re.I):
        head_motion = ("左右摇头围绕颈部小幅水平转动，经过中间姿势，不能左右平移头部。"
                       "未指定幅度时，以正面为中心左右各转约 8–12°，眼、鼻、嘴、耳朵与头部一起自然转动。")
        if frames >= 8 and not output.get("sequence"):
            head_motion += (f"未指定转头轨迹时，第 1 帧正面，第 {round(frames / 4)} 帧偏左，"
                            f"第 {round(frames / 2)} 帧回中，第 {round(frames * .75)} 帧偏右，最后回到正面。")
    return (f"播放时共 {frames} 帧，每帧 {interval} 毫秒，总长 {frames * interval / 1000:g} 秒。"
            f"未指定节奏时，第 1–{start} 帧交代起势，第 {start + 1}–{recovery - 1} 帧逐步完成主动作，"
            f"第 {recovery}–{frames} 帧{ending}。如果用户给出的帧数与实际设置不同，按动作阶段等比换算。"
            "相邻帧保留中间姿势并平滑变速，固定主体的尺寸和支点。不同肢体不要相互穿插或突然变形。"
            "多项动作按主次错开，次要动作幅度更小。说话仅用细微口型表现，画面文字只在明确要求时出现。"
            + head_motion)


def raster_request(prompt, size, output):
    if output["method"] == "trace":
        _, _, raster_size = _raster_layout(size)
        return (prompt + "\n画面用于矢量描摹：主体居中，使用清晰可分离的封闭轮廓，少量纯色色块，边缘硬朗，"
                "背景统一，避免纹理、照片效果、模糊、复杂渐变和细碎阴影。不加用户未要求的文字。", raster_size)
    columns, rows, raster_size = _raster_layout(size, output["frames"])
    width, height = map(int, size.split("x"))
    divisor = gcd(width, height)
    ratio = "21:9" if (width // divisor, height // divisor) == (7, 3) else f"{width // divisor}:{height // divisor}"
    return (f"绘制严格的 {columns} 列 × {rows} 行等大分镜，从左到右、从上到下依次播放。"
            "分镜铺满整张图，各格没有边框、编号、格间距或跨格内容。"
            f"最终每帧为 {width}×{height} 像素（{ratio}）。每格按照最终宽高比安排主体与留白，"
            "把同一场景背景铺到格子边缘，不要把参考图原画幅嵌在中央或加黑边。"
            "参考图用于保持主体外观与风格，构图服从目标画幅。保持镜头、主体比例、背景和光线连贯，"
            "并给主体的动作范围留足空间。\n"
            f"{_motion_brief(prompt, output)}\n动作与画面要求：{prompt}", raster_size)


def _fit_gif_frame(cell, width, height):
    # Scale the original cell uniformly, then extend the edges into the extra canvas.
    scale = min(width / cell.width, height / cell.height)
    cell = cell.resize((max(1, round(cell.width * scale)), max(1, round(cell.height * scale))),
                       Image.Resampling.LANCZOS)
    picture = Image.new("RGB", cell.size, "#f1f2ef")
    picture.paste(cell, (0, 0), cell)
    left, top = (width - cell.width) // 2, (height - cell.height) // 2
    right, bottom = width - left - cell.width, height - top - cell.height
    frame = Image.new("RGB", (width, height))
    frame.paste(picture, (left, top))
    if left:
        frame.paste(picture.crop((0, 0, 1, cell.height)).resize((left, cell.height)), (0, top))
    if right:
        frame.paste(picture.crop((cell.width - 1, 0, cell.width, cell.height)).resize((right, cell.height)),
                    (left + cell.width, top))
    if top:
        frame.paste(picture.crop((0, 0, cell.width, 1)).resize((cell.width, top)), (left, 0))
    if bottom:
        frame.paste(picture.crop((0, cell.height - 1, cell.width, cell.height)).resize((cell.width, bottom)),
                    (left, top + cell.height))
    return frame


def finish_raster(data, size, output, *, metadata=None):
    with Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "WEBP"]) as raster:
        if raster.width * raster.height > 16_777_216:
            raise ValueError("Source image too large for conversion")
        image = ImageOps.exif_transpose(raster).convert("RGBA")
    width, height = map(int, size.split("x"))
    if output["method"] == "trace":
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        if image.getbbox() is None or all(low == high for low, high in image.getextrema()):
            raise ValueError("Vector source has no visible detail")
        # Reduce antialiasing and compression color noise before tracing flat artwork.
        flat = image.convert("RGB").quantize(colors=12).convert("RGBA")
        flat.putalpha(image.getchannel("A").point(lambda alpha: 255 if alpha >= 128 else 0))
        png = io.BytesIO()
        flat.save(png, "PNG")
        traced = _tracer().convert_raw_image_to_svg(
            png.getvalue(), img_format="png", colormode="color", mode="spline",
            hierarchical="stacked", color_precision=6, layer_difference=22, filter_speckle=12,
        )
        try:
            svg = ET.fromstring(traced)
        except ET.ParseError as error:
            raise ValueError("Invalid traced SVG") from error
        svg.set("width", str(width))
        svg.set("height", str(height))
        svg.set("viewBox", svg.get("viewBox", f"0 0 {image.width} {image.height}"))
        return ET.tostring(svg, encoding="utf-8", xml_declaration=True)
    columns, rows, _ = _raster_layout(size, output["frames"])
    if min(image.width // columns, image.height // rows) < 64:
        raise ValueError("Storyboard cells too small")
    frames = []
    for index in range(output["frames"]):
        x, y = index % columns, index // columns
        crop = image.crop((round(x * image.width / columns), round(y * image.height / rows),
                           round((x + 1) * image.width / columns), round((y + 1) * image.height / rows)))
        frames.append(_fit_gif_frame(crop, width, height))
    result = io.BytesIO()
    frames[0].save(result, "GIF", save_all=True, append_images=frames[1:], duration=output["frameDurationMs"], loop=0,
                   disposal=2)
    animated = result.getvalue()
    with Image.open(io.BytesIO(animated), formats=["GIF"]) as gif:
        if gif.n_frames < 2:
            raise ValueError("Storyboard is static")
    if metadata is not None:
        metadata["storyboardSize"] = f"{image.width}x{image.height}"
    return animated
