import base64
import json
from contextlib import contextmanager, nullcontext
import sqlite3
from unittest import TestCase
from unittest.mock import MagicMock, patch

import commercial_provider as provider
import commercial_workspace as workspace


class ImageDeliveryTests(TestCase):
    def setUp(self):
        self.reference = provider._png_sample()
        self.image = self.reference[2]
        self.response = {"data": [{"b64_json": base64.b64encode(self.image).decode("ascii")}]}

    def test_explicit_image_policy_rejection_does_not_retry_or_expose_response(self):
        upstream = MagicMock(status=400)
        upstream.getheader.return_value = "fixture-request"
        upstream.read.return_value = json.dumps({"error": {"code": "content_policy_violation", "param": "size",
            "message": "invalid output size; private provider details"}}).encode()
        with patch.object(provider, "_response", return_value=nullcontext(upstream)) as request:
            with self.assertRaises(provider.ProviderError) as raised:
                provider.generate({"model": "fixture", "baseUrl": "https://provider.example", "key": "fixture"},
                                  "测试", "1024x576", [self.reference])
            request.assert_called_once()
        self.assertEqual(raised.exception.request_id, "fixture-request")
        self.assertIn("内容审核拒绝", str(raised.exception))
        self.assertIsNone(raised.exception.size_rejection)
        self.assertNotIn("private provider details", str(raised.exception))

    def test_image_error_distinguishes_reported_fields_and_ambiguous_responses(self):
        cases = [({"param": "image[]"}, "参考图"), ({"param": "size"}, "输出尺寸"),
                 ({"type": "invalid_request_error", "message": "invalid request"}, "未能确认具体原因")]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                upstream = MagicMock(status=422)
                upstream.getheader.return_value = None
                upstream.read.return_value = json.dumps({"error": fields}).encode()
                error = provider._status_error(upstream, True, image_request=True)
                self.assertIn(expected, str(error))
                self.assertNotIn("内容审核拒绝", str(error))

    def test_reference_images_and_masks_use_non_streaming_on_affected_models(self):
        for model in ("gpt-image-2.5", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"):
            for mask in (None, provider._png_sample(mask=True)):
                with self.subTest(model=model, mask=bool(mask)), patch.object(
                    provider, "_json_request", return_value=self.response
                ) as request, patch.object(provider, "_stream_image") as stream:
                    config = {"model": model, "capabilities": ["imageStream"]}
                    actual, size = provider.generate(config, "Fixture", "1024x1024",
                                                     [self.reference], mask, on_preview=self.fail)
                    self.assertEqual((actual, size), (self.image, "1024x1024"))
                    request.assert_called_once()
                    self.assertEqual(request.call_args.args[1], "/images/edits")
                    self.assertNotIn(b'name="stream"', request.call_args.kwargs["raw"])
                    if mask:
                        self.assertIn(b'name="mask"', request.call_args.kwargs["raw"])
                    stream.assert_not_called()

    def test_empty_stream_is_uncertain_and_does_not_resubmit(self):
        class EmptyStream:
            status = 200

            def getheader(self, name):
                return {"Content-Type": "text/event-stream", "x-request-id": "fixture-request"}.get(name)

            def readline(self, _limit):
                return b""

        @contextmanager
        def response(*args, **kwargs):
            yield EmptyStream()

        config = {"model": "gpt-image-2.6-sunburst", "baseUrl": "https://provider.example",
                  "key": "fixture", "capabilities": ["imageStream"]}
        with patch.object(provider, "_response", side_effect=response) as stream, patch.object(
            provider, "_json_request"
        ) as retry:
            with self.assertRaises(provider.ProviderError) as raised:
                provider.generate(config, "Fixture", "1024x1024", on_preview=self.fail)
            stream.assert_called_once()
            retry.assert_not_called()
        self.assertTrue(raised.exception.uncertain)
        self.assertEqual(raised.exception.request_id, "fixture-request")
        self.assertIn("没有返回任何图片事件", raised.exception.message)

    def test_archive_failure_preserves_upstream_request_id_for_reconciliation(self):
        db = MagicMock()
        row = {"id": "fixture", "upstream_id": None, "payload": "{}"}

        def database():
            return nullcontext(db)

        for error in (OSError, sqlite3.IntegrityError):
            with self.subTest(error=error), patch.object(
                workspace, "run_generation",
                return_value=(self.image, "1024x1024", {"requestId": "fixture-request"}, None),
            ), patch.object(workspace, "archive_image", side_effect=error), patch.object(workspace, "finish_job") as finish:
                workspace.run_job(database, None, row, None)
            finish.assert_called_once_with(db, row, "unknown", "已收到上游结果，归档未完成，请核对。", "fixture-request")
