"""Local source extraction and PowerPoint export for the commercial workspace."""

import base64
import csv
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import warnings
from functools import lru_cache
from itertools import groupby
from io import BytesIO
from pathlib import Path
from statistics import median
from unicodedata import east_asian_width
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.table import Table
from openpyxl import load_workbook
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps, ImageStat
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt
from pypdf import PdfReader


class DocumentError(ValueError):
    """An invalid or unsupported source or export selection."""


MAX_SOURCE_BYTES = 12 * 1024 * 1024
MAX_PPT_ATTACHMENTS = 24
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".log", ".rst"}
ATTACHMENT_TYPES = {".pdf", ".docx", ".xlsx", ".pptx"} | TEXT_EXTENSIONS
MAX_SOURCE_CHARS = 24_000
MAX_SOURCE_PAGES = 60
MAX_OFFICE_EXPANDED = 128 * 1024 * 1024
MAX_IMAGE_PIXELS = 36_000_000
MAX_EXPORT_SLIDES = 60
MAX_TEXTBOXES = 30
SLIDE_WIDTH = Inches(13 + 1 / 3)
SLIDE_HEIGHT = Inches(7.5)
INVALID_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
HAN_SPACE = re.compile(r"(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])")
PPT_CJK_SPACE = re.compile(r"(?<=[\u3400-\u9fff，。？！；：、（）《》]) +(?=[\u3400-\u9fff，。？！；：、（）《》])")
FONT_NAME = "Microsoft YaHei"
EXTRACTION_LIMIT = "提取范围"


def _clean_text(value):
    return INVALID_XML.sub("", value).replace("\r\n", "\n").replace("\r", "\n")


def _check_office_archive(data):
    try:
        with ZipFile(BytesIO(data)) as archive:
            members = archive.infolist()
            if "[Content_Types].xml" not in archive.namelist():
                raise DocumentError("Office 文件缺少文档结构。")
            if len(members) > 6_000 or sum(item.file_size for item in members) > MAX_OFFICE_EXPANDED:
                raise DocumentError("Office 文件展开后过大，请拆分后上传。")
    except BadZipFile as error:
        raise DocumentError("Office 文件无法读取，请保存为新版格式后重试。") from error


def _pdf_sources(data):
    document = PdfReader(BytesIO(data))
    if document.is_encrypted:
        raise DocumentError("PDF 已加密，请先另存可读副本。")
    for index, page in enumerate(document.pages, 1):
        if index > MAX_SOURCE_PAGES:
            yield EXTRACTION_LIMIT, "已达到每份资料的页数上限。"
            break
        yield f"第 {index} 页", page.extract_text() or ""


def _docx_sources(data):
    document = Document(BytesIO(data))
    for index, block in enumerate(document.iter_inner_content(), 1):
        if isinstance(block, Table):
            rows = []
            for row_index, row in enumerate(block.rows):
                if row_index == 150:
                    rows.append("其余表格行已省略。")
                    break
                rows.append(" | ".join(cell.text.strip()[:500] for cell in row.cells[:40]))
            yield f"表格（正文块 {index}）", "\n".join(rows)
        else:
            yield f"正文块 {index}", block.text


def _xlsx_sources(data):
    workbook = load_workbook(BytesIO(data), read_only=True, data_only=True, keep_links=False)
    try:
        for index, sheet in enumerate(workbook.worksheets, 1):
            if index > 20:
                yield EXTRACTION_LIMIT, "其余工作表已省略。"
                break
            for row_index, row in enumerate(
                sheet.iter_rows(min_row=1, max_row=min(sheet.max_row or 150, 150),
                                min_col=1, max_col=min(sheet.max_column or 40, 40), values_only=True), 1
            ):
                cells = [str(cell).strip()[:500] if cell is not None else "" for cell in row]
                while cells and not cells[-1]:
                    cells.pop()
                if any(cells):
                    yield f"工作表 {sheet.title} · 第 {row_index} 行", " | ".join(cells)
            if (sheet.max_row or 0) > 150 or (sheet.max_column or 0) > 40:
                yield EXTRACTION_LIMIT, f"工作表 {sheet.title} 仅提取前 150 行与 40 列。"
    finally:
        workbook.close()


def _shape_text(shape):
    if shape.has_text_frame:
        yield shape.text
    if shape.has_table:
        for row in shape.table.rows:
            yield " | ".join(cell.text for cell in row.cells)
    for child in getattr(shape, "shapes", ()):
        yield from _shape_text(child)


def _pptx_sources(data):
    deck = Presentation(BytesIO(data))
    for index, slide in enumerate(deck.slides, 1):
        if index > MAX_SOURCE_PAGES:
            yield EXTRACTION_LIMIT, "已达到每份资料的页数上限。"
            break
        yield f"幻灯片 {index}", "\n".join(
            text for shape in slide.shapes for text in _shape_text(shape) if text.strip()
        )


def _text_sources(data):
    encodings = ("utf-16",) if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030")
    for encoding in encodings:
        try:
            value = data.decode(encoding)
            if "\x00" in value:
                raise DocumentError("资料包含二进制内容，请保存为普通文本。")
            yield "", value
            return
        except UnicodeDecodeError:
            continue
    raise DocumentError("文本编码无法识别，请另存为 UTF-8。")


def extract_document(name, data):
    """Return bounded plain text with file and source location labels."""
    if not isinstance(name, str) or not isinstance(data, bytes) or not 0 < len(data) <= MAX_SOURCE_BYTES:
        raise DocumentError("资料为空或超过单文件 12 MB 限制。")
    filename = name.replace("\\", "/").split("/")[-1]
    extension = Path(filename).suffix.lower()
    readers = {
        ".pdf": _pdf_sources, ".docx": _docx_sources, ".xlsx": _xlsx_sources, ".pptx": _pptx_sources,
        **dict.fromkeys(TEXT_EXTENSIONS, _text_sources),
    }
    if extension not in readers:
        raise DocumentError("请选择 PDF、DOCX、XLSX、PPTX 或常用文本资料。")
    if extension in {".docx", ".xlsx", ".pptx"}:
        _check_office_archive(data)
    heading = f"文件：{' '.join(_clean_text(filename).split())[:180]}"
    sections = [heading]
    remaining = MAX_SOURCE_CHARS - len(heading)
    had_text = False
    try:
        for label, text in readers[extension](data):
            text = _clean_text(text).strip()
            if not text:
                continue
            had_text = had_text or label != EXTRACTION_LIMIT
            section = f"【{_clean_text(label)}】\n{text}" if label else text
            if len(section) + 2 > remaining:
                truncated = "\n\n其余内容已省略。"
                available = remaining - len(truncated) - 2
                if available > 0:
                    sections.append(section[:available].rstrip())
                return ("\n\n".join(sections) + truncated)[:MAX_SOURCE_CHARS]
            sections.append(section)
            remaining -= len(section) + 2
    except DocumentError:
        raise
    except Exception as error:
        raise DocumentError("资料无法读取，请检查文件是否完整、可打开。") from error
    if not had_text:
        raise DocumentError("资料中未提取到文字。扫描件可作为参考图使用。")
    return "\n\n".join(sections)


def _open_image(data):
    if not isinstance(data, bytes) or not data:
        raise DocumentError("图片内容为空。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise DocumentError("图片像素过大，请缩小后重试。")
                image.load()
                orientation = image.getexif().get(274, 1)
                original_format = image.format if orientation == 1 and not getattr(image, "is_animated", False) else None
                return ImageOps.exif_transpose(image), original_format
    except DocumentError:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
        raise DocumentError("图片损坏或格式无法识别。") from error


def _region(value):
    if not isinstance(value, dict):
        raise DocumentError("请选择有效的文字区域。")
    coordinates = []
    for field in ("x", "y", "w", "h"):
        number = value.get(field)
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            raise DocumentError("文字区域坐标无效。")
        if not 0 <= number <= 1 or not math.isfinite(number):
            raise DocumentError("文字区域超出图片范围。")
        coordinates.append(float(number))
    x, y, width, height = coordinates
    if width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
        raise DocumentError("文字区域超出图片范围。")
    return x, y, min(width, 1 - x), min(height, 1 - y)


def _pixels(image, region):
    x, y, width, height = region
    if width * image.width < 2 or height * image.height < 2:
        raise DocumentError("文字区域太小，请扩大选区。")
    left, top = int(x * image.width), int(y * image.height)
    right = min(image.width, math.ceil((x + width) * image.width))
    bottom = min(image.height, math.ceil((y + height) * image.height))
    return left, top, right, bottom


def _png(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _background_patch(original, bounds):
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    sides = []
    if top > 0:
        sides.append(original.crop((left, top - 1, right, top)))
    if bottom < original.height:
        sides.append(original.crop((left, bottom, right, bottom + 1)))
    if left > 0:
        sides.append(original.crop((left - 1, top, left, bottom)))
    if right < original.width:
        sides.append(original.crop((right, top, right + 1, bottom)))
    if not sides:
        raise DocumentError("请保留文字周围的背景，避免选中整张图片。")
    patch = sides[0].resize((width, height), Image.Resampling.BILINEAR)
    for index, side in enumerate(sides[1:], 2):
        patch = Image.blend(patch, side.resize((width, height), Image.Resampling.BILINEAR), 1 / index)
    return patch


def _prepare_slide(data, textboxes):
    image, original_format = _open_image(data)
    if not textboxes and original_format in {"PNG", "JPEG"}:
        return data, image.size, []
    if not textboxes:
        return _png(image.convert("RGBA")), image.size, []
    if len(textboxes) > MAX_TEXTBOXES:
        raise DocumentError(f"单页最多可保存 {MAX_TEXTBOXES} 个文字选区。")
    source = image.convert("RGBA")
    output = source.copy()
    selected = []
    for item in textboxes:
        normalized = _region(item)
        text = item.get("text")
        if not isinstance(text, str) or not 0 < len(text.strip()) <= 1_000:
            raise DocumentError("每个文字选区需提供 1 至 1000 个字符。")
        text = _clean_text(text).strip()
        if not text:
            raise DocumentError("文字选区的内容为空。")
        bounds = _pixels(source, normalized)
        if any(bounds[0] < prior[2] and bounds[2] > prior[0] and bounds[1] < prior[3] and bounds[3] > prior[1]
               for prior, *_ in selected):
            raise DocumentError("同一页的文字选区不能重叠。")
        patch = _background_patch(source, bounds)
        output.paste(patch, bounds)
        flattened = Image.new("RGBA", patch.size, "white")
        flattened.alpha_composite(patch)
        luminance = ImageStat.Stat(flattened.convert("L")).mean[0]
        color = RGBColor(22, 24, 28) if luminance >= 128 else RGBColor(255, 255, 255)
        selected.append((bounds, normalized, text, color))
    return _png(output), image.size, [(region, text, color) for _, region, text, color in selected]


def _fitted_dimensions(width, height):
    scale = min(SLIDE_WIDTH / width, SLIDE_HEIGHT / height)
    fitted_width, fitted_height = round(width * scale), round(height * scale)
    return (SLIDE_WIDTH - fitted_width) // 2, (SLIDE_HEIGHT - fitted_height) // 2, fitted_width, fitted_height


def _font_size(text, box_width, box_height, *, detected=False):
    # OCR boxes closely fit glyphs. Manually marked regions need room for wrapping.
    lines = text.splitlines()
    max_line = max(sum(1.05 if east_asian_width(char) in {"W", "F"} else .61 for char in line) for line in lines)
    width_points = box_width / 12700
    height_points = box_height / 12700
    height_limit = height_points * 1.05 if detected else height_points / (1.3 * len(lines))
    return max(1, min(72, width_points / max(max_line, 1), height_limit))


def _add_editable_text(slide, fitted, region, text, color, *, detected=False, bold=False):
    image_left, image_top, image_width, image_height = fitted
    x, y, width, height = region
    box_width, box_height = round(width * image_width), round(height * image_height)
    shape = slide.shapes.add_textbox(
        image_left + round(x * image_width), image_top + round(y * image_height), box_width, box_height
    )
    shape.name = "编辑文字 · " + " ".join(text.split())[:36]
    frame = shape.text_frame
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.word_wrap = not detected
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.text = text
    font_size = Pt(_font_size(text, box_width, box_height, detected=detected))
    for paragraph in frame.paragraphs:
        paragraph.space_before = paragraph.space_after = Pt(0)
        for run in paragraph.runs:
            run.font.name = FONT_NAME
            run.font.size = font_size
            run.font.color.rgb = color
            if bold:
                run.font.bold = True
            east_asian = OxmlElement("a:ea")
            east_asian.set("typeface", FONT_NAME)
            run._r.get_or_add_rPr().append(east_asian)


def _set_slide_background(slide, image, fitted):
    _, relationship = slide.part.get_or_add_image_part(BytesIO(image))
    background = slide._element.cSld.get_or_add_bg()
    properties = background.get_or_add_bgPr()
    fill = OxmlElement("a:blipFill")
    blip = OxmlElement("a:blip")
    blip.set(qn("r:embed"), relationship)
    fill.append(blip)
    stretch = OxmlElement("a:stretch")
    rect = OxmlElement("a:fillRect")
    x, y, width, height = fitted
    for name, offset, extent in (("l", x, SLIDE_WIDTH), ("t", y, SLIDE_HEIGHT),
                                  ("r", SLIDE_WIDTH - x - width, SLIDE_WIDTH),
                                  ("b", SLIDE_HEIGHT - y - height, SLIDE_HEIGHT)):
        if offset:
            rect.set(name, str(round(100000 * offset / extent)))
    stretch.append(rect)
    fill.append(stretch)
    properties.insert(0, fill)


def _word_height(word):
    return word[1][3] - word[1][1]


def _graphic_word(words, index):
    """Detect an isolated glyph whose size and spacing differ from its neighboring text."""
    text, (left, _, right, _) = words[index]
    height = _word_height(words[index])
    if len(text) > 2 or len(text) == 2 and text.isalnum():
        return False
    for neighbor in words[max(0, index - 1):index] + words[index + 1:index + 2]:
        gap = max(left, neighbor[1][0]) - min(right, neighbor[1][2])
        if (neighbor[0].isalnum() and gap < .23 * height
                and .85 <= _word_height(neighbor) / height <= 1.18):
            return False
    for direction, gap in (
        (-1, left - words[index - 1][1][2] if index else -1),
        (1, words[index + 1][1][0] - right if index + 1 < len(words) else -1),
    ):
        if gap < 3:
            continue
        near = words[index + direction]
        following = index + direction * 2
        if not 0 <= following < len(words):
            continue
        second = words[following]
        near_height = _word_height(near)
        typical = median((near_height, _word_height(second)))
        text_gap = max(near[1][0], second[1][0]) - min(near[1][2], second[1][2])
        if (not near[0].isalnum() or not second[0].isalnum()
                or not .72 <= near_height / _word_height(second) <= 1.39
                or text_gap > typical * .72 or not .35 * typical <= gap <= 2.1 * typical):
            continue
        if text in {"|", "｜", "丨"} and right - left <= typical * .27:
            return True
        if index == 0 and direction == 1:
            if (text in {"O", "0", "○"} and right - left >= .85 * height
                    and "\u3400" <= near[0][0] <= "\u9fff"):
                return True
            if (text == "《" and height >= 1.08 * typical and right - left <= .4 * typical
                    and not any("》" in word[0] for word in words[1:])):
                return True
        if height >= 1.25 * typical and right - left >= typical * .72:
            return True
        if height <= .8 * typical and right - left >= height * .7:
            # A dot may be a bullet, but keep true list numbers and punctuation in the text.
            if text in {"0", "O", "o", "的", "。", "○", "•", "·"}:
                return True
    return False


def _ocr_word_runs(lines, ocr_size, image_size, *, source=None, needs_review=None):
    width, height = image_size
    scale_x, scale_y = width / ocr_size[0], height / ocr_size[1]
    for line in lines:
        words = []
        for item in line:
            text = _clean_text(item["text"]).strip()
            left = max(0, math.floor(item["x"] * scale_x))
            top = max(0, math.floor(item["y"] * scale_y))
            right = min(width, math.ceil((item["x"] + item["w"]) * scale_x))
            bottom = min(height, math.ceil((item["y"] + item["h"]) * scale_y))
            if text and right - left > 1 and bottom - top > 1:
                words.append((text, (left, top, right, bottom)))
        words.sort(key=lambda word: word[1][0])
        if source is not None:
            words = _merge_it_slash(source, words)
        run = []
        for index, word in enumerate(words):
            graphic = _graphic_word(words, index)
            if source is not None and not graphic:
                graphic = (index == 0 and _separate_graphic_prefix(source, words)) or _zero_like_icon(source, word)
            if source is not None and not graphic and word[0] == "仃":
                verified = _verify_it_glyph(source, word[1])
                if verified is None:
                    graphic = True
                    if needs_review is not None:
                        needs_review.append(True)
                else:
                    word = (verified, word[1])
            if graphic:
                if run:
                    yield False, run
                    run = []
                yield True, [word]
                continue
            if run:
                previous = run[-1][1]
                bounds = word[1]
                gap = bounds[0] - previous[2]
                word_height = max(bounds[3] - bounds[1], previous[3] - previous[1])
                if gap > word_height * .85:
                    yield False, run
                    run = []
            run.append(word)
        if run:
            yield False, run


def _overlaps(left, right):
    return left[0] < right[2] and left[2] > right[0] and left[1] < right[3] and left[3] > right[1]


def _color_distance(first, second):
    return sum((a - b) ** 2 for a, b in zip(first, second))


def _safe_replacement(source, bounds, *, allow_gradient=False):
    """Restore a flat or gently varying background using the four edges."""
    left, top, right, bottom = bounds
    if left < 1 or top < 1 or right >= source.width or bottom >= source.height:
        return None
    pixels = source.load()
    edges = [[pixels[x, y] for x in range(left, right)] for y in (top - 1, bottom)]
    edges += [[pixels[x, y] for y in range(top, bottom)] for x in (left - 1, right)]
    perimeter = [pixel for edge in edges for pixel in edge]
    if any(pixel[3] != 255 for pixel in perimeter):
        return None
    def summarize(samples):
        values = [sorted(channel) for channel in zip(*samples)]
        n = len(samples)
        color = tuple(channel[n // 2] for channel in values)
        spread = max(channel[int(.90 * (n - 1))] - channel[int(.10 * (n - 1))] for channel in values)
        return color, spread

    size = right - left, bottom - top
    color, spread = summarize(perimeter)
    if spread <= 22:
        return Image.new("RGBA", size, color)
    if not allow_gradient or spread > 50:
        return None
    edge_colors, edge_spreads = zip(*(summarize(edge) for edge in edges))
    if (sum(spread <= 36 for spread in edge_spreads) < 3
            or any(max(channel) - min(channel) > 36 for channel in zip(*edge_colors))):
        return None
    vertical = Image.linear_gradient("L")
    fills = [Image.new("RGBA", size, color) for color in edge_colors]
    top_bottom = Image.composite(fills[1], fills[0], vertical.resize(size))
    left_right = Image.composite(fills[3], fills[2], vertical.transpose(Image.Transpose.TRANSPOSE).resize(size))
    return Image.blend(top_bottom, left_right, .5)


def _foreground_color(source, patch):
    background = ImageStat.Stat(patch.convert("RGB")).mean
    palette = source.convert("RGB").quantize(colors=12)
    colors = palette.getpalette()
    _, index = max(palette.getcolors(), key=lambda entry: math.sqrt(entry[0]) *
                   _color_distance(colors[entry[1] * 3:entry[1] * 3 + 3], background))
    color = colors[index * 3:index * 3 + 3]
    if _color_distance(color, background) < 900:
        return (22, 24, 28) if sum(background) > 384 else (255, 255, 255)
    return tuple(color)


@lru_cache(maxsize=1)
def _weight_reference_fonts():
    directory = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    try:
        return tuple(ImageFont.truetype(str(directory / name), 64) for name in ("msyh.ttc", "msyhbd.ttc"))
    except OSError:
        return ()


def _glyph_ink(font, token):
    glyph = font.getmask(token)
    mask = Image.new("L", glyph.size)
    mask.putdata(glyph)
    bounds = mask.getbbox()
    return mask.crop(bounds) if bounds else None


def _estimated_weight(token, delta, contrast):
    fonts = _weight_reference_fonts()
    if not fonts or contrast < 50 or not re.fullmatch(r"[\u3400-\u9fff]|[A-Z]{2,5}", token):
        return None
    references = []
    for font in fonts:
        mask = _glyph_ink(font, token)
        if mask is None:
            return None
        mask = mask.resize(delta.size)
        references.append(sum(mask.histogram()[102:]) / (mask.width * mask.height))
    regular, bold = references
    if bold - regular < .07:
        return None
    density = sum(delta.histogram()[max(20, round(.4 * contrast)):]) / (delta.width * delta.height)
    return (density - regular) / (bold - regular)


def _word_ink(source, bounds):
    left, top, right, bottom = bounds
    patch = _safe_replacement(source, (left - 1, top - 1, right + 1, bottom + 1), allow_gradient=True)
    if patch is None:
        return None
    patch = patch.crop((1, 1, right - left + 1, bottom - top + 1)).convert("RGB")
    crop = source.crop(bounds).convert("RGB")
    color = _foreground_color(crop, patch)
    contrast = max(abs(a - b) for a, b in zip(color, patch.getpixel((0, 0))))
    if contrast < 50:
        return None
    red, green, blue = ImageChops.difference(crop, patch).split()
    threshold = max(25, math.ceil(.42 * contrast))
    return ImageChops.lighter(red, ImageChops.lighter(green, blue)).point(
        [0] * threshold + [255] * (256 - threshold)
    )


def _normalize_glyph(mask):
    bounds = mask.getbbox()
    if bounds:
        return mask.crop(bounds).resize((36, 36), Image.Resampling.BOX).point([0] * 128 + [255] * 128)
    return None


@lru_cache(maxsize=1)
def _it_glyph_templates():
    directory = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    chinese = []
    for filename in ("msyh.ttc", "msyhbd.ttc", "Deng.ttf", "Dengb.ttf", "simsun.ttc", "simhei.ttf"):
        try:
            chinese.append(ImageFont.truetype(str(directory / filename), 64))
        except OSError:
            continue
    latin = list(chinese)
    for filename in ("arial.ttf", "arialbd.ttf"):
        try:
            latin.append(ImageFont.truetype(str(directory / filename), 64))
        except OSError:
            continue
    templates = {}
    for token, fonts in (("IT", latin), ("仃", chinese)):
        templates[token] = []
        for font in fonts:
            for size in (24, 36, 64, 96):
                mask = _glyph_ink(font.font_variant(size=size), token)
                if mask is not None:
                    normalized = _normalize_glyph(mask.point([0] * 107 + [255] * 149))
                    if normalized is not None:
                        templates[token].append(normalized)
    return templates


def _verify_it_glyph(source, bounds):
    """Disambiguate the Chinese OCR lookalike using the actual letter shapes."""
    templates = _it_glyph_templates()
    ink = _word_ink(source, bounds)
    mask = _normalize_glyph(ink) if ink is not None else None
    if mask is None or not all(templates.get(token) for token in ("IT", "仃")):
        return None
    pixels = mask.histogram()[255]
    scores = {
        token: max(2 * ImageChops.darker(mask, ref).histogram()[255] / (pixels + ref.histogram()[255])
                   for ref in references)
        for token, references in templates.items()
    }
    if scores["IT"] >= .82 and scores["IT"] - scores["仃"] >= .16:
        return "IT"
    if scores["仃"] >= .80 and scores["仃"] - scores["IT"] >= .12:
        return "仃"
    return None


def _merge_it_slash(source, words):
    """Merge a tightly spaced I, T and slash before cleaning a table label."""
    result = []
    index = 0
    while index < len(words):
        group = words[index:index + 4]
        if (len(group) == 4 and group[0][0] in {"|", "I", "l"} and group[1][0] == "T"
                and group[2][0] == "/" and re.fullmatch(r"[\u3400-\u9fff]", group[3][0])):
            first, second, slash, _ = (word[1] for word in group)
            height = first[3] - first[1]
            if (abs(second[0] - first[2]) <= .18 * height and abs(second[1] - first[1]) <= .18 * height
                    and abs(slash[0] - second[2]) <= .18 * height):
                bounds = (first[0], min(first[1], second[1]), second[2], max(first[3], second[3]))
                if _verify_it_glyph(source, bounds) == "IT":
                    result.append(("IT/", (bounds[0], min(bounds[1], slash[1]), slash[2], max(bounds[3], slash[3]))))
                    index += 3
                    continue
        result.append(words[index])
        index += 1
    return result


def _zero_like_icon(source, word):
    token, bounds = word
    if not re.fullmatch(r"(?:0{2,5}|O{2,5})", token):
        return False
    ink = _word_ink(source, bounds)
    if ink is None:
        return False
    area = ink.width * ink.height
    if ink.histogram()[255] < .62 * area:
        return False
    # Real zeros have internal counters. The solid pictograms OCR sometimes
    # reads as zeros have no such background enclosed by foreground ink.
    padded = ImageOps.expand(ink, border=1)
    ImageDraw.floodfill(padded, (0, 0), 127)
    return padded.histogram()[0] < .015 * area


def _separate_graphic_prefix(source, words):
    """Keep isolated, differently colored markers outside neighboring text."""
    if len(words) < 3 or len(words[0][0]) != 1 or not all(
        re.fullmatch(r"[\u3400-\u9fff]", word[0]) for word in words[1:3]
    ):
        return False
    prefix, first, second = (word[1] for word in words[:3])
    heights = [_word_height(word) for word in words[1:5]]
    size = median(height for height in heights if height >= .65 * max(heights))
    gap = first[0] - prefix[2]
    if not .38 * size <= gap <= 1.7 * size or second[0] - first[2] > .32 * size:
        return False
    # A square bullet or an offset logo can look like a single Han character.
    prefix_height = prefix[3] - prefix[1]
    small_marker = prefix_height <= .82 * size and .75 <= (prefix[2] - prefix[0]) / prefix_height <= 1.25
    offset_marker = gap >= .5 * size and abs(prefix[1] + prefix[3] - first[1] - first[3]) >= .28 * size
    vertical_marker = prefix_height >= .8 * size and prefix[2] - prefix[0] <= .42 * size
    if vertical_marker:
        ink = _word_ink(source, prefix)
        vertical_marker = ink is not None and ink.histogram()[255] >= .74 * ink.width * ink.height
    if not (small_marker or offset_marker or vertical_marker):
        return False
    references = [word[1] for word in words[1:5] if _word_height(word) >= .65 * size
                  and re.fullmatch(r"[\u3400-\u9fff]", word[0])]
    if len(references) < 2:
        return False
    colors = []
    for bounds in (prefix, *references[:2]):
        l, t, r, b = bounds
        patch = _safe_replacement(source, (l - 1, t - 1, r + 1, b + 1), allow_gradient=True)
        if patch is None:
            return False
        colors.append(_foreground_color(source.crop(bounds), patch))
    return (_color_distance(colors[1], colors[2]) <= 38 ** 2
            and all(_color_distance(colors[0], color) >= 65 ** 2 for color in colors[1:]))


def _recover_short_labels(normalized, runs, directory):
    """Reread the space above short parenthetical captions in flowchart cards."""
    candidates = []
    existing = [bounds for _, words in runs for _, bounds in words]
    width, height = normalized.size
    for graphic, words in runs:
        text = "".join(value for value, _ in words)
        if graphic or not re.fullmatch(r"[（(][\u3400-\u9fff]{2,10}[）)]", text):
            continue
        left = words[0][1][0]
        top = min(bounds[1] for _, bounds in words)
        right = max(bounds[2] for _, bounds in words)
        bottom = max(bounds[3] for _, bounds in words)
        size = bottom - top
        x, y = max(0, left - size // 3), max(0, top - round(size * 1.8))
        r, b = min(width, right + size // 2), min(height, bottom + size // 3)
        if any(_overlaps((x, y, r, top), bounds) for bounds in existing):
            continue
        candidates.append((x, y, r, b, left, top, size))
    crops = []
    for index, (x, y, r, b, *_) in enumerate(candidates[:16]):
        crop = normalized.crop((x, y, r, b))
        for scale in (2, 3):
            path = Path(directory) / f"label-{index}-{scale}.png"
            crop.resize((crop.width * scale, crop.height * scale), Image.Resampling.LANCZOS).save(path)
            crops.append(path)
    if not crops:
        return []
    recovered = []
    results = _run_ocr_batch(crops)
    for index, (x, y, r, b, left, top, size) in enumerate(candidates[:16]):
        scans = results[index * 2:index * 2 + 2]
        matches = []
        for scale, lines in zip((2, 3), scans):
            found = []
            for _, words in _ocr_word_runs(lines, ((r - x) * scale, (b - y) * scale), (r - x, b - y)):
                if len(words) != 1:
                    continue
                token, (a, c, e, f) = words[0]
                box = (a + x, c + y, e + x, f + y)
                if (re.fullmatch(r"[A-Z][A-Z0-9]{1,4}", token) and abs(box[0] - left) <= .4 * size
                        and 0 <= top - box[3] <= .85 * size and .65 * size <= box[3] - box[1] <= 1.5 * size):
                    found.append((token, box))
            matches.append(found)
        if all(len(found) == 1 for found in matches) and matches[0][0][0] == matches[1][0][0]:
            token, box = matches[1][0]
            if _overlaps(box, matches[0][0][1]) and not any(_overlaps(box, other) for other in existing):
                existing.append(box)
                recovered.append((False, [(token, box)]))
    return recovered


def _rebuild_editable_slide(data, manual, *, needs_review=None):
    image, _ = _open_image(data)
    source = image.convert("RGBA")
    normalized = Image.new("RGB", source.size, "white")
    normalized.paste(source, mask=source.getchannel("A"))
    ocr_image = normalized.copy()
    ocr_image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    try:
        with tempfile.TemporaryDirectory(prefix="fengsha-ppt-ocr-") as directory:
            path = Path(directory) / "page.png"
            ocr_image.save(path)
            lines = _run_ocr(path, layout=True)
            runs = list(_ocr_word_runs(lines, ocr_image.size, source.size, source=source, needs_review=needs_review))
            try:
                runs.extend(_recover_short_labels(normalized, runs, directory))
            except (DocumentError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                # The first pass is still usable when a supplemental scan fails.
                pass
    except (DocumentError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        if not manual:
            if isinstance(error, DocumentError):
                raise
            raise DocumentError("本机文字识别暂不可用，请稍后重试。") from error
        # Manual selections are already user-confirmed and do not require OCR.
        # Keep unmarked text in the original image and report this page for review.
        runs = []
        if needs_review is not None:
            needs_review.append(True)

    output = source.copy()
    overlays, marked = [], []
    if manual:
        background, _, manual_overlays = _prepare_slide(data, manual)
        cleared, _ = _open_image(background)
        marked = [_pixels(source, region) for region, _, _ in manual_overlays]
        for (_, text, color), bounds in zip(manual_overlays, marked):
            left, top, right, bottom = bounds
            region = (left / source.width, top / source.height,
                      (right - left) / source.width, (bottom - top) / source.height)
            patch = _safe_replacement(source, bounds)
            output.paste(patch if patch is not None else cleared.crop(bounds), bounds)
            overlays.append((region, text, color, False, False))
    width, height = source.size
    graphic_bounds = [run[0][1] for graphic, run in runs if graphic]
    caption_bounds = [words[0][1] for graphic, words in runs if not graphic
                      and re.fullmatch(r"[（(][\u3400-\u9fff]{2,10}[）)]", "".join(token for token, _ in words))]
    for graphic, run in runs:
        if graphic:
            continue
        for is_manual, group in groupby(run, key=lambda word: any(_overlaps(word[1], box) for box in marked)):
            if is_manual:
                continue
            words = list(group)
            glyph_heights = [_word_height(word) for word in words if any(c.isalnum() for c in word[0])]
            # Small labels and standalone glyphs are the least reliable OCR output.
            # Preserve them in place, especially in flowcharts and legends.
            if (not glyph_heights or median(glyph_heights) < height * .018
                    or len(words) == 1 and len(words[0][0]) == 1):
                continue
            left = min(bounds[0] for _, bounds in words)
            top = min(bounds[1] for _, bounds in words)
            right = max(bounds[2] for _, bounds in words)
            bottom = max(bounds[3] for _, bounds in words)
            if (left, top, right, bottom) == (0, 0, width, height):
                continue
            x0, y0, x3, y3 = (max(0, left - 1), max(0, top - 1),
                               min(width, right + 1), min(height, bottom + 1))
            if any(_overlaps((x0, y0, x3, y3), box) for box in (*marked, *graphic_bounds)):
                continue
            region = (x0 / width, y0 / height, (x3 - x0) / width, (y3 - y0) / height)
            replacements, colors = [], []
            for token, bounds in words:
                x1, y1, x2, y2 = bounds
                erase = (max(0, x1 - 1), max(0, y1 - 1), min(width, x2 + 1), min(height, y2 + 1))
                patch = _safe_replacement(source, erase, allow_gradient=True)
                if patch is None:
                    if needs_review is not None:
                        needs_review.append(True)
                    break
                colors.append(_foreground_color(source.crop(bounds), patch))
                replacements.append((token, bounds, erase, patch))
            else:
                weights = []
                for (token, bounds, erase, patch), color in zip(replacements, colors):
                    # Keep pixels already matching the surrounding color. This
                    # avoids painting a block across each OCR bounding box.
                    delta = ImageChops.difference(source.crop(erase).convert("RGB"), patch.convert("RGB"))
                    red, green, blue = delta.split()
                    threshold = 6 if all(low == high for low, high in patch.getextrema()) else 18
                    difference = ImageChops.lighter(ImageChops.lighter(red, green), blue)
                    mask = difference.point(
                        [0] * threshold + [255] * (256 - threshold)
                    )
                    output.paste(patch, erase, mask)
                    if len(weights) < 5:
                        l, t, r, b = bounds
                        ink = difference.crop((l - erase[0], t - erase[1], r - erase[0], b - erase[1]))
                        contrast = max(abs(a - b) for a, b in zip(color, patch.getpixel((0, 0))))
                        weight = _estimated_weight(token, ink, contrast)
                        if weight is not None:
                            weights.append(weight)
                text = PPT_CJK_SPACE.sub("", " ".join(text for text, _ in words))
                color = tuple(round(median(channel)) for channel in zip(*colors))
                card_label = re.fullmatch(r"[A-Z][A-Z0-9]{1,4}", text) and any(
                    abs(l - left) <= .4 * (bottom - top) and 0 <= t - bottom <= .85 * (bottom - top)
                    for l, t, _, _ in caption_bounds
                )
                bold = bool(card_label or weights and median(weights) >= .55)
                overlays.append((region, text, RGBColor(*color), True, bold))
    return _png(output), source.size, overlays


def export_presentation(slides, *, auto=False, image_only_pages=None, review_pages=None):
    """Export original slides or reconstruct visible native text over a cleaned background."""
    if not isinstance(slides, list) or not 0 < len(slides) <= MAX_EXPORT_SLIDES:
        raise DocumentError(f"请选择 1 至 {MAX_EXPORT_SLIDES} 页导出。")
    deck = Presentation()
    deck.slide_width, deck.slide_height = SLIDE_WIDTH, SLIDE_HEIGHT
    missed, reconstructed = False, False
    for index, item in enumerate(slides, 1):
        if not isinstance(item, dict):
            raise DocumentError("幻灯片数据无效。")
        preserve_image = item.get("preserveImage") is True
        boxes = [] if preserve_image else item.get("textboxes", [])
        if not isinstance(boxes, list):
            raise DocumentError("文字选区格式无效。")
        try:
            if auto and not preserve_image:
                needs_review = []
                image, (width, height), overlays = _rebuild_editable_slide(item.get("image"), boxes, needs_review=needs_review)
                if needs_review and overlays and review_pages is not None:
                    review_pages.append(index)
                if not overlays:
                    missed = True
                    image, (width, height), _ = _prepare_slide(item.get("image"), [])
            else:
                image, (width, height), manual = _prepare_slide(item.get("image"), boxes)
                overlays = [(*box, False, False) for box in manual]
        except DocumentError as error:
            if auto:
                raise DocumentError(f"第 {index} 页转换失败。{error}") from error
            raise
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        fitted = _fitted_dimensions(width, height)
        if auto and overlays:
            reconstructed = True
            _set_slide_background(slide, image, fitted)
        else:
            picture = slide.shapes.add_picture(BytesIO(image), *fitted)
            picture.name = "页面底图" if overlays else "页面原图"
            title = item.get("title")
            if isinstance(title, str) and title.strip():
                picture._element.nvPicPr.cNvPr.set("descr", _clean_text(title)[:180])
            if auto and image_only_pages is not None:
                image_only_pages.append(index)
        for region, text, color, detected, bold in overlays:
            _add_editable_text(slide, fitted, region, text, color, detected=detected, bold=bold)
    if missed and not reconstructed:
        raise DocumentError("未找到可自动转换的文字。请先补充或校对文字，再导出可编辑版。")
    output = BytesIO()
    deck.save(output)
    return output.getvalue()


def preview_text_background(data, textboxes):
    """Return the exact replacement background used for editable export."""
    if not isinstance(textboxes, list) or not textboxes:
        raise DocumentError("请先添加文字选区。")
    image, _, _ = _prepare_slide(data, textboxes)
    return image


_WINDOWS_OCR_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') } |
    Select-Object -First 1
function Wait-WinRt($operation, [type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    return $task.GetAwaiter().GetResult()
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($env:FENGSHA_OCR_LAYOUT -eq '1') {
    $chinese = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
        Where-Object { $_.LanguageTag -like 'zh-Hans*' -or $_.LanguageTag -eq 'zh-CN' } |
        Select-Object -First 1
    if ($null -ne $chinese) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($chinese)
    }
}
if ($null -eq $engine) {
    $language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
    if ($null -eq $language) { exit 3 }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
}
foreach ($inputPath in (ConvertFrom-Json $env:FENGSHA_OCR_INPUT)) {
$file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inputPath)) ([Windows.Storage.StorageFile])
$stream = Wait-WinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
try {
    $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
        $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        if ($env:FENGSHA_OCR_LAYOUT -eq '1') {
            $lines = @(
                foreach ($line in $result.Lines) {
                    @{ words = @(
                        foreach ($word in $line.Words) {
                            $box = $word.BoundingRect
                            @{ text = $word.Text; x = $box.X; y = $box.Y; w = $box.Width; h = $box.Height }
                        }
                    ) }
                }
            )
            $content = ConvertTo-Json -InputObject $lines -Depth 5 -Compress
        } else {
            $content = ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
        }
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))
    } finally {
        $bitmap.Dispose()
    }
} finally {
    $stream.Dispose()
}
}
"""


@lru_cache(maxsize=1)
def _tesseract_languages(program):
    try:
        result = subprocess.run([program, "--list-langs"], capture_output=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError):
        return ""
    installed = result.stdout.decode("utf-8", "replace").splitlines()[1:]
    return "+".join(language for language in ("chi_sim", "eng") if language in installed)


def _tsv_lines(content):
    rows = csv.DictReader(content.splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE)
    lines = {}
    for row in rows:
        if row.get("level") != "5" or not row.get("text") or float(row["conf"]) < 25:
            continue
        key = tuple(row[field] for field in ("page_num", "block_num", "par_num", "line_num"))
        words = lines.setdefault(key, [])
        words.append(dict(text=row["text"], x=int(row["left"]), y=int(row["top"]),
                          w=int(row["width"]), h=int(row["height"])))
    return list(lines.values())


def _run_ocr_batch(paths, *, layout=True):
    tesseract = shutil.which("tesseract")
    if tesseract and (languages := _tesseract_languages(tesseract)):
        results = []
        for path in paths:
            command = [tesseract, str(path), "stdout", "-l", languages, "--psm"]
            result = subprocess.run(command + (["11", "tsv"] if layout else ["6"]),
                                    capture_output=True, check=True, timeout=20)
            content = result.stdout.decode("utf-8", "replace")
            results.append(_tsv_lines(content) if layout else content)
        return results
    if os.name == "nt" and (powershell := shutil.which("powershell.exe")):
        encoded = base64.b64encode(_WINDOWS_OCR_SCRIPT.encode("utf-16-le")).decode("ascii")
        result = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            env={**os.environ, "FENGSHA_OCR_INPUT": json.dumps([str(path) for path in paths]),
                 "FENGSHA_OCR_LAYOUT": "1" if layout else "0"},
            capture_output=True, check=True, timeout=20 + 2 * len(paths),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        encoded_lines = result.stdout.splitlines()
        if len(encoded_lines) != len(paths):
            raise ValueError("Incomplete OCR response")
        contents = [base64.b64decode(value, validate=True).decode("utf-8") for value in encoded_lines]
        return [[line["words"] for line in json.loads(content)] for content in contents] if layout else contents
    raise DocumentError("当前环境没有可用的文字识别引擎，可手动输入文字。")


def _run_ocr(path, *, layout=False):
    return _run_ocr_batch([path], layout=layout)[0]


def recognize_image_text(data, region=None):
    """Recognize a local image or selected region without transmitting the image."""
    image, _ = _open_image(data)
    if region is not None:
        image = image.crop(_pixels(image, _region(region)))
    image.thumbnail((2_400, 2_400), Image.Resampling.LANCZOS)
    image = image.convert("RGBA")
    flattened = Image.new("RGB", image.size, "white")
    flattened.paste(image, mask=image.getchannel("A"))
    grayscale = ImageOps.grayscale(flattened)
    if ImageStat.Stat(grayscale).median[0] < 128:
        grayscale = ImageOps.invert(grayscale)
    normalized = ImageOps.autocontrast(grayscale)
    try:
        with tempfile.TemporaryDirectory(prefix="fengsha-ocr-") as directory:
            path = Path(directory) / "selected.png"
            normalized.save(path)
            text = _run_ocr(path)
    except DocumentError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise DocumentError("本机文字识别暂不可用，可手动输入文字。") from error
    return HAN_SPACE.sub("", _clean_text(text)).strip()[:MAX_SOURCE_CHARS]
