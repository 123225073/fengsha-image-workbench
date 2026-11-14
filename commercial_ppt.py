"""Deterministic, editable PowerPoint slides built from confirmed content.

This path never invokes a model or OCR. Long content is continued on another
slide instead of being truncated or shrunk below presentation reading size.
"""

from io import BytesIO
import math
import re
from unicodedata import east_asian_width

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_AUTO_SIZE
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

from commercial_documents import DocumentError, FONT_NAME, SLIDE_WIDTH, SLIDE_HEIGHT, _clean_text
from commercial_ppt_catalog import EXTRA_STYLES


PALETTES = {
    "基础·商务蓝": ("FFFFFF", "172B4D", "2255A4"),
    "基础·极简灰": ("FFFFFF", "202124", "58606B"),
    "基础·教育绿": ("F8FBF8", "183E32", "26775B"),
    "基础·暖白橙": ("FFFCF7", "49362D", "B35E22"),
    "海湾·商务提案": ("F3F7FA", "102B45", "136789"),
    "信号·技术分享": ("132337", "F0F6FE", "70D9C0"),
    "纸本·研究纪要": ("F7F2E8", "362820", "9A4938"),
    "向上·年度经营": ("142731", "F3F6EF", "C6E75A"),
    "赤焰·新品发布": ("231614", "FFF5ED", "F46443"),
    "浅岛·企业培训": ("F0F7F5", "173A37", "D38A24"),
    "远山·融资路演": ("24213E", "F8F6FF", "CBC7FF"),
    "山野·可持续行动": ("F7F3E5", "233D31", "A97537"),
    "莓红·品牌营销": ("FCEEEE", "431728", "C33465"),
    "霓光·未来科技": ("11102A", "F5F2FF", "64F5E9"),
    "电蓝·创意演讲": ("153AD3", "F8F7F1", "E9FC49"),
    "长夜·故事分享": ("1F171A", "F6EAD8", "EF8444"),
    **{style["name"]: tuple(color[1:].upper() for color in style["colors"]) for style in EXTRA_STYLES},
}
FAMILIES = {"海湾·商务提案": "bay", "信号·技术分享": "signal", "纸本·研究纪要": "paper"}
LAYOUTS = {"cover", "agenda", "section", "points", "comparison", "process", "closing"}
MAX_OUTPUT_SLIDES = 60


def _text(value, field, limit, *, required=False):
    if not isinstance(value, str) or len(value) > limit:
        raise DocumentError(f"{field}需为不超过 {limit} 字的文字。")
    result = _clean_text(value).strip()
    if required and not result:
        raise DocumentError(f"请填写{field}。")
    return result


def _template(value):
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise DocumentError("模板参数格式无效。")
    name = _text(value.get("name", "基础·商务蓝"), "模板名称", 80)
    colors = value.get("colors", PALETTES.get(name, PALETTES["基础·商务蓝"]))
    if not isinstance(colors, (list, tuple)) or len(colors) != 3 or any(
        not isinstance(color, str) or not re.fullmatch(r"#?[0-9a-fA-F]{6}", color) for color in colors
    ):
        raise DocumentError("模板需提供有效的背景、文字和强调色。")
    # The built-in catalog is authoritative even if an old tab cached its colors.
    colors = PALETTES.get(name, tuple(color.lstrip("#").upper() for color in colors))
    layout = value.get("layout", "points")
    if not isinstance(layout, str) or layout not in LAYOUTS:
        layout = "points"
    return name, colors, layout


def _wrap(text, width, font_size):
    """Explicit conservative wrapping; never drop characters or split code points."""
    capacity = width * 72 / font_size
    result = []
    for paragraph in text.split("\n"):
        line, used = "", 0.0
        for character in paragraph:
            weight = 1.07 if east_asian_width(character) in {"W", "F"} else .64
            if line and used + weight > capacity and (used > capacity or character not in "，。！？；：、）】》」』,.!?;:)]}"):
                result.append(line)
                line, used = "", 0.0
            line += character
            used += weight
        result.append(line)
    return result


def _color(value):
    return RGBColor.from_string(value)


def _tint(background, accent):
    return "".join(f"{round(int(background[i:i+2], 16) * .92 + int(accent[i:i+2], 16) * .08):02X}"
                   for i in (0, 2, 4))


def _box(slide, name, text, x, y, width, height, font_size, color, *, bold=False, paragraph_space=0):
    shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(width), Inches(height))
    shape.name = name
    frame = shape.text_frame
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.word_wrap = False  # Already wrapped to measured-safe lengths below.
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.text = text
    for paragraph in frame.paragraphs:
        paragraph.space_before = Pt(0)
        paragraph.space_after = Pt(paragraph_space)
        paragraph.line_spacing = Pt(font_size * 1.35)
        for run in paragraph.runs:
            run.font.name = FONT_NAME
            run.font.size = Pt(font_size)
            run.font.bold = bold
            run.font.color.rgb = _color(color)
            east_asian = OxmlElement("a:ea")
            east_asian.set("typeface", FONT_NAME)
            run._r.get_or_add_rPr().append(east_asian)
    return shape


def _rect(slide, name, x, y, width, height, color):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(width), Inches(height))
    shape.name = name
    shape.fill.solid()
    shape.fill.fore_color.rgb = _color(color)
    shape.line.fill.background()
    return shape


def _title_geometry(title, width=12.03):
    size = 28 if len(title) <= 70 else 22
    lines = _wrap(title, width, size)
    height = max(.58, len(lines) * size * 1.35 / 72 + .08)
    return "\n".join(lines), size, height, max(1.65, .55 + height + .25)


def _content_lines(detail, width, font_size):
    lines = []
    for paragraph in detail.split("\n"):
        wrapped = _wrap(paragraph, width, font_size)
        lines.extend((text, index == len(wrapped) - 1) for index, text in enumerate(wrapped))
    return lines


def _columns(lines, count, capacity):
    """Prefer natural paragraph boundaries when distributing content across panels."""
    remaining, result = lines[:], []
    for column in range(count):
        left = count - column
        target = min(capacity, math.ceil(len(remaining) / left))
        minimum = max(1, len(remaining) - capacity * (left - 1))
        breaks = [index + 1 for index, (_, end) in enumerate(remaining[:capacity])
                  if end and minimum <= index + 1]
        split = min(breaks, key=lambda index: abs(index - target)) if breaks and left > 1 else target
        result.append(remaining[:split])
        remaining = remaining[split:]
    return result


def _pages(title, detail, layout, family="", number=""):
    if layout in {"cover", "section", "closing"}:
        width = {"bay": 8.7, "signal": 9.7, "paper": 10.8}.get(family, 11.73)
        headline = _wrap(title, width, 36)
        body = _wrap(detail, width, 22) if detail else []
        # Large typography stays large; dense covers become regular content pages.
        if len(headline) <= 2 and len(body) <= 5:
            return [{"layout": layout, "title": "\n".join(headline), "detail": body,
                     "titleSize": 36, "titleHeight": len(headline) * .675 + .1, "heroWidth": width}]
        layout = "points"
        if number:
            title = number + "  " + title
    frame_left = {"bay": 1.18, "signal": .82, "paper": 1.05}.get(family, .65)
    frame_width = 12.68 - frame_left
    title_text, title_size, title_height, body_y = _title_geometry(title, frame_width)
    columns = 2 if layout == "comparison" or (layout == "agenda" and family == "bay") else 3 if layout == "process" else 1
    panel_width = (frame_width - .32 * (columns - 1)) / columns
    body_width = panel_width - .5 if columns > 1 else frame_width - .53
    body_size = (20 if columns > 1 else 22) if len(detail) <= 500 else 18
    lines = _content_lines(detail, body_width, body_size) if detail else []
    # Worst case is one natural paragraph per visual line. Wrapping uses soft
    # breaks, so real paragraphs can have space without endangering pagination.
    line_cost = body_size * 1.35 + 12
    capacity = max(1, math.floor((6.75 - body_y - .46) * 72 / line_cost))
    count = max(1, math.ceil(len(lines) / (capacity * columns)))
    pages = []
    for part in range(count):
        page_title = title if part == 0 else title + f"（续 {part + 1}）"
        continued_title, size, height, actual_y = _title_geometry(page_title, frame_width)
        # Reserve using the longest continuation title, so no continuation can overflow.
        if actual_y > body_y:
            body_y = actual_y
            capacity = max(1, math.floor((6.75 - body_y - .46) * 72 / line_cost))
    page_capacity = capacity * columns
    for part, offset in enumerate(range(0, max(1, len(lines)), page_capacity)):
        page_title = title if part == 0 else title + f"（续 {part + 1}）"
        title_text, title_size, title_height, _ = _title_geometry(page_title, frame_width)
        chunk = lines[offset:offset + page_capacity]
        pages.append({"layout": layout, "title": title_text, "titleSize": title_size,
                      "titleHeight": title_height, "bodyY": body_y, "columns": columns,
                      "frameLeft": frame_left, "frameWidth": frame_width, "panelWidth": panel_width, "bodySize": body_size,
                      "detail": _columns(chunk, columns, capacity)})
    return pages


def export_native(slides, template=None, *, metadata=None):
    if not isinstance(slides, list) or not 1 <= len(slides) <= MAX_OUTPUT_SLIDES:
        raise DocumentError(f"请选择 1 至 {MAX_OUTPUT_SLIDES} 页已确认大纲。")
    name, (background, ink, accent), default_layout = _template(template)
    family = FAMILIES.get(name, "")
    all_pages = []
    for index, item in enumerate(slides):
        if not isinstance(item, dict):
            raise DocumentError(f"第 {index + 1} 页参数格式无效。")
        title = _text(item.get("title"), f"第 {index + 1} 页标题", 120, required=True)
        detail = _text(item.get("detail", ""), f"第 {index + 1} 页内容", 2000)
        layout = item.get("layout", "cover" if index == 0 else default_layout)
        if not isinstance(layout, str) or layout not in LAYOUTS:
            raise DocumentError(f"第 {index + 1} 页版式无效，请重新选择基础模板。")
        number = _text(item.get("number") or "", "章节序号", 2)
        if number and (layout != "section" or not re.fullmatch(r"[0-9]{2}", number)):
            raise DocumentError(f"第 {index + 1} 页章节序号无效。")
        pages = _pages(re.sub(r"\s+", " ", title), detail, layout, family, number)
        for page in pages:
            page["sourceTitle"], page["sourceDetail"] = title, detail
        if number and pages[0]["layout"] == "section":
            pages[0]["number"] = number
        all_pages.extend(pages)
        if len(all_pages) > MAX_OUTPUT_SLIDES:
            raise DocumentError(f"内容拆分后超过 {MAX_OUTPUT_SLIDES} 页，请减少文字或分批导出。")
    deck = Presentation()
    deck.slide_width, deck.slide_height = SLIDE_WIDTH, SLIDE_HEIGHT
    deck.core_properties.title = _text(slides[0]["title"], "演示文稿标题", 120)
    deck.core_properties.subject = "原生可编辑演示文稿"
    deck.core_properties.author = "风沙生图工作台"
    for index, page in enumerate(all_pages, 1):
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = _color(background)
        is_hero = page["layout"] in {"cover", "section", "closing"}
        if family == "bay":
            _rect(slide, "商务侧带", 10.55 if is_hero else 0, 0, 2.78 if is_hero else .76, 7.5, ink)
            if is_hero:
                _rect(slide, "商务色块", 9.85, 4.25, 3.48, 1.65, accent)
        elif family == "signal":
            _rect(slide, "技术顶栏", 0, 0, 13.33, .18, accent)
            if is_hero:
                for n in range(3):
                    _rect(slide, "技术阶梯", 10.3 + n * .54, 2.1 + n * 1.05, 2.1 - n * .54, .11, accent)
        elif family == "paper":
            _rect(slide, "纪要侧线", .66, .52, .019, 6.25, accent)
            _rect(slide, "纪要页脚线", 1.05, 6.85, 11.63, .019, accent)
        if is_hero:
            x, y = {"bay": (1.0, 2.05), "signal": (.82, 1.8), "paper": (1.2, 2.15)}.get(family, (.8, 2.0))
            width = page["heroWidth"]
            if page.get("number"):
                _box(slide, "章节序号", page["number"], x, .78, 2.15, 1.06, 52, accent, bold=True)
            else:
                _rect(slide, "封面强调线", x, y - .52, .68, .07, accent)
            _box(slide, "可编辑标题", page["title"], x, y, width, page["titleHeight"], 36, ink, bold=True)
            text_y = max(3.5, y + page["titleHeight"] + .18)
            _box(slide, "可编辑正文", "\n".join(page["detail"]), x, text_y, width, 2.2, 22, ink)
            if family != "paper":
                _rect(slide, "封面底线", x, 6.4, width, .025, accent)
        else:
            left, frame = page["frameLeft"], page["frameWidth"]
            _box(slide, "可编辑标题", page["title"], left, .55, frame, page["titleHeight"], page["titleSize"], ink, bold=True)
            y, columns, panel_width = page["bodyY"], page["columns"], page["panelWidth"]
            for column, lines in enumerate(page["detail"]):
                x = left + column * (panel_width + .32)
                if columns > 1:
                    _rect(slide, f"内容区域 {column + 1}", x, y, panel_width, 6.75 - y, _tint(background, accent))
                    _rect(slide, f"内容强调线 {column + 1}", x, y, panel_width, .055, accent)
                    x, width, text_y = x + .25, panel_width - .5, y + .23
                else:
                    _rect(slide, "正文强调线", left, y, .07, 6.75 - y, accent)
                    x, width, text_y = left + .25, frame - .53, y + .12
                text = "".join(line + ("\n" if end else "\v") for line, end in lines).rstrip("\n\v")
                _box(slide, f"可编辑正文 {column + 1}", text, x, text_y, width,
                     6.75 - text_y - .12, page["bodySize"], ink, paragraph_space=12)
        footer_color = background if family == "bay" and is_hero else ink
        _box(slide, "页码", f"{index} / {len(all_pages)}", 11.65, 7.05, 1.03, .25, 10, footer_color)
        # Also retain the unwrapped, exact confirmed content for later editing.
        slide.notes_slide.notes_text_frame.text = page["sourceTitle"] + "\n\n" + page["sourceDetail"]
    output = BytesIO()
    deck.save(output)
    if metadata is not None:
        metadata.update(mode="native", inputSlides=len(slides), slides=len(all_pages),
                        continuedSlides=len(all_pages) - len(slides))
    return output.getvalue()
