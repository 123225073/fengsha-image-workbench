"""Trace a PPT style-board reference from job submission to the provider request."""

import base64
from contextlib import nullcontext
import json
from unittest import TestCase
from unittest.mock import MagicMock, patch

import commercial_provider as provider
import commercial_workspace as workspace


class PptStyleReferenceTests(TestCase):
    def setUp(self):
        self.source = provider._png_sample()[2]
        self.asset_id = "a" * 32
        self.job = {"id": "job", "scope": "ppt", "owner": 17, "model_id": "fixture",
                    "provider_model": "gpt-image-2.6-sunburst"}
        self.request = {"requestId": "fixture", "modelId": "fixture", "scope": "ppt",
                        "label": "项目进展", "prompt": "保留已确认的项目内容；图片只参考配色和版式。",
                        "size": "1920x1080", "unitPrice": 0,
                        "context": {"documentId": "fixture", "index": 0, "phase": "board"}}
        self.response = {"data": [{"b64_json": base64.b64encode(self.source).decode("ascii")}]}

    def test_text_legacy_style_and_single_or_double_image_input(self):
        cases = (("generate", [], "", (), 0),
                 ("reference", [], "paper", ("image/jpeg",), 1),
                 ("reference", [self.asset_id], "", ("image/png",), 1),
                 ("multiReference", [self.asset_id], "signal", ("image/png", "image/jpeg"), 2))
        for capability, assets, reference, mime_types, count in cases:
            with self.subTest(capability=capability, assets=assets, reference=reference):
                db, store = MagicMock(), MagicMock()
                db.execute.return_value.fetchone.return_value = None
                store.read.return_value = self.source
                request = {**self.request, "imageIds": assets,
                           "context": {**self.request["context"],
                                       **({"pptStyleReference": reference} if reference else {})}}
                capabilities = ["generate", "imageStream"] + (["reference"] if count else [])
                if count == 2:
                    capabilities.append("multiReference")
                model = {"id": "fixture", "name": "fixture", "model": self.job["provider_model"],
                         "price": 0, "maxReferences": count, "capabilities": capabilities}
                asset = {"id": self.asset_id, "name": "slide.png", "mime": "image/png"}
                with (patch.object(provider, "resolve", return_value=model) as resolve,
                      patch.object(workspace, "check_image_policy", side_effect=lambda _, prompt: prompt),
                      patch.object(workspace, "owned_asset", return_value=asset) as owned_asset,
                      patch.object(workspace, "job_detail", return_value={"id": "job"}),
                      patch.object(provider, "_json_request", return_value=self.response) as send,
                      patch.object(provider, "_stream_image") as stream):
                    workspace.submit_jobs(db, self.job["owner"], {"requests": [request]})
                    params = next(call.args[1] for call in db.execute.call_args_list
                                  if call.args[0].startswith("INSERT INTO generation_jobs"))
                    payload = json.loads(params[9])
                    self.assertEqual(payload["imageIds"], assets)
                    self.assertEqual(payload["context"].get("pptStyleReference", ""), reference)
                    # Regeneration skips SSE. The fixture model also uses non-streaming edits.
                    if not count:
                        payload["context"]["regenerate"] = True
                    data, size, *_ = workspace.run_generation(lambda: nullcontext(db), store, self.job, payload)
                self.assertEqual([call.args[3] for call in resolve.call_args_list], [capability] * 2)
                self.assertEqual([call.args[2] for call in owned_asset.call_args_list], assets * 2)
                self.assertEqual((data, size), (self.source, self.request["size"]))
                stream.assert_not_called()
                send.assert_called_once()
                endpoint = "/images/edits" if count else "/images/generations"
                self.assertEqual(send.call_args.args[1], endpoint)
                if count:
                    multipart = send.call_args.kwargs["raw"]
                    positions = [multipart.index(f"Content-Type: {mime}".encode()) for mime in mime_types]
                    self.assertEqual(positions, sorted(positions))
                    self.assertEqual(multipart.count(b'filename="reference-'), count)
                    if reference:
                        self.assertIn(workspace.PPT_STYLE_REFERENCES[reference].read_bytes(), multipart)
                else:
                    self.assertEqual(send.call_args.kwargs["payload"]["prompt"], self.request["prompt"])

    def test_unknown_reference_key_or_limit_does_not_enqueue(self):
        for reference in ("../paper", "paper"):
            with self.subTest(reference=reference):
                db = MagicMock()
                db.execute.return_value.fetchone.return_value = None
                request = {**self.request, "context": {**self.request["context"], "pptStyleReference": reference}}
                model = {"price": 0, "maxReferences": 0, "capabilities": ["generate", "reference"]}
                with (patch.object(provider, "resolve", return_value=model),
                      patch.object(workspace, "check_image_policy"),
                      self.assertRaises(workspace.CommercialError)):
                    workspace.submit_jobs(db, self.job["owner"], {"requests": [request]})
                self.assertFalse(any(call.args[0].startswith("INSERT INTO generation_jobs")
                                     for call in db.execute.call_args_list))
