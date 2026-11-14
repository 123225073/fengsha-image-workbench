"""Delivery checks: editable objects, exact content, readable geometry and fallbacks."""

from io import BytesIO
import json
import math
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile

from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

import commercial_documents as documents
import commercial_ppt as native
import commercial_workspace as workspace


def picture():
    output = BytesIO()
    Image.new("RGB", (640, 360), "white").save(output, "PNG")
    return output.getvalue()


def body_text(deck):
    return "".join(shape.text for slide in deck.slides for shape in slide.shapes
                   if shape.name.startswith("可编辑正文")).replace("\v", "\n")


class NativePowerPointTests(unittest.TestCase):
    def test_every_basic_template_and_layout_reopens_with_native_shapes(self):
        pages = [{"title": "项目汇报", "detail": "目标已确认\n依据资料整理\n下一步行动", "layout": layout}
                 for layout in sorted(native.LAYOUTS)]
        for template in native.PALETTES:
            with self.subTest(template=template):
                stats = {}
                content = native.export_native(pages, {"name": template}, metadata=stats)
                with ZipFile(BytesIO(content)) as archive:
                    self.assertIsNone(archive.testzip())
                    self.assertFalse(any(path.startswith("ppt/media/") for path in archive.namelist()))
                deck = Presentation(BytesIO(content))
                self.assertEqual(len(deck.slides), len(pages))
                self.assertEqual(stats, {"mode": "native", "inputSlides": 6, "slides": 6, "continuedSlides": 0})
                for slide, source in zip(deck.slides, pages):
                    self.assertTrue(any(shape.name == "可编辑标题" and shape.has_text_frame for shape in slide.shapes))
                    self.assertFalse(any(shape.shape_type == MSO_SHAPE_TYPE.PICTURE for shape in slide.shapes))
                    self.assertIn(source["detail"], slide.notes_slide.notes_text_frame.text)
                    for shape in slide.shapes:
                        self.assertGreaterEqual(shape.left, 0)
                        self.assertGreaterEqual(shape.top, 0)
                        self.assertLessEqual(shape.left + shape.width, deck.slide_width)
                        self.assertLessEqual(shape.top + shape.height, deck.slide_height)
                        if shape.has_text_frame and shape.name.startswith("可编辑"):
                            self.assertTrue(all(run.font.size.pt >= 18 for paragraph in shape.text_frame.paragraphs
                                                for run in paragraph.runs))

    def test_long_chinese_and_mixed_text_continues_without_loss_or_tiny_fonts(self):
        detail = ("关键指标同比提升，范围与证据待确认。English API=200 / ¥1,234.50，\n" * 33)[:2000]
        stats = {}
        content = native.export_native([{"title": ("复杂技术方案与边界" * 14)[:120], "detail": detail}], metadata=stats)
        deck = Presentation(BytesIO(content))
        self.assertGreater(len(deck.slides), 1)
        self.assertEqual(body_text(deck).replace("\n", ""), detail.replace("\n", ""))
        self.assertEqual(stats["continuedSlides"], len(deck.slides) - 1)
        for slide in deck.slides:
            title = next(shape for shape in slide.shapes if shape.name == "可编辑标题")
            bodies = [shape for shape in slide.shapes if shape.name.startswith("可编辑正文")]
            for body in bodies:
                self.assertGreater(body.top, title.top + title.height)
                self.assertGreaterEqual(body.height / 12700, len(body.text_frame.paragraphs) * 18 * 1.35)

    def test_multi_column_continuations_preserve_all_content_in_order(self):
        detail = "\n".join(f"第{i}项需求：保留已有系统数据，不遗漏业务条件。" for i in range(65))
        for layout in ("comparison", "process"):
            with self.subTest(layout=layout):
                deck = Presentation(BytesIO(native.export_native([{"title": "全部需求", "detail": detail, "layout": layout}])))
                self.assertGreater(len(deck.slides), 1)
                self.assertEqual(body_text(deck).replace("\n", ""), detail.replace("\n", ""))
                for slide in deck.slides:
                    for body in (shape for shape in slide.shapes if shape.name.startswith("可编辑正文")):
                        self.assertGreaterEqual(body.height / 12700, len(body.text_frame.paragraphs) * 18 * 1.35)

    def test_content_length_boundaries_fit_each_layout_and_preserve_all_visible_text(self):
        for layout in sorted(native.LAYOUTS):
            for length in (0, 1, 180, 500, 501, 2000):
                with self.subTest(layout=layout, length=length):
                    detail = ("项目事实及证据保持完整。中文 English 内容\n" * 100)[:length]
                    deck = Presentation(BytesIO(native.export_native([
                        {"title": "很长的标题" * 20, "detail": detail, "layout": layout}])))
                    self.assertEqual(body_text(deck).replace("\n", ""), detail.strip().replace("\n", ""))
                    for slide in deck.slides:
                        for body in (shape for shape in slide.shapes if shape.name.startswith("可编辑正文") and shape.text):
                            line_count = len(body.text.replace("\v", "\n").split("\n"))
                            font_size = body.text_frame.paragraphs[0].runs[0].font.size.pt
                            paragraph_gap = body.text_frame.paragraphs[0].space_after.pt
                            required = line_count * font_size * 1.35 + (len(body.text_frame.paragraphs) - 1) * paragraph_gap
                            self.assertGreaterEqual(body.height / 12700, required)

    def test_invalid_input_is_rejected_instead_of_silently_cut_or_empty(self):
        invalid = [None, [], [None], [{"title": " "}], [{"title": 3}],
                   [{"title": "标题", "detail": ["text"]}], [{"title": "标题", "detail": "字" * 2001}],
                   [{"title": "标题", "layout": "unknown"}], [{"title": "字" * 121}],
                   [{"title": "标题"}] * 25]
        for pages in invalid:
            with self.subTest(pages=str(pages)[:75]), self.assertRaises(documents.DocumentError):
                native.export_native(pages)

    def test_output_limit_prevents_a_runaway_large_deck(self):
        with self.assertRaisesRegex(documents.DocumentError, "60 页"):
            native.export_native([{"title": "超长内容", "detail": "资料" * 1000}] * 24)

    def test_palette_fields_are_validated_and_builtin_palette_is_authoritative(self):
        for template in ([], {"colors": ["not-a-color"] * 3}, {"colors": None}, {"name": 12}):
            with self.subTest(template=template), self.assertRaises(documents.DocumentError):
                native.export_native([{"title": "测试"}], template)
        deck = Presentation(BytesIO(native.export_native([{"title": "测试"}],
                            {"name": "基础·教育绿", "colors": ["000000"] * 3})))
        self.assertEqual(str(deck.slides[0].background.fill.fore_color.rgb), "F8FBF8")

    def test_confirmed_content_can_be_edited_saved_and_reopened(self):
        deck = Presentation(BytesIO(native.export_native([{"title": "原始标题", "detail": "正文与证据"}])))
        title = next(shape for shape in deck.slides[0].shapes if shape.name == "可编辑标题")
        title.text = "已修改并保存"
        output = BytesIO()
        deck.save(output)
        reopened = Presentation(BytesIO(output.getvalue()))
        self.assertIn("已修改并保存", [shape.text for shape in reopened.slides[0].shapes if shape.has_text_frame])

    def test_native_route_requires_no_image_store_database_or_provider(self):
        db, store, stats = Mock(), Mock(), {}
        with patch.object(workspace, "owned_asset") as owned:
            content = workspace.export_ppt(db, store, 1, {"format": "native", "slides": [
                {"title": "无图片也能导出", "detail": "直接使用已确认的大纲"}]}, export_metadata=stats)
        owned.assert_not_called()
        self.assertEqual(db.mock_calls, [])
        self.assertEqual(store.mock_calls, [])
        self.assertEqual(stats["slides"], 1)
        self.assertEqual(len(Presentation(BytesIO(content)).slides), 1)

    def test_export_rejects_invalid_payload_or_unknown_mode(self):
        for payload in (None, [], {"format": "typo"}):
            with self.subTest(payload=payload), self.assertRaises(workspace.CommercialError):
                workspace.export_ppt(None, None, 1, payload)


class ExistingPowerPointExportTests(unittest.TestCase):
    def test_original_image_export_ignores_stored_text_regions(self):
        data = picture()
        store = Mock()
        store.read.return_value = data
        with patch.object(workspace, "owned_asset", return_value={"id": "asset"}):
            content = workspace.export_ppt(None, store, 1, {"slides": [{"assetId": "asset", "textboxes": [
                {"x": .1, "y": .1, "w": .5, "h": .1, "text": "已标记的文字"}]}]})
        deck = Presentation(BytesIO(content))
        self.assertEqual(len(deck.slides[0].shapes), 1)
        self.assertEqual(deck.slides[0].shapes[0].image.blob, data)

    def test_manual_text_still_exports_when_ocr_unavailable_and_flags_review(self):
        regions = [{"x": .1, "y": .1, "w": .5, "h": .1, "text": "已人工确认"}]
        review, images = [], []
        with patch.object(documents, "_run_ocr", side_effect=documents.DocumentError("OCR 不可用")):
            content = documents.export_presentation([{"image": picture(), "textboxes": regions}], auto=True,
                                                    review_pages=review, image_only_pages=images)
        deck = Presentation(BytesIO(content))
        self.assertEqual(review, [1])
        self.assertEqual(images, [])
        self.assertIn("已人工确认", [shape.text for shape in deck.slides[0].shapes if shape.has_text_frame])

    def test_ocr_unavailable_without_manual_text_does_not_claim_editability(self):
        with patch.object(documents, "_run_ocr", side_effect=documents.DocumentError("OCR 不可用")):
            with self.assertRaisesRegex(documents.DocumentError, "第 1 页"):
                documents.export_presentation([{"image": picture()}], auto=True)

    def test_no_recognized_text_does_not_silently_deliver_image_only_as_editable(self):
        with patch.object(documents, "_run_ocr", return_value=[]):
            with self.assertRaisesRegex(documents.DocumentError, "未找到"):
                documents.export_presentation([{"image": picture()}], auto=True)

    def test_malformed_or_overlapping_regions_still_fail_when_ocr_falls_back(self):
        region = {"x": .1, "y": .1, "w": .5, "h": .1, "text": "确认文字"}
        for regions in ([region, region], [{**region, "x": math.nan}], [{**region, "text": ""}]):
            with self.subTest(regions=regions), patch.object(documents, "_run_ocr", side_effect=OSError("offline")):
                with self.assertRaises(documents.DocumentError):
                    documents.export_presentation([{"image": picture(), "textboxes": regions}], auto=True)

    def test_corrupt_image_cannot_create_partial_document(self):
        with self.assertRaises(documents.DocumentError):
            documents.export_presentation([{"image": picture()}, {"image": b"bad image"}])

    def test_image_asset_ownership_is_enforced(self):
        with patch.object(workspace, "owned_asset", side_effect=workspace.CommercialError(404, "素材不存在")) as owned:
            with self.assertRaises(workspace.CommercialError):
                workspace.export_ppt(None, Mock(), 7, {"slides": [{"assetId": "other-owner"}]})
        owned.assert_called_once_with(None, 7, "other-owner", True)


class OutlineValidationTests(unittest.TestCase):
    def test_plain_or_fenced_json_preserves_confirmed_content(self):
        rows = [{"title": "结论标题", "detail": "正文要点\n数据来源：用户资料"}]
        for reply in (json.dumps(rows, ensure_ascii=False), "```json\n" + json.dumps(rows) + "\n```"):
            self.assertEqual(workspace.outline_result(reply), [[rows[0]["title"], rows[0]["detail"]]])

    def test_invalid_model_structure_or_oversize_is_not_silently_accepted(self):
        values = [None, "这是一份大纲", "null", "[]", '[[]]', '[{"title":"标题"}]',
                  json.dumps([{"title": "字" * 121, "detail": "正文"}]),
                  json.dumps([{"title": "标题", "detail": "字" * 2001}]),
                  json.dumps([{"title": "\u0000", "detail": "正文"}]),
                  json.dumps([{"title": "标题", "detail": "正文", "layout": "unknown"}]),
                  json.dumps([{"title": "标题", "detail": "正文"}] * 25),
                  '[{"title":"第一页","detail":"正文"},{"title":"第二页","detail":']
        for reply in values:
            with self.subTest(reply=str(reply)[:60]), self.assertRaises(workspace.CommercialError) as raised:
                workspace.outline_result(reply)
            self.assertEqual(raised.exception.status, 422)

    def test_full_24_page_outline_preserves_explicit_layouts(self):
        pages = [{"title": f"第 {index + 1} 页", "detail": "已确认的正文", "layout": "points"} for index in range(24)]
        result = workspace.outline_result(json.dumps(pages))
        self.assertEqual(len(result), 24)
        self.assertTrue(all(page[2] == "points" for page in result))


if __name__ == "__main__":
    unittest.main()
