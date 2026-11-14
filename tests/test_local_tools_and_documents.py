"""Real local file/image operations on synthetic data; no accounts, models or network."""

from io import BytesIO
import sqlite3
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from docx import Document
from openpyxl import Workbook
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

import commercial_animation as animation
import commercial_documents as documents
import commercial_formats as formats
import commercial_image_tools as image_tools
import commercial_projects as projects
import commercial_provider as provider
import commercial_workspace as workspace


def encoded_image(image, image_format="PNG", **options):
    stream = BytesIO()
    image.save(stream, image_format, **options)
    return stream.getvalue()


def pdf_fixture(*, text="Revenue 1200", encrypted=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if text:
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                 NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        content.set_data(f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode("ascii"))
        page[NameObject("/Contents")] = content
    if encrypted:
        writer.encrypt("synthetic-document-password")
    target = BytesIO()
    writer.write(target)
    return target.getvalue()


class DocumentExtractionTests(unittest.TestCase):
    def test_text_encodings_newlines_and_filename_are_preserved(self):
        for encoding in ("utf-8-sig", "utf-16", "gb18030"):
            with self.subTest(encoding=encoding):
                value = documents.extract_document(r"C:\fixture\需求.txt", "部门汇报\r\n收入 1200 元".encode(encoding))
                self.assertIn("文件：需求.txt", value)
                self.assertIn("部门汇报\n收入 1200 元", value)
                self.assertNotIn("C:\\fixture", value)

    def test_empty_binary_and_unsupported_documents_fail_with_useful_errors(self):
        for name, data in (("empty.txt", b""), ("binary.txt", b"text\x00data"), ("old.doc", b"example")):
            with self.subTest(name=name), self.assertRaises(documents.DocumentError) as raised:
                documents.extract_document(name, data)
            self.assertTrue(str(raised.exception))

    def test_long_text_is_bounded_and_reports_truncation(self):
        value = documents.extract_document("long.md", ("可核查事实。" * 6000).encode())
        self.assertLessEqual(len(value), documents.MAX_SOURCE_CHARS)
        self.assertIn("其余内容已省略", value)
        self.assertTrue(value.startswith("文件：long.md"))

    def test_docx_keeps_paragraph_table_order_and_values(self):
        doc = Document()
        doc.add_paragraph("项目目标")
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text, table.cell(0, 1).text = "部门", "进度"
        table.cell(1, 0).text, table.cell(1, 1).text = "采购", "80%"
        doc.add_paragraph("风险与下一步")
        stream = BytesIO(); doc.save(stream)
        value = documents.extract_document("report.docx", stream.getvalue())
        self.assertLess(value.index("项目目标"), value.index("采购 | 80%"))
        self.assertLess(value.index("采购 | 80%"), value.index("风险与下一步"))
        self.assertIn("表格", value)

    def test_xlsx_keeps_sheet_row_sources_and_warns_about_unread_rows(self):
        book = Workbook()
        first = book.active; first.title = "预算"
        first.append(["部门", "金额"]); first.append(["采购", 1200])
        first.cell(151, 1, "不应静默混入")
        second = book.create_sheet("计划"); second.append(["发布", "11月"])
        stream = BytesIO(); book.save(stream); book.close()
        value = documents.extract_document("report.xlsx", stream.getvalue())
        self.assertIn("工作表 预算 · 第 2 行", value)
        self.assertIn("采购 | 1200", value)
        self.assertIn("工作表 计划", value)
        self.assertIn("仅提取前 150 行与 40 列", value)
        self.assertNotIn("不应静默混入", value)

    def test_pptx_extracts_grouped_text_tables_and_slide_locations(self):
        deck = Presentation()
        first = deck.slides.add_slide(deck.slide_layouts[6])
        first.shapes.add_textbox(0, 0, Inches(5), Inches(1)).text = "项目汇报"
        group = first.shapes.add_group_shape()
        group.shapes.add_textbox(0, Inches(1), Inches(5), Inches(1)).text = "组内里程碑"
        table = first.shapes.add_table(1, 2, 0, Inches(2), Inches(5), Inches(1)).table
        table.cell(0, 0).text, table.cell(0, 1).text = "完成率", "80%"
        second = deck.slides.add_slide(deck.slide_layouts[6])
        second.shapes.add_textbox(0, 0, Inches(5), Inches(1)).text = "下一步计划"
        stream = BytesIO(); deck.save(stream)
        value = documents.extract_document("report.pptx", stream.getvalue())
        for text in ("幻灯片 1", "项目汇报", "组内里程碑", "完成率 | 80%", "幻灯片 2", "下一步计划"):
            self.assertIn(text, value)

    def test_pdf_extracts_text_with_page_source(self):
        value = documents.extract_document("report.pdf", pdf_fixture())
        self.assertIn("第 1 页", value)
        self.assertIn("Revenue 1200", value)

    def test_encrypted_and_textless_pdf_do_not_silently_produce_an_empty_plan(self):
        for data, message in ((pdf_fixture(encrypted=True), "已加密"), (pdf_fixture(text=""), "未提取到文字")):
            with self.subTest(message=message), self.assertRaises(documents.DocumentError) as raised:
                documents.extract_document("report.pdf", data)
            self.assertIn(message, str(raised.exception))

    def test_office_corruption_and_expanded_size_are_rejected(self):
        for suffix in ("docx", "xlsx", "pptx"):
            with self.subTest(suffix=suffix), self.assertRaises(documents.DocumentError):
                documents.extract_document("broken." + suffix, b"not-a-zip")
        archive = BytesIO()
        with ZipFile(archive, "w") as zipped:
            zipped.writestr("[Content_Types].xml", "x" * 64)
        with patch.object(documents, "MAX_OFFICE_EXPANDED", 32), self.assertRaises(documents.DocumentError) as raised:
            documents.extract_document("too-expanded.docx", archive.getvalue())
        self.assertIn("展开后过大", str(raised.exception))


class MemoryStore:
    def __init__(self):
        self.data = {}

    def read(self, identifier):
        return self.data[identifier]

    def put(self, identifier, value):
        self.data[identifier] = value


class LocalImageToolsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        # Asset-only fixture. No users table, account creation, credentials or network.
        self.db.executescript("""CREATE TABLE assets(id TEXT PRIMARY KEY,user_id INTEGER,name TEXT,mime TEXT,size INTEGER,created INTEGER);
            CREATE TABLE asset_details(asset_id TEXT PRIMARY KEY,job_id TEXT,parent_id TEXT,kind TEXT,trashed INTEGER DEFAULT 0);
            CREATE TABLE generation_jobs(id TEXT PRIMARY KEY,asset_id TEXT,submitted_size TEXT,width INTEGER,height INTEGER,
                status TEXT,error TEXT,upstream_id TEXT,updated INTEGER);""")
        self.store = MemoryStore()
        self.next_id = 1

    def asset(self, data, mime="image/png"):
        identifier = f"{self.next_id:032x}"; self.next_id += 1
        self.store.put(identifier, data)
        self.db.execute("INSERT INTO assets VALUES(?,17,'fixture',?,?,0)", (identifier, mime, len(data)))
        return identifier

    def test_crop_produces_exact_size_and_retains_alpha_without_changing_original(self):
        source = Image.new("RGBA", (128, 96), (0, 0, 0, 0))
        ImageDraw.Draw(source).rectangle((40, 30, 88, 66), fill=(230, 30, 20, 255))
        data = encoded_image(source); identifier = self.asset(data)
        result = image_tools.resize(self.db, self.store, 17, {"sourceId": identifier, "size": "64x64"}, "f" * 32)
        with Image.open(BytesIO(self.store.read(result["id"]))) as output:
            self.assertEqual((output.format, output.mode, output.size), ("PNG", "RGBA", (64, 64)))
            self.assertEqual(output.getpixel((0, 0))[3], 0)
            self.assertEqual(output.getpixel((32, 32)), (230, 30, 20, 255))
        self.assertEqual(self.store.read(identifier), data)

    def test_crop_rejects_invalid_dimensions_before_producing_output(self):
        identifier = self.asset(encoded_image(Image.new("RGB", (64, 64), "red")))
        for size in ("1x64", "4097x64", "64.5x64", "-64x64", "64X64"):
            with self.subTest(size=size), self.assertRaises(workspace.CommercialError):
                image_tools.quote(self.db, 17, "resize_image", {"sourceId": identifier, "size": size}, store=self.store)
        self.assertEqual(len(self.store.data), 1)

    def test_animation_concatenates_gif_and_still_in_order_with_timing(self):
        red = Image.new("RGB", (64, 32), "red"); green = Image.new("RGB", (64, 32), "lime")
        gif = encoded_image(red, "GIF", save_all=True, append_images=[green], duration=[100, 200], loop=0)
        first = self.asset(gif, "image/gif")
        second = self.asset(encoded_image(Image.new("RGB", (64, 32), "blue")))
        data, mime = animation.compose(self.db, self.store, 17, {"clips": [{"assetId": first}, {"assetId": second, "durationMs": 300}]})
        self.assertEqual(mime, "image/gif")
        with Image.open(BytesIO(data)) as output:
            self.assertEqual((output.n_frames, output.size, output.info["loop"]), (3, (64, 32), 0))
            for index, (color, delay) in enumerate((((255, 0, 0), 100), ((0, 255, 0), 200), ((0, 0, 255), 300))):
                output.seek(index)
                self.assertEqual(output.convert("RGB").getpixel((32, 16)), color)
                self.assertEqual(output.info["duration"], delay)

    def test_animation_preserves_proportions_and_respects_non_looping_export(self):
        ids = [self.asset(encoded_image(Image.new("RGB", (64, 32), color))) for color in ("red", "blue")]
        data, _ = animation.compose(self.db, self.store, 17, {"clips": [{"assetId": value} for value in ids], "loop": False}, canvas_size=(64, 64))
        with Image.open(BytesIO(data)) as output:
            self.assertNotIn("loop", output.info)
            frame = output.convert("RGB")
            self.assertEqual(frame.getpixel((32, 0)), (21, 26, 24))
            self.assertEqual(frame.getpixel((32, 32)), (255, 0, 0))

    def test_animation_rejects_short_selection_corruption_and_excess_duration(self):
        valid = self.asset(encoded_image(Image.new("RGB", (64, 64), "red")))
        broken = self.asset(b"broken-image")
        selections = [([{"assetId": valid}], 400), ([{"assetId": valid}, {"assetId": broken}], 422),
                      ([{"assetId": valid, "durationMs": 10000}] * 7, 413)]
        for clips, status in selections:
            with self.subTest(status=status), self.assertRaises(workspace.CommercialError) as raised:
                animation.compose(self.db, self.store, 17, {"clips": clips})
            self.assertEqual(raised.exception.status, status)

    def test_storyboard_export_reads_cells_in_order_and_retains_timing(self):
        sheet = Image.new("RGB", (128, 128)); draw = ImageDraw.Draw(sheet)
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        for index, color in enumerate(colors):
            x, y = (index % 2) * 64, (index // 2) * 64
            draw.rectangle((x, y, x + 63, y + 63), fill=color)
        metadata = {}
        data = formats.finish_raster(encoded_image(sheet), "64x64", {"method": "sheet", "frames": 4, "frameDurationMs": 120}, metadata=metadata)
        with Image.open(BytesIO(data)) as output:
            self.assertEqual((output.format, output.n_frames, output.size), ("GIF", 4, (64, 64)))
            for index, color in enumerate(colors):
                output.seek(index)
                self.assertEqual(output.convert("RGB").getpixel((32, 32)), color)
                self.assertEqual(output.info["duration"], 120)
        self.assertEqual(metadata["storyboardSize"], "128x128")

    def test_storyboard_rejects_static_or_insufficient_source(self):
        for size in ((128, 128), (32, 32)):
            with self.subTest(size=size), self.assertRaises(ValueError):
                formats.finish_raster(encoded_image(Image.new("RGB", size, "red")), "64x64",
                                      {"method": "sheet", "frames": 4, "frameDurationMs": 120})

    def test_svg_tracing_creates_real_paths_and_archives_a_valid_vector_asset(self):
        source = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        ImageDraw.Draw(source).rectangle((24, 24, 104, 104), fill="red")
        data = formats.finish_raster(encoded_image(source), "256x128", {"method": "trace", "format": "svg"})
        self.assertEqual(provider.svg_dimensions(data), (256, 128))
        root = ET.fromstring(data)
        self.assertTrue(root.findall(".//{http://www.w3.org/2000/svg}path"))
        self.assertFalse(root.findall(".//{http://www.w3.org/2000/svg}image"))
        identifier = "e" * 32
        self.db.execute("INSERT INTO generation_jobs(id,status) VALUES(?,'running')", (identifier,))
        row = {"id": identifier, "owner": 17, "label": "矢量导出", "scope": "image", "price": 0}
        workspace.archive_image(self.db, self.store, row, {"imageIds": [], "output": {"format": "svg"}}, data, "1024x1024")
        asset = workspace.owned_asset(self.db, 17, identifier)
        self.assertEqual(asset["mime"], "image/svg+xml")
        self.assertTrue(asset["name"].endswith(".svg"))
        self.assertEqual(provider.svg_dimensions(self.store.read(identifier)), (256, 128))
        self.assertEqual(self.db.execute("SELECT status FROM generation_jobs WHERE id=?", (identifier,)).fetchone()[0], "succeeded")

    def test_svg_rejects_blank_source_and_external_or_executable_content(self):
        with self.assertRaises(ValueError):
            formats.finish_raster(encoded_image(Image.new("RGBA", (64, 64), (0, 0, 0, 0))), "64x64", {"method": "trace"})
        for content in ('<script>alert(1)</script>', '<image href="https://example.invalid/a.png"/>', '<rect width="10" height="10" onclick="alert(1)"/>'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                provider.svg_dimensions(f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">{content}</svg>'.encode())


class ProjectIsolationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:"); self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        projects.setup(self.db)

    def project(self, owner, name):
        return projects.route(self.db, "POST", "/api/projects", owner, {"name": name})["project"]

    def test_same_history_identifier_is_separate_for_each_project_and_owner(self):
        first, second = self.project(17, "项目甲"), self.project(17, "项目乙")
        session = "11111111-1111-1111-1111-111111111111"
        targets = [(17, first["id"], "甲项目的需求"), (17, second["id"], "乙项目的需求"), (18, "", "另一个所有者的需求")]
        for owner, project, brief in targets:
            projects.ppt_session(self.db, owner, project, {"archive": {"id": session, "title": brief, "document": {"brief": brief}}})
        for owner, project, brief in targets:
            reopened = projects.ppt_session(self.db, owner, project, {"open": session})
            self.assertEqual(reopened["opened"]["document"]["brief"], brief)
            self.assertEqual(len(reopened["sessions"]), 1)
        with self.assertRaises(projects.ProjectError) as raised:
            projects.ppt_session(self.db, 18, first["id"], {"open": session})
        self.assertEqual(raised.exception.status, 404)

    def test_stale_project_save_cannot_overwrite_newer_content(self):
        project = self.project(17, "持久化测试")
        path = "/api/projects/" + project["id"]
        saved = projects.route(self.db, "PUT", path, 17, {"revision": project["revision"], "workspace": {"document": {"brief": "新需求"}}})["project"]
        with self.assertRaises(projects.ProjectError) as raised:
            projects.route(self.db, "PUT", path, 17, {"revision": project["revision"], "workspace": {"document": {"brief": "过期覆盖"}}})
        self.assertEqual(raised.exception.status, 409)
        reopened = projects.route(self.db, "GET", path, 17)["project"]
        self.assertEqual(reopened["workspaces"]["ppt"]["document"]["brief"], "新需求")
        self.assertEqual(reopened["revision"], saved["revision"])


if __name__ == "__main__":
    unittest.main()
