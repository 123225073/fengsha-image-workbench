import json
import re
import unittest
from unittest.mock import patch

import commercial_memory as memory
import commercial_context as context
import commercial_provider as provider
import commercial_workspace as commercial
import workspace_server as server
import test_context_and_billing as fixtures
from test_context_and_billing import MODEL, BODY


class SemanticMemoryTests(unittest.TestCase):
    setUp = fixtures.BillingAndHistoryTests.setUp

    def history(self, count=70):
        return [{'question': ('受众=财务负责人；预算=1000；链接=https://github.com/Tencent/WeKnora；'
                              if i == 0 else f'补充第{i}轮；') + '背景资料。' * 140,
                 'reply': 'AI 未核实的建议。' * 100} for i in range(count)]

    def answer(self, model, messages, *, receipt, max_output, **kwargs):
        receipt.update(usage={'prompt_tokens': 10, 'completion_tokens': 5}, requestId='fixture')
        if messages[0]['content'] == memory.SUMMARY_SYSTEM:
            self.calls.append(json.loads(messages[-1]['content']))
            payload = self.calls[-1]
            old = json.loads(payload['previous_summary']) if payload['previous_summary'] else {k: [] for k in memory.FIELDS}
            old['goal'] = '比较知识库项目'
            for item in payload['older_dialogue']:
                if item['role'] == 'user':
                    old['decisions'] += re.findall(r'(?:受众|预算|链接)=[^；\s]+', item['text'])
            old['decisions'] = list(dict.fromkeys(old['decisions']))
            return json.dumps(old, ensure_ascii=False)
        self.final_messages = messages
        return '已按最新确认继续。'

    def run_task(self, history, request='a', label='PPT 需求沟通', session='session-a', **kwargs):
        return commercial.chat_task(server.database, 1, {**BODY, 'requestId': request}, '继续比较',
                                    '测试顾问', label, session_id=session, context_history=history, **kwargs)

    def test_semantic_summary_persists_reuses_and_keeps_recent_complete_turns(self):
        history = self.history()
        history[-1]['question'] = '更正：受众改为技术负责人，预算改为2000。'
        self.calls, events = [], []
        with patch.object(provider, 'chat', side_effect=self.answer) as upstream:
            first = self.run_task(history, on_memory=events.append)
            calls = len(self.calls)
            self.assertGreater(calls, 1)  # Older history is larger than one model window.
            self.assertIn('受众=财务负责人', self.final_messages[1]['content'])
            self.assertEqual(self.final_messages[-3:-1], context.history_messages(history[-1:]))
            self.assertEqual(self.final_messages[-5:-3], context.history_messages(history[-2:-1]))
            self.assertEqual(first[1]['charged'], (calls + 1) * 20)
            before = upstream.call_count
            duplicate = self.run_task(history)
            self.assertEqual(upstream.call_count, before)
            self.assertEqual(duplicate[0], first[0])
            # A new database connection and another workbench operation reuse the same summary.
            self.run_task(history, 'b', label='PPT 大纲')
            self.assertEqual(len(self.calls), calls)
        with server.database() as db:
            row = db.execute('SELECT * FROM conversation_memory').fetchone()
            self.assertEqual(json.loads(row['transcript']), context.history_messages(history))
            self.assertEqual(row['revision'], calls)
            self.assertEqual(db.execute('SELECT count(*) FROM conversation_memory').fetchone()[0], 1)
        self.assertEqual([e['state'] for e in events], ['compacting', 'updated'])

    def test_incremental_update_only_reads_new_older_fragments(self):
        history = self.history()
        self.calls = []
        with patch.object(provider, 'chat', side_effect=self.answer):
            self.run_task(history)
            before = len(self.calls)
            covered_turn = self.calls[-1]['older_dialogue'][-1]['turn']
            newer = self.history(100)[70:]
            newer[0]['question'] = '更正：受众=技术负责人；预算=2000；' + '补充' * 400
            self.run_task(history + newer, 'b')
        self.assertGreater(len(self.calls), before)
        self.assertTrue(all(u['turn'] > covered_turn for c in self.calls[before:] for u in c['older_dialogue']))
        self.assertIn('受众=技术负责人', self.final_messages[1]['content'])
        self.assertTrue(self.calls[before]['previous_summary'])

    def test_edited_prefix_and_new_sessions_never_reuse_old_summary(self):
        history = self.history()
        self.calls = []
        with patch.object(provider, 'chat', side_effect=self.answer):
            self.run_task(history)
            before = len(self.calls)
            self.run_task(history, 'b', session='other-project-session')
            self.assertEqual(self.calls[before]['previous_summary'], '')
            history[0]['question'] = '新目标：水果海报；' + '需求' * 300
            before = len(self.calls)
            self.run_task(history, 'c')
            self.assertEqual(self.calls[before]['previous_summary'], '')
            self.assertNotIn('WeKnora', str(self.final_messages))
        with server.database() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conversation_memory').fetchone()[0], 2)

    def test_smaller_model_triggers_compaction_large_model_keeps_original(self):
        history = self.history(15)
        self.calls = []
        with patch.object(provider, 'chat', side_effect=self.answer):
            with patch.object(provider, 'resolve', return_value={**MODEL, 'contextWindowTokens': 200000}):
                self.run_task(history)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.final_messages[1:-1], context.history_messages(history))
            with patch.object(provider, 'resolve', return_value={**MODEL, 'contextWindowTokens': 40000}):
                self.run_task(history, 'b')
        self.assertGreater(len(self.calls), 0)
        self.assertLessEqual(context.message_bytes(self.final_messages) + 4096, 40000 * .8)

    def test_failed_summary_keeps_checkpoint_and_original_and_charges_once(self):
        history = self.history()
        self.calls = []
        count = 0
        def broken(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                kwargs['receipt']['usage'] = {'input_tokens': 10, 'output_tokens': 5}
                return 'not valid JSON'
            return self.answer(*args, **kwargs)
        with patch.object(provider, 'chat', side_effect=broken):
            with self.assertRaises(provider.ProviderError) as failure:
                self.run_task(history)
        self.assertEqual(failure.exception.billing['charged'], 40)
        with server.database() as db:
            saved = dict(db.execute('SELECT * FROM conversation_memory').fetchone())
            self.assertEqual(saved['revision'], 1)
            self.assertEqual(json.loads(saved['transcript']), context.history_messages(history))
        with patch.object(provider, 'chat', side_effect=self.answer):
            self.run_task(history, 'retry')
        self.assertEqual(self.calls[1]['previous_summary'], saved['summary'])
        self.assertGreaterEqual(self.calls[1]['older_dialogue'][0]['turn'], self.calls[0]['older_dialogue'][-1]['turn'])
        self.assertNotEqual(self.calls[1]['older_dialogue'][0], self.calls[0]['older_dialogue'][-1])

    def test_uncertain_summary_does_not_retry_or_call_answer(self):
        with patch.object(provider, 'chat', side_effect=provider.ProviderError(502, 'timeout', True)) as upstream:
            with self.assertRaises(provider.ProviderError):
                self.run_task(self.history())
            with self.assertRaises(commercial.CommercialError):
                self.run_task(self.history())
        self.assertEqual(upstream.call_count, 1)
        with server.database() as db:
            row = db.execute('SELECT status,memory_calls FROM chat_turns').fetchone()
            self.assertEqual(row['status'], 'unknown')
            self.assertTrue(json.loads(row['memory_calls'])[0]['uncertain'])
            self.assertEqual(db.execute('SELECT revision FROM conversation_memory').fetchone()[0], 0)

    def test_concurrent_ppt_steps_share_one_memory_lock(self):
        with server.database() as db:
            scope = memory.scope_key(1, 'x', 'ppt', 'same-session')
            commercial.start_chat(db, 1, 'chat', {**BODY, 'text': '首轮'}, memory_scope=scope)
            db.execute("INSERT INTO conversations VALUES('outline',1,'大纲',0)")
            with self.assertRaises(commercial.CommercialError):
                commercial.start_chat(db, 1, 'outline', {**BODY, 'text': '继续'}, memory_scope=scope)

    def test_poster_discussion_and_plan_share_memory(self):
        self.calls = []
        history = self.history()
        with patch.object(provider, 'chat', side_effect=self.answer):
            self.run_task(history, label='海报需求沟通')
            calls = len(self.calls)
            self.run_task(history, 'b', label='海报设计方案')
            self.assertEqual(len(self.calls), calls)
            self.run_task(history, 'c', label='海报需求沟通', session='new-poster')
            self.assertGreater(len(self.calls), calls)

    def test_ai_chat_stream_uses_semantic_memory(self):
        self.calls = []
        history = self.history()
        handler = object.__new__(server.WorkspaceHandler)
        events = []
        handler.begin_stream = lambda: None
        handler.stream_event = events.append
        handler.wallet_data = lambda db, owner: {}
        with server.database() as db:
            for i, item in enumerate(history):
                db.execute("INSERT INTO chat_turns(conversation,request_id,user_text,reply,model_name,price,status,created) VALUES('chat',?,?,?,'fixture',0,'succeeded',0)",
                           (str(i), item['question'], item['reply']))
        with server.database() as db, patch.object(provider, 'chat', side_effect=self.answer):
            handler.stream_chat(db, 1, 'chat', {**BODY, 'text': '继续'})
        self.assertGreater(len(self.calls), 0)
        self.assertTrue(any(e.get('type') == 'memory' and e.get('state') == 'updated' for e in events))
        self.assertEqual(events[-1]['billing']['status'], 'succeeded')

    def test_summary_and_search_usage_all_settle_together(self):
        from commercial_research import Research, PLANNER_SYSTEM
        self.calls = []
        def chat(model, messages, **kwargs):
            if messages[0]['content'] == PLANNER_SYSTEM:
                kwargs['receipt']['usage'] = {'prompt_tokens': 10, 'completion_tokens': 5}
                return '{"queries":["WeKnora"]}'
            return self.answer(model, messages, **kwargs)
        with patch.object(provider, 'chat', side_effect=chat), patch.object(Research, '__call__', return_value={'status': 'empty', 'sources': [], 'query': 'WeKnora'}):
            result = self.run_task(self.history(), research=Research('WeKnora', '继续比较', []))
        self.assertEqual(result[1]['charged'], (len(self.calls) + 2) * 20)

    def test_model_window_configuration_and_legacy_default(self):
        with server.database() as db:
            db.execute("INSERT INTO cpa_connections VALUES('connection','fixture','https://example.invalid/v1',X'00',1,0,0,0)")
            value = {'connectionId': 'connection', 'modelId': 'fixture', 'name': 'fixture', 'kind': 'chat',
                     'capabilities': ['text'], 'tokenRates': MODEL['tokenRates'], 'enabled': True}
            old = provider._save_model(db, value, 'test')['model']
            self.assertEqual(old['contextWindowSource'], 'default')
            self.assertEqual(old['contextWindowTokens'], 65536)
            row = db.execute('SELECT * FROM cpa_models WHERE id=?', (old['id'],)).fetchone()
            configured = provider._save_model(db, {'contextWindowTokens': 200000}, 'test', row)['model']
            self.assertEqual(configured['contextWindowSource'], 'configured')
            self.assertEqual(provider.catalog(db)['models'][0]['contextWindowTokens'], 200000)
            self.assertEqual(configured['tokenRates'], old['tokenRates'])
            with self.assertRaises(provider.ProviderError):
                provider._save_model(db, {'contextWindowTokens': True}, 'test', row)

    def test_missing_summary_usage_cannot_be_hidden_by_later_calls(self):
        self.calls = []
        def reply(*args, **kwargs):
            answer = self.answer(*args, **kwargs)
            if len(self.calls) == 1:
                kwargs['receipt'].pop('usage', None)
            return answer
        with patch.object(provider, 'chat', side_effect=reply):
            result = self.run_task(self.history())
        self.assertEqual(result[1]['status'], 'unknown')
        self.assertIsNone(result[1]['usage'])

    def test_user_isolation_even_with_same_frontend_session_id(self):
        self.calls = []
        with patch.object(provider, 'chat', side_effect=self.answer):
            self.run_task(self.history())
        with server.database() as db:
            db.execute("INSERT INTO users(id,email,name,password,role,points,created) VALUES(2,'other@example.invalid','other','unused','user',1000000000,0)")
            db.execute("INSERT INTO conversations VALUES('other',2,'新对话',0)")
            self.assertNotEqual(memory.scope_key(1, 'other', 'ppt', 'session-a'), memory.scope_key(2, 'other', 'ppt', 'session-a'))
            _, messages, _ = commercial.start_chat(db, 2, 'other', {**BODY, 'text': '你好'})
        self.assertNotIn('WeKnora', str(messages))

    def test_poster_plan_accepts_existing_dialogue_without_reasking_user(self):
        with server.database() as db:
            prompt = commercial.poster_advisor_message(db, 1, {'message': '', 'history': [{'question': '技术交流活动海报', 'reply': '已确认'}]}, references=[])
            self.assertIn('本轮需求', prompt)
            with self.assertRaises(commercial.CommercialError):
                commercial.poster_advisor_message(db, 1, {'history': []}, references=[])

    def test_poster_plan_keeps_visual_copy_and_removes_research_notes(self):
        reply = json.dumps({
            'prompt': '采用浅暖灰厨房风格。联网资料中，报道[3]提及纯米 TOKIT 电饭煲容量为 1.6L，'
                      '但未核实具体型号；该信息仅作选品线索。正式制作前需确认具体型号。'
                      '用侧光突出商品。标题写“限时开售！”，右下方写“¥199.99”，保留原包装标识。'
                      '\n参考链接：https://example.com/report',
            'title': '旧版活动字段', 'formats': ['main', 'wide', 'main', 'unsupported'],
        }, ensure_ascii=False)
        self.assertEqual(commercial.poster_advisor_result(reply), {
            'prompt': '采用浅暖灰厨房风格。用侧光突出商品。标题写“限时开售！”，右下方写“¥199.99”，保留原包装标识。',
            'formats': ['main', 'wide'], 'promptVersion': 2,
        })
        with self.assertRaises(commercial.CommercialError):
            commercial.poster_advisor_result('{"prompt":"联网资料中，报道[3]提及 1.6L。","formats":[]}')

    def test_ai_image_agent_also_uses_summary_before_planning(self):
        self.calls = []
        handler = object.__new__(server.WorkspaceHandler)
        events = []
        handler.begin_stream = lambda: None
        handler.stream_event = events.append
        handler.wallet_data = lambda db, owner: {}
        handler.server = type('TestServer', (), {'assets': None})()
        with server.database() as db:
            for i, item in enumerate(self.history()):
                db.execute("INSERT INTO chat_turns(conversation,request_id,user_text,reply,model_name,price,status,created) VALUES('chat',?,?,?,'fixture',0,'succeeded',0)",
                           (str(i), item['question'], item['reply']))
        planned = []
        def plan(model, messages, *args, receipt, **kwargs):
            planned.extend(messages)
            receipt['usage'] = {'input_tokens': 10, 'output_tokens': 5}
            return '已理解此前信息。', []
        with server.database() as db, patch.object(provider, 'chat', side_effect=self.answer), patch.object(provider, 'plan_chat', side_effect=plan):
            handler.stream_chat(db, 1, 'chat', {**BODY, 'text': '继续', 'agent': True})
        self.assertGreater(len(self.calls), 0)
        self.assertIn('摘要记忆', str(planned))
        self.assertEqual(events[-1]['billing']['status'], 'succeeded')


if __name__ == '__main__':
    unittest.main()
