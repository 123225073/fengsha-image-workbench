from io import BytesIO
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from PIL import Image
from pptx import Presentation
import commercial_documents as documents
import commercial_ppt_brief as brief
import commercial_projects as projects
import commercial_ppt as ppt
import workspace_server as server


class UploadValidationTests(TestCase):
    def upload(self, data, name="fixture.png"):
        handler = server.WorkspaceHandler.__new__(server.WorkspaceHandler)
        handler.headers = {"X-File-Name": name}
        handler.read_body = lambda _: data
        handler.server = SimpleNamespace(assets=MagicMock())
        db = MagicMock()
        return handler, db

    def test_header_only_png_rejected_before_storage(self):
        handler, db = self.upload(b"\x89PNG\r\n\x1a\n")
        with self.assertRaises(server.ApiError) as error:
            handler.upload_asset(db, 1)
        self.assertEqual(error.exception.status, 400)
        handler.server.assets.put.assert_not_called()
        db.execute.assert_not_called()

    def test_valid_image_preserves_original_bytes(self):
        output = BytesIO()
        Image.new("RGB", (30, 20), "blue").save(output, "PNG")
        handler, db = self.upload(output.getvalue())
        result = handler.upload_asset(db, 1)
        self.assertEqual(result["size"], len(output.getvalue()))
        self.assertEqual(handler.server.assets.put.call_args.args[1], output.getvalue())

    def test_truncated_jpeg_rejected_before_storage(self):
        output = BytesIO()
        Image.new("RGB", (100, 100), "blue").save(output, "JPEG")
        handler, db = self.upload(output.getvalue()[:-30], "fixture.jpg")
        with self.assertRaises(server.ApiError):
            handler.upload_asset(db, 1)
        handler.server.assets.put.assert_not_called()

    def test_oversized_image_rejected_before_decoding(self):
        output = BytesIO()
        Image.new("RGB", (30, 20)).save(output, "PNG")
        handler, db = self.upload(output.getvalue())
        with patch.object(documents, "MAX_IMAGE_PIXELS", 100), self.assertRaises(server.ApiError):
            handler.upload_asset(db, 1)
        handler.server.assets.put.assert_not_called()


class PptBriefTests(TestCase):
    def test_template_agenda_recognizes_slide_heading_only(self):
        self.assertTrue(brief.template_has_agenda("文件：参考.pptx\n\n【幻灯片 2】\n目录\n阶段一\n阶段二"))
        self.assertFalse(brief.template_has_agenda("【幻灯片 3】\n管理方法\n请提供目录"))

    def test_base_templates_are_valid_in_admin_preset_settings(self):
        for name in ppt.PALETTES:
            self.assertIn(name, projects._template_settings("ppt", {"style": name}))

    def test_chinese_punctuation_does_not_start_wrapped_lines(self):
        text = "核对关键假设。下一步推进交付，记录结果。"
        lines = ppt._wrap(text, 1.0, 20)
        self.assertEqual("".join(lines), text)
        self.assertFalse(any(line.startswith(("。", "，")) for line in lines))

    def test_repeated_punctuation_is_still_wrapped(self):
        text = "，" * 2000
        lines = ppt._wrap(text, 3.0, 20)
        self.assertEqual("".join(lines), text)
        self.assertGreater(len(lines), 100)
        self.assertLess(max(map(len, lines)), 13)

    def test_multiline_title_never_pushes_shapes_outside_the_slide(self):
        title = "\n".join(["标题"] * 20)
        deck = Presentation(BytesIO(ppt.export_native([{"title": title, "detail": "正文", "layout": "points"}])))
        for slide in deck.slides:
            self.assertIn(title, slide.notes_slide.notes_text_frame.text)
            for shape in slide.shapes:
                self.assertGreater(shape.height, 0)
                self.assertGreaterEqual(shape.top, 0)
                self.assertLessEqual(shape.top + shape.height, deck.slide_height)

    def test_missing_requirements_still_accepts_natural_language(self):
        self.assertIn("对话", brief.requirements_text(None))
        self.assertIn("对话", brief.requirements_text({}))

    def test_facts_and_page_count_are_preserved(self):
        value = brief.requirements_text({"audience": "财务负责人", "goal": "批准试点", "duration": "15",
                                         "pageCount": "16", "mustInclude": "2026-11 数据，金额为 -12.50 万元"})
        for expected in ["财务负责人", "批准试点", "16", "-12.50", "2026-11"]:
            self.assertIn(expected, value)

    def test_invalid_requirements_never_silently_change_limits(self):
        for value in [[], {"audience": {}}, {"pageCount": "25"}, {"duration": "0"}, {"pageCount": "12.5"}]:
            with self.subTest(value=value), self.assertRaises(documents.DocumentError):
                brief.requirements_text(value)
