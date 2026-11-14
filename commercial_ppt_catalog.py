"""Installed PPT reference artwork and the metadata shared by its consumers."""

import json
import logging
from pathlib import Path
import re

from PIL import Image


REFERENCE_ROOT = Path(__file__).resolve().parent / "frontend" / "ppt-style-references"
BUILTIN_KEYS = ("bay", "signal", "paper", "orbit", "launch", "classroom",
                "pitch", "impact", "market", "prism", "pulse", "ember")
BUILTIN_NAMES = {"海湾·商务提案", "信号·技术分享", "纸本·研究纪要", "向上·年度经营",
                 "赤焰·新品发布", "浅岛·企业培训", "远山·融资路演", "山野·可持续行动",
                 "莓红·品牌营销", "霓光·未来科技", "电蓝·创意演讲", "长夜·故事分享"}
CATEGORIES = {"舞台演讲", "商业 PPT", "技术分享 PPT", "学术答辩 PPT", "经营复盘",
              "产品发布", "企业培训", "融资路演", "公益与可持续", "品牌营销"}
PAGE_TYPES = {"cover", "agenda", "section", "points", "comparison", "process", "closing"}


def _text(value, maximum):
    return isinstance(value, str) and 0 < len(value.strip()) <= maximum


def _colors(value):
    return isinstance(value, list) and len(value) == 3 and all(
        isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color)
        for color in value
    )


def _metadata(entry):
    if not isinstance(entry, dict):
        return None
    key, category = entry.get("key"), entry.get("category")
    if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", key):
        return None
    if not isinstance(category, str) or category not in CATEGORIES:
        return None
    fields = {"name": 55, "title": 80, "summary": 250, "type": 250}
    if not all(_text(entry.get(field), maximum) for field, maximum in fields.items()):
        return None
    colors, inner = entry.get("colors"), entry.get("inner")
    if not _colors(colors) or (inner is not None and not _colors(inner)):
        return None
    pages = entry.get("pages")
    if not isinstance(pages, dict) or not PAGE_TYPES.issubset(pages):
        return None
    if not all(_text(pages[page], 220) for page in PAGE_TYPES):
        return None
    keywords = entry.get("keywords", [])
    if not isinstance(keywords, list) or len(keywords) > 20 or not all(_text(word, 25) for word in keywords):
        return None
    return {
        "key": key,
        "category": category,
        **{field: entry[field].strip() for field in fields},
        "colors": colors,
        "inner": inner,
        "pages": {page: pages[page].strip() for page in sorted(PAGE_TYPES)},
        "keywords": [word.strip() for word in keywords],
    }


def load_reference_catalog(directory=REFERENCE_ROOT):
    """An unfinished or missing artwork never becomes a selectable reference."""
    entries = []
    assets = {key: directory / f"{key}.jpg" for key in BUILTIN_KEYS}
    names = set(BUILTIN_NAMES)
    for manifest in sorted(directory.glob("catalog-*.json")):
        try:
            candidates = json.loads(manifest.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, ValueError):
            logging.warning("Could not open PPT reference catalog %s", manifest.name)
            continue
        if not isinstance(candidates, list):
            logging.warning("PPT reference catalog %s must contain an array", manifest.name)
            continue
        for row_number, candidate in enumerate(candidates, 1):
            entry = _metadata(candidate)
            if not entry or entry["name"] in names or entry["key"] in assets:
                logging.warning("Invalid or duplicate PPT reference in %s, row %s", manifest.name, row_number)
                continue
            path = directory / f"{entry['key']}.jpg"
            if not path.is_file() or path.is_symlink():
                continue
            try:
                with Image.open(path) as image:
                    if image.format != "JPEG" or max(image.size) > 4096:
                        logging.warning("PPT reference %s is not a JPEG", path.name)
                        continue
                    image.verify()
            except (OSError, ValueError, Image.DecompressionBombError):
                logging.warning("PPT reference %s is unreadable", path.name)
                continue
            entries.append(entry)
            names.add(entry["name"])
            assets[entry["key"]] = path
    return entries, assets


EXTRA_STYLES, STYLE_REFERENCES = load_reference_catalog()
CATALOG_SCRIPT = ("globalThis.workspacePptReferenceCatalog = " +
                  json.dumps(EXTRA_STYLES, ensure_ascii=True, separators=(",", ":")) + ";\n").encode("utf-8")
