import json
import unittest
from unittest.mock import patch

import commercial_projects as projects
import commercial_provider as provider
import commercial_workspace as commercial
import workspace_server as server
import test_context_and_billing as fixtures


class PosterHistoryTests(unittest.TestCase):
    setUp = fixtures.BillingAndHistoryTests.setUp

    def submit(self, db, request='one', copy=None):
        model = {'id': 'fixture', 'name': 'fixture', 'model': 'fixture', 'price': 0,
                 'maxReferences': 0, 'capabilities': ['generate']}
        with patch.object(provider, 'resolve', return_value=model):
            return commercial.submit_jobs(db, 1, {'requests': [{
                'requestId': request, 'scope': 'poster', 'prompt': 'A landscape illustration',
                'label': 'poster fixture', 'size': '100x100', 'unitPrice': 0,
                'context': {'documentId': 'project-a', 'formatId': 'main', 'posterCopy': copy or {
                    'title': '第一版', 'subtitle': '', 'date': '', 'logoId': '', 'qrId': ''}}}]})['jobs'][0]

    def test_generated_manual_poster_keeps_its_original_copy(self):
        with server.database() as db:
            first = self.submit(db)
            db.execute("UPDATE generation_jobs SET status='succeeded' WHERE id=?", (first['id'],))
            second = self.submit(db, 'two', {'title': '第二版', 'subtitle': '', 'date': '', 'logoId': '', 'qrId': ''})
            self.assertEqual(first['context']['posterCopy']['title'], '第一版')
            self.assertEqual(second['context']['posterCopy']['title'], '第二版')

    def test_copy_cannot_reference_another_users_asset(self):
        with server.database() as db:
            with self.assertRaises(commercial.CommercialError):
                self.submit(db, copy={'logoId': 'f' * 32})
            self.assertEqual(db.execute('SELECT count(*) FROM generation_jobs').fetchone()[0], 0)

    def test_project_roundtrip_preserves_all_dialogues_and_document_identity(self):
        poster = {'documentId': 'a' * 32, 'discussion': [{'question': '当前', 'reply': '回答'}],
                  'advisorSessionId': 'current', 'visuals': {'main': 'b' * 32},
                  'advisorHistory': [{'sessionId': str(i), 'discussion': [{'question': str(i), 'reply': '已保存'}],
                                      'proposal': {'prompt': str(i)}} for i in range(11)]}
        with server.database() as db:
            closed = projects.switch_poster(db, 1, {'poster': poster, 'uploads': {}}, '')
            saved = projects.poster_history(db, 1)[0]['id']
            reopened = projects.switch_poster(db, 1, closed, saved)['poster']
        self.assertEqual(reopened['documentId'], poster['documentId'])
        self.assertEqual(reopened['advisorHistory'], poster['advisorHistory'])
        self.assertEqual(reopened['visuals'], poster['visuals'])

    def test_current_project_results_survive_global_job_list_limit(self):
        with server.database() as db:
            first = self.submit(db)
            db.execute("UPDATE generation_jobs SET status='succeeded' WHERE id=?", (first['id'],))
            db.execute('UPDATE users SET workspace=? WHERE id=1', (json.dumps({'poster': {'documentId': 'project-a'}}),))
            row = db.execute('SELECT * FROM generation_jobs WHERE id=?', (first['id'],)).fetchone()
            columns = list(row.keys())
            for i in range(205):
                data = dict(row)
                payload = json.loads(row['payload'])
                payload['context']['documentId'] = 'other-project'
                data.update(id=f'{i:032x}', request_id=str(i), payload=json.dumps(payload))
                db.execute(f"INSERT INTO generation_jobs({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", tuple(data[k] for k in columns))
            handler = object.__new__(server.WorkspaceHandler)
            self.assertIn(first['id'], [job['id'] for job in handler.jobs_snapshot(db, 1, True)])
            self.assertEqual(handler.jobs_snapshot(db, 2, True), [])


if __name__ == '__main__':
    unittest.main()
