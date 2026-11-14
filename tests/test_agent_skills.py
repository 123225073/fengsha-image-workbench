"""Agent regression checks use an isolated database and local images only."""

import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import commercial_agent as agent
import commercial_ecommerce as ecommerce
import commercial_image_tools as image_tools
import commercial_provider as provider
import commercial_workspace as workspace
import workspace_server as server


class AgentSkillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name, value in (("DATA", root), ("DATABASE", root / "fixture.sqlite3")):
            hook = patch.object(server, name, value)
            hook.start()
            self.addCleanup(hook.stop)
        self.store = server.setup()
        self.conversation = "a" * 32
        self.asset = "b" * 32
        content = io.BytesIO()
        Image.new("RGB", (120, 80), "#306a7e").save(content, "PNG")
        self.image = content.getvalue()
        self.store.put(self.asset, self.image)
        with server.database() as db:
            db.execute("INSERT INTO users(id,email,name,password,role,points,created) VALUES(1,'fixture@example.invalid','fixture','unused','admin',1000000,0)")
            db.execute("INSERT INTO conversations VALUES(?,1,'新对话',0)", (self.conversation,))
            db.execute("INSERT INTO assets VALUES(?,1,'商品.png','image/png',?,0)", (self.asset, len(self.image)))
        self.model = {"id": "c" * 32, "name": "fixture", "model": "fixture", "capabilities": ["text", "vision"],
                      "tokenRates": {"input": 0, "output": 0}}

    def prior(self, db, text, *, assets=None, actions=None):
        turn = db.execute("""INSERT INTO chat_turns(conversation,request_id,user_text,model_name,price,status,created,asset_ids)
            VALUES(?,?,?,'fixture',0,'succeeded',0,?)""", (self.conversation, text, text, json.dumps(assets) if assets else None)).lastrowid
        if actions:
            return agent.save_plan(db, turn, actions)
        return turn

    def start(self, db, text, **kwargs):
        with patch.object(provider, "resolve", return_value=self.model):
            return agent.start(db, 1, self.conversation, {"text": text, "requestId": "new-request",
                "tokenRates": self.model["tokenRates"], **kwargs})

    def test_catalog_exposes_actual_rules_and_all_available_tools(self):
        result = agent.skill_catalog()
        self.assertEqual(result["agent"]["instructions"], agent.SYSTEM)
        self.assertEqual({item["id"] for item in result["agent"]["tools"]}, set(image_tools.TOOLS) | {image_tools.ANIMATION_TOOL})
        self.assertEqual(len(result["skills"]), 5)
        for skill in result["skills"]:
            if skill["id"] != "auto":
                self.assertEqual(skill["instructions"], ecommerce.instructions(skill["id"]))
                self.assertTrue(skill["example"])
        json.dumps(result, ensure_ascii=False)

    def test_general_image_request_receives_visual_reference_without_ecommerce_skill(self):
        with server.database() as db:
            result = self.start(db, "请分析这张图的构图和色彩", assetIds=[self.asset])
        self.assertIsNone(result[-2])
        self.assertEqual([row[1]["id"] for row in result[-1]], [self.asset])
        actual = ecommerce.attach_reference_images(result[1], self.store, result[-1])
        images = [entry for entry in actual[-1]["content"] if entry["type"] == "image_url"]
        self.assertEqual(len(images), 1)
        with Image.open(io.BytesIO(base64.b64decode(images[0]["image_url"]["url"].split(",", 1)[1]))) as photo:
            self.assertEqual(photo.size, (120, 80))

    def test_admin_rules_persist_and_apply_only_to_the_selected_skill(self):
        with server.database() as db:
            agent.save_rule(db, 1, "agent", {"text": "先说明推荐的交付顺序。", "revision": 0})
            agent.save_rule(db, 1, "studio", {"text": "请使用本店规定的中性背景。", "revision": 0})
            agent.save_rule(db, 1, "campaign", {"text": "促销页标题下加活动日期。", "revision": 0})
        with server.database() as db:
            self.assertIn("中性背景", agent.skill_catalog(db)["customRules"]["studio"]["text"])
            result = self.start(db, "请规划商品主图")
            prompt = result[1][0]["content"]
            self.assertIn(agent.SYSTEM, prompt)
            self.assertIn(ecommerce.instructions("studio"), prompt)
            self.assertIn("推荐的交付顺序", prompt)
            self.assertIn("中性背景", prompt)
            self.assertNotIn("加活动日期", prompt)
            self.assertNotIn("customRules", agent.skill_catalog())

    def test_rule_conflict_and_restore_preserve_newer_edits(self):
        with server.database() as db:
            agent.save_rule(db, 1, "studio", {"text": "新规则", "revision": 0})
            with self.assertRaises(workspace.CommercialError) as blocked:
                agent.save_rule(db, 1, "studio", {"text": "", "revision": 0})
            self.assertEqual(blocked.exception.status, 409)
            self.assertEqual(agent.skill_catalog(db)["customRules"]["studio"]["text"], "新规则")
            with self.assertRaises(workspace.CommercialError):
                agent.save_rule(db, 1, "auto", {"text": "新规则", "revision": 0})
            agent.save_rule(db, 1, "studio", {"text": "", "revision": 1})
            result = self.start(db, "请规划商品主图")
            self.assertNotIn("新规则", result[1][0]["content"])
            self.assertIn(ecommerce.instructions("studio"), result[1][0]["content"])

    def test_read_only_guide_does_not_expose_admin_rules(self):
        handler = server.WorkspaceHandler.__new__(server.WorkspaceHandler)
        handler.current_user = lambda db: {"id": 1, "role": "user"}
        with server.database() as db:
            agent.save_rule(db, 1, "agent", {"text": "后台补充规则", "revision": 0})
            self.assertNotIn("customRules", handler.route(db, "GET", "/api/skills"))
            for method, path in [("GET", "/api/admin/skills"), ("PUT", "/api/admin/skills/agent")]:
                with self.assertRaises(server.ApiError) as blocked:
                    handler.route(db, method, path)
                self.assertEqual(blocked.exception.status, 403)

    def test_consecutive_followups_keep_skill_and_product(self):
        with server.database() as db:
            self.prior(db, "请规划商品主图", assets=[self.asset])
            self.prior(db, "继续改为浅灰色背景")
            self.prior(db, "沿用这一版，阴影再柔和些")
            result = self.start(db, "继续把主体放大一点")
        self.assertEqual(result[-2], "studio")
        self.assertEqual([row[1]["id"] for row in result[-1]], [self.asset])

    def test_followup_recovers_manually_selected_skill_from_plan(self):
        with server.database() as db:
            self.prior(db, "做三张这个产品的图", assets=[self.asset], actions=[{
                "creativeSkill": "电商套图", "total": 0, "label": "主图", "size": "1024x1024",
                "referenceIds": [self.asset], "prompt": "同款商品"}])
            self.prior(db, "继续把背景换成白色")
            result = self.start(db, "沿用上版，再减小阴影")
        self.assertEqual(result[-2], "set")
        self.assertEqual([row[1]["id"] for row in result[-1]], [self.asset])

    def test_new_topic_does_not_restore_old_product_or_skill(self):
        with server.database() as db:
            self.prior(db, "请规划商品主图", assets=[self.asset])
            self.prior(db, "帮我写一段会议开场白")
            result = self.start(db, "继续精简内容")
        self.assertIsNone(result[-2])
        self.assertFalse(result[-1])

    def test_explicit_product_reset_does_not_restore_product(self):
        with server.database() as db:
            self.prior(db, "请规划商品主图", assets=[self.asset])
            result = self.start(db, "换一款商品，不要沿用上一张，继续规划")
        self.assertIsNone(result[-2])
        self.assertFalse(result[-1])

    def test_current_reference_wins_over_prior_product(self):
        other = "d" * 32
        with server.database() as db:
            db.execute("INSERT INTO assets VALUES(?,1,'新商品.png','image/png',?,0)", (other, len(self.image)))
            self.prior(db, "请规划商品主图", assets=[self.asset])
            result = self.start(db, "沿用风格，改为这款", assetIds=[other])
        self.assertEqual([row[1]["id"] for row in result[-1]], [other])

    def test_removed_prior_reference_does_not_break_followup(self):
        with server.database() as db:
            self.prior(db, "请规划商品主图", assets=[self.asset])
            db.execute("DELETE FROM assets WHERE id=?", (self.asset,))
            result = self.start(db, "继续讨论")
        self.assertEqual(result[-2], "studio")
        self.assertFalse(result[-1])

    def test_unknown_or_duplicate_reference_is_rejected_before_chat_reservation(self):
        for references in ([self.asset, self.asset], ["e" * 32]):
            with self.subTest(references=references), server.database() as db:
                with self.assertRaises(workspace.CommercialError):
                    self.start(db, "改图", assetIds=references)
                self.assertEqual(db.execute("SELECT count(*) FROM chat_turns").fetchone()[0], 0)

    def test_plans_cannot_reference_a_picture_not_supplied_to_the_agent(self):
        content = json.dumps({"reply": "裁剪", "actions": [{"tool": "resize_image",
            "arguments": {"sourceId": "e" * 32, "size": "64x64"}}]})
        with server.database() as db, self.assertRaises(workspace.CommercialError):
            agent.prepare(db, 1, content, [], image_tools.tool_definitions(), {}, None, store=self.store)

    def test_repeated_confirmation_executes_local_crop_once_and_survives_reopen(self):
        content = json.dumps({"reply": "裁剪", "actions": [{"tool": "resize_image",
            "arguments": {"sourceId": "image_1", "size": "64x64"}}]})
        with server.database() as db:
            asset = workspace.owned_asset(db, 1, self.asset)
            _, actions = agent.prepare(db, 1, content, [], image_tools.tool_definitions(), {"image_1": asset}, None, store=self.store)
            plan = self.prior(db, "裁剪图片", assets=[self.asset], actions=actions)
            first = agent.act(db, self.store, 1, self.conversation, plan["id"], "confirm")
            second = agent.act(db, self.store, 1, self.conversation, plan["id"], "confirm")
            self.assertEqual(first["plan"], second["plan"])
            self.assertEqual(db.execute("SELECT count(*) FROM assets").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT points FROM users WHERE id=1").fetchone()[0], 1000000)
        with server.database() as db:
            restored = agent.plan_status(db, 1, self.conversation, plan["id"])
            result_id = restored["plan"]["results"][0]["asset"]["id"]
        with Image.open(io.BytesIO(self.store.read(result_id))) as photo:
            self.assertEqual(photo.size, (64, 64))

    def test_cancelled_plan_does_not_execute(self):
        with server.database() as db:
            plan = self.prior(db, "裁剪图片", actions=[{"total": 0}])
            agent.act(db, self.store, 1, self.conversation, plan["id"], "cancel")
            with self.assertRaises(workspace.CommercialError):
                agent.act(db, self.store, 1, self.conversation, plan["id"], "confirm")
            self.assertEqual(db.execute("SELECT count(*) FROM assets").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
