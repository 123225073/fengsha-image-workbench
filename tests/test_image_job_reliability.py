"""Queue boundaries and legacy PPT delivery, without accounts or upstream requests."""

from contextlib import nullcontext
import copy
import json
import sqlite3
from unittest import TestCase
from unittest.mock import MagicMock, patch

import commercial_provider as provider
import commercial_workspace as workspace


class ImageJobReliabilityTests(TestCase):
    def setUp(self):
        self.image = provider._png_sample()[2]
        self.model = {"id": "a" * 32, "name": "fixture", "model": "fixture-model", "price": 0,
                      "maxReferences": 16, "capabilities": ["generate", "reference", "multiReference"]}

    def test_new_submissions_drop_legacy_automatic_review_without_resolving_a_chat_model(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = None
        request = {"requestId": "fixture", "scope": "ppt", "label": "第 1 页", "prompt": "项目进展",
                   "size": "1920x1080", "unitPrice": 0,
                   "context": {"documentId": "fixture-deck", "index": 0, "phase": "final", "reviewModel": "removed-model"}}
        with patch.object(provider, "resolve", return_value=self.model) as resolve, patch.object(
            workspace, "check_image_policy"
        ), patch.object(workspace, "job_detail", return_value={"id": "fixture"}):
            workspace.submit_jobs(db, 17, {"requests": [request]})
        resolve.assert_called_once_with(db, "image", None, "generate")
        inserts = [call for call in db.execute.call_args_list if call.args[0].startswith("INSERT INTO generation_jobs")]
        self.assertEqual(len(inserts), 1)
        payload = json.loads(inserts[0].args[1][9])
        self.assertNotIn("reviewModel", payload["context"])

    def test_existing_queued_ppt_generates_once_preserving_image_and_original_receipt(self):
        for legacy_review in (False, True):
            with self.subTest(legacy_review=legacy_review):
                db = MagicMock()
                payload = {"prompt": "项目进展", "size": "1920x1080", "imageIds": [], "mask": None,
                           "context": {"phase": "final", **({"reviewModel": "legacy-checker"} if legacy_review else {})}}
                before = copy.deepcopy(payload)
                row = {"id": "fixture-job", "owner": 17, "model_id": self.model["id"], "provider_model": self.model["model"]}
                receipt_seen = []

                def generate(*_args, receipt, **_kwargs):
                    receipt.update(requestId="original-upstream-id", responseId="original-response")
                    receipt_seen.append(receipt)
                    return self.image, "1920x1080"

                with patch.object(provider, "resolve", return_value=self.model) as resolve, patch.object(
                    workspace, "check_image_policy", side_effect=lambda _db, prompt: prompt
                ), patch.object(provider, "generate", side_effect=generate) as generation, patch.object(provider, "chat") as chat:
                    data, size, receipt, note = workspace.run_generation(lambda: nullcontext(db), None, row, payload)
                generation.assert_called_once()
                chat.assert_not_called()
                resolve.assert_called_once()
                self.assertIs(data, self.image)
                self.assertEqual(size, "1920x1080")
                self.assertIs(receipt, receipt_seen[0])
                self.assertEqual(receipt, {"requestId": "original-upstream-id", "responseId": "original-response"})
                self.assertEqual(payload, before)
                self.assertEqual(bool(note), legacy_review)
                if note:
                    self.assertIn("手工核对", note)

    def test_duplicate_queue_request_reuses_original_job_without_new_model_or_charge(self):
        db = MagicMock()
        existing = {"id": "existing-job", "status": "queued"}
        db.execute.return_value.fetchone.return_value = existing
        with patch.object(provider, "resolve") as resolve, patch.object(workspace, "change_points") as charge, patch.object(
            workspace, "job_record", side_effect=lambda row: dict(row)
        ):
            result = workspace.submit_jobs(db, 17, {"requests": [{"requestId": "already-submitted"}]})
        self.assertEqual(result, {"jobs": [existing]})
        resolve.assert_not_called()
        charge.assert_not_called()
        self.assertEqual(db.execute.call_count, 1)

    def test_upstream_failure_and_uncertain_result_stay_distinct_without_retry(self):
        for uncertain in (False, True):
            with self.subTest(uncertain=uncertain):
                db = MagicMock()
                row = {"id": "fixture-job", "upstream_id": None, "payload": "{}"}
                error = provider.ProviderError(502, "fixture failure", uncertain, "fixture-upstream")
                with patch.object(workspace, "run_generation", side_effect=error) as generation, patch.object(
                    workspace, "finish_job"
                ) as finish, patch.object(workspace, "archive_image") as archive:
                    workspace.run_job(lambda: nullcontext(db), None, row, None)
                generation.assert_called_once()
                archive.assert_not_called()
                finish.assert_called_once_with(db, row, "unknown" if uncertain else "failed", "fixture failure", "fixture-upstream")

    def test_running_or_finished_jobs_cannot_be_cancelled_and_refunded(self):
        for status in ("running", "succeeded", "failed", "unknown", "cancelled"):
            with self.subTest(status=status):
                db = MagicMock()
                db.execute.return_value.fetchone.return_value = {"id": "fixture", "status": status}
                with patch.object(workspace, "finish_job") as finish, self.assertRaises(workspace.CommercialError) as raised:
                    workspace.cancel_job(db, 17, "fixture")
                self.assertEqual(raised.exception.status, 409)
                finish.assert_not_called()

    def test_asset_read_rejects_another_owner_and_trashed_content(self):
        # Deliberately no users table or account creation: only the ownership boundary under test.
        with sqlite3.connect(":memory:") as db:
            db.row_factory = sqlite3.Row
            db.executescript("""CREATE TABLE assets(id TEXT, user_id INTEGER, name TEXT, mime TEXT);
                CREATE TABLE asset_details(asset_id TEXT, trashed INTEGER, kind TEXT);
                INSERT INTO assets VALUES('fixture',18,'example.png','image/png');""")
            with self.assertRaises(workspace.CommercialError) as raised:
                workspace.owned_asset(db, 17, "fixture", image_only=True)
            self.assertEqual(raised.exception.status, 404)
            db.execute("INSERT INTO asset_details VALUES('fixture',1,'upload')")
            with self.assertRaises(workspace.CommercialError):
                workspace.owned_asset(db, 18, "fixture", image_only=True)
            self.assertEqual(workspace.owned_asset(db, 18, "fixture", image_only=True, include_trash=True)["id"], "fixture")
