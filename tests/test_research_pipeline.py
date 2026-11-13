import json
import unittest
from unittest.mock import patch

import commercial_provider as provider
import commercial_research as research
import commercial_web_search as web
from test_research_context import BRIEF, LINKS, FOLLOWUP


class PipelineTests(unittest.TestCase):
    def plan(self):
        return research.build_plan(BRIEF, FOLLOWUP, [LINKS])

    def test_initial_acronym_comparison_splits_targets(self):
        plan = research.build_plan('介绍 RAG 和 SAG2 的区别以及 SAG Wiki 知识库')
        self.assertEqual([item['name'] for item in plan['targets']], ['RAG', 'SAG2', 'SAG Wiki'])

    def test_audience_followup_does_not_replace_the_brief(self):
        plan = research.build_plan('小米 SU7 Ultra 官方参数', '主要给老板讲，技术细节可以少一点')
        self.assertIn('SU7', plan['query'])
        self.assertNotIn('老板', plan['query'])

    def test_model_planner_cannot_drop_subject_or_change_version(self):
        plan = self.plan()
        planned = research._parse_plan(json.dumps({'queries': ['WeKnora features', 'SAG-Wiki v9.0.0']}), plan)
        self.assertIn('SAG-Wiki v0.2.7', planned['queries'])
        self.assertFalse(any('9.0.0' in q for q in planned['queries']))

    def test_malformed_planner_uses_deterministic_fallback(self):
        plan = self.plan()
        for output in ('not json', '[]', '{"queries":["主要的意思"]}', '{"queries":[null]}'):
            self.assertEqual(research._parse_plan(output, plan), plan)

    def test_specified_links_read_even_when_search_is_down(self):
        def read(source, query):
            return [{**source, 'pageExcerpt': '官方原文 ' * 30, 'readStatus': 'read'}]
        with patch.object(research, 'read_source', side_effect=read), patch.object(web, '_search_results', return_value=None):
            result = research.execute(self.plan())
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['missingTargets'], [])
        self.assertEqual(len(result['sources']), 2)

    def test_second_engine_only_for_uncovered_subject(self):
        def search(query, *, market=''):
            if market == 'zh-fallback':
                return [{'title': 'SAG-Wiki v0.2.7 官方文档', 'url': 'https://sag.example/docs/v0.2.7', 'snippet': 'SAG-Wiki v0.2.7 使用方法'}]
            return [{'title': 'WeKnora 官方文档', 'url': 'https://weknora.example/docs', 'snippet': 'WeKnora 使用方法'},
                    {'title': '主要是什么意思', 'url': 'https://www.iciba.com/word', 'snippet': '主要的意思'}]
        with patch.object(web, '_search_results', side_effect=search) as lookup, patch.object(research, 'read_source', side_effect=lambda s,q: [{**s, 'readStatus': 'unread'}]):
            result = research.execute(self.plan())
        fallback = [call for call in lookup.call_args_list if call.kwargs.get('market') == 'zh-fallback']
        self.assertEqual(len(fallback), 1)
        self.assertIn('SAG-Wiki', fallback[0].args[0])
        self.assertFalse(any('iciba' in source['url'] for source in result['sources']))
        self.assertEqual(result['missingTargets'], [])

    def test_total_failure_is_not_success(self):
        with patch.object(web, '_search_results', return_value=None), patch.object(research, 'read_source', side_effect=lambda s,q: [{**s, 'readStatus': 'unread'}]):
            result = research.execute(self.plan())
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['missingTargets'], ['WeKnora', 'SAG-Wiki'])

    def test_source_budget_keeps_both_comparison_objects(self):
        sources = [{'title': name, 'url': f'https://example.com/{name}', 'pageExcerpt': '正文' * 15000} for name in ('first', 'second')]
        result = web.bounded_evidence({'query': 'comparison', 'status': 'ok', 'sources': sources})
        self.assertEqual(len(result['sources']), 2)
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), web.MAX_CONTEXT_BYTES)

    def test_private_or_credential_links_never_become_fetch_targets(self):
        self.assertEqual(research.links_in('https://127.0.0.1/ https://10.1.1.1/ https://user:pass@example.com/'), [])
        with self.assertRaises(ValueError):
            research._fetch('https://127.0.0.1/private')

    def test_page_parser_prioritizes_article_not_navigation(self):
        page = web.PageText()
        page.feed('<header>Noise</header><main><article>Original project evidence<script>evil()</script></article></main>')
        self.assertEqual(page.main_lines, ['Original project evidence'])


if __name__ == '__main__':
    unittest.main()
