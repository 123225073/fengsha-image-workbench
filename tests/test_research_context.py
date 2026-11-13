import json
import unittest
from unittest.mock import patch

import commercial_web_search as web


BRIEF = '介绍 RAG 和 SAG2 的区别、优缺点和使用场景'
LINKS = '项目是 https://github.com/Tencent/WeKnora 和 https://github.com/Zleap-AI/SAG-Wiki/releases/tag/v0.2.7'
FOLLOWUP = '主要是这两个项目的一个对比分析'


class ResearchRegressionTests(unittest.TestCase):
    def test_followup_keeps_projects(self):
        query = web.ppt_search_query(BRIEF, FOLLOWUP, [LINKS])
        self.assertIn('WeKnora', query)
        self.assertIn('SAG-Wiki', query)
        self.assertNotIn('主要', query)

    def test_chat_followup_keeps_early_links(self):
        query = web.conversation_query(FOLLOWUP, [BRIEF, LINKS] + ['详细一点'] * 20)
        self.assertIn('WeKnora', query)
        self.assertIn('SAG-Wiki', query)

    def test_dictionary_is_not_project_evidence(self):
        query = web.ppt_search_query(BRIEF, FOLLOWUP, [LINKS])
        unrelated = {'title': '主要是什么意思', 'url': 'https://www.iciba.com/word?w=主要', 'snippet': '主要的意思'}
        self.assertEqual(web.relevant_ppt_sources(query, [unrelated]), [])

    def test_topic_switch_does_not_reuse_previous_projects(self):
        query = web.ppt_search_query(BRIEF, '换个主题：小米 SU7 Ultra 参数', [LINKS])
        self.assertIn('SU7', query)
        self.assertNotIn('SAG', query)


if __name__ == '__main__':
    unittest.main()
