"""PPT catalog ingestion, assets and downstream template registration."""

from collections import Counter
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from commercial_ppt import PALETTES, _template
from commercial_ppt_catalog import (
    BUILTIN_KEYS, CATALOG_SCRIPT, CATEGORIES, EXTRA_STYLES, PAGE_TYPES, REFERENCE_ROOT, STYLE_REFERENCES,
    load_reference_catalog,
)
from commercial_projects import TEMPLATE_OPTIONS
from workspace_server import FRONTEND


class PptCatalogTests(TestCase):
    def test_completed_entries_are_shared_by_picker_routes_and_export(self):
        self.assertEqual(set(STYLE_REFERENCES), {*BUILTIN_KEYS, *(entry["key"] for entry in EXTRA_STYLES)})
        self.assertEqual(len({entry["name"] for entry in EXTRA_STYLES}), len(EXTRA_STYLES))
        script = CATALOG_SCRIPT.decode("utf-8")
        payload = script.removeprefix("globalThis.workspacePptReferenceCatalog = ").removesuffix(";\n")
        self.assertEqual(json.loads(payload), EXTRA_STYLES)
        for key, path in STYLE_REFERENCES.items():
            with self.subTest(key=key):
                self.assertEqual(FRONTEND[f"/frontend/ppt-style-references/{path.name}"], (path, "image/jpeg"))
                with Image.open(path) as image:
                    self.assertEqual(image.format, "JPEG")
                    self.assertGreaterEqual(image.width, 640)
                    self.assertGreaterEqual(image.height, 640)
        for entry in EXTRA_STYLES:
            with self.subTest(template=entry["name"]):
                colors = tuple(color[1:].upper() for color in entry["colors"])
                self.assertIn(entry["name"], TEMPLATE_OPTIONS["ppt"]["style"])
                self.assertEqual(PALETTES[entry["name"]], colors)
                self.assertEqual(_template({"name": entry["name"], "colors": ["000000"] * 3})[1], colors)

    def test_loader_skips_invalid_missing_and_duplicate_artwork(self):
        entry = {
            "key": "catalog-test", "name": "收藏·测试模板", "title": "首页", "category": "舞台演讲",
            "colors": ["#102323", "#FFF4DD", "#C77732"], "summary": "一个可读的页面",
            "type": "标题粗体", "pages": dict.fromkeys(PAGE_TYPES, "左文右图"), "keywords": ["测试"],
        }
        invalid = [
            dict(entry, key="../outside", name="外部"),
            dict(entry, key="missing", name="缺图"),
            dict(entry, key="broken", name="坏图"),
            dict(entry, key="bay", name="已有键"),
            dict(entry, key="conflicting-name", name="海湾·商务提案"),
            dict(entry, key="missing-pages", name="缺少页面", pages={}),
            dict(entry, key="duplicated-name"),
            dict(entry, name="重复键"),
        ]
        with TemporaryDirectory() as folder:
            directory = Path(folder)
            Image.new("RGB", (64, 64)).save(directory / "catalog-test.jpg")
            Image.new("RGB", (64, 64)).save(directory / "duplicated-name.jpg")
            (directory / "broken.jpg").write_bytes(b"not jpeg")
            (directory / "catalog-test.json").write_text(
                json.dumps([entry, *invalid], ensure_ascii=False), encoding="utf-8"
            )
            with self.assertLogs(level="WARNING"):
                catalog, assets = load_reference_catalog(directory)
            self.assertEqual(len(catalog), 1)
            self.assertEqual(catalog[0], {**entry, "inner": None})
            self.assertEqual(set(assets), {*BUILTIN_KEYS, "catalog-test"})


def verify_full_delivery():
    """Run manually once all reference boards have been reviewed and approved."""
    counts = Counter({category: 1 for category in CATEGORIES})
    counts["舞台演讲"] = 3
    counts.update(style["category"] for style in EXTRA_STYLES)
    for category in sorted(counts):
        print(f"{category}: {counts[category]}")
    if counts != {category: 10 for category in CATEGORIES}:
        raise SystemExit("Expected ten accepted reference boards per category")
    if {image.stem for image in REFERENCE_ROOT.glob("*.jpg")} != set(STYLE_REFERENCES):
        raise SystemExit("Found missing or unlisted JPEG references")
    for key, path in STYLE_REFERENCES.items():
        with Image.open(path) as image:
            image.load()
            if image.format != "JPEG" or min(image.size) < 640:
                raise SystemExit(f"Unsupported image dimensions or format: {key}")
    print("Verified 100 complete JPEG boards and 10 categories.")


if __name__ == "__main__" and "--verify-release" in sys.argv:
    verify_full_delivery()
