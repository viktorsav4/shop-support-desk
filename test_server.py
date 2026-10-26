import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class DeskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_db = server.DB
        server.DB = Path(cls.temp.name) / 'test.sqlite3'
        cls.env = patch.dict(os.environ, {'SUPPORT_MODE': 'demo'})
        cls.env.start()
        cls.http = server.make_server(0)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.env.stop()
        server.DB = cls.old_db
        cls.temp.cleanup()

    def call(self, path, data=None, headers=None):
        h = {'Content-Type': 'application/json'}
        h.update(headers or {})
        request = Request(self.base + path, data=None if data is None else json.dumps(data).encode(), headers=h)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def create(self, message='Где мой заказ?'):
        status, data = self.call('/api/tickets', {'subject': 'Пример', 'message': message})
        self.assertEqual(status, 201)
        return data['id']

    def test_full_lifecycle_and_persistence(self):
        ticket = self.create()
        prefix = f'/api/tickets/{ticket}'
        self.assertEqual(self.call(prefix + '/approve', {'draft': 'Рано'})[0], 400)
        status, result = self.call(prefix + '/analyze', {})
        self.assertEqual(status, 200)
        self.assertEqual(result['category'], 'delivery')
        self.assertEqual(result['engine'], 'demo')
        self.assertEqual(self.call(prefix + '/draft', {'draft': 'Уточним заказ.', 'category': 'delivery'})[0], 200)
        self.assertEqual(self.call(prefix + '/approve', {'draft': 'Ответ проверен.', 'category': 'delivery'})[0], 200)
        with server.connect() as c:
            stored = c.execute('SELECT * FROM tickets WHERE id=?', (ticket,)).fetchone()
            self.assertEqual(stored['status'], 'approved')
            self.assertEqual(stored['draft'], 'Ответ проверен.')
            self.assertTrue(stored['reviewed_at'])
        self.assertEqual(self.call(prefix + '/analyze', {})[0], 400)
        self.assertEqual(self.call(prefix + '/draft', {'draft': 'Правка'})[0], 400)
        events = self.call(prefix + '/events')[1]['events']
        self.assertEqual([e['action'] for e in events], ['created', 'analyzed_demo', 'edited', 'approved'])

    def test_input_validation(self):
        for data in ({}, {'subject': ' ', 'message': 'test'}, {'subject': 'x', 'message': 'x' * 5001}, ['invalid']):
            self.assertEqual(self.call('/api/tickets', data)[0], 400)
        self.assertEqual(self.call('/api/tickets/999999/analyze', {})[0], 404)
        self.assertEqual(self.call('/api/tickets', {'subject': 'x', 'message': 'x'}, {'Content-Type': 'text/plain'})[0], 415)

    def test_cross_origin_write_rejected(self):
        self.assertEqual(self.call('/api/seed', {}, {'Origin': 'https://example.org'})[0], 403)
        self.assertEqual(self.call('/api/seed', {}, {'Host': 'example.org'})[0], 403)

    def test_demo_seed_idempotent(self):
        self.call('/api/seed', {})
        count = len(self.call('/api/tickets')[1]['tickets'])
        self.call('/api/seed', {})
        self.assertEqual(len(self.call('/api/tickets')[1]['tickets']), count)

    def test_demo_categories_and_return_precedence(self):
        cases = [('Хочу вернуть доставленный товар', 'return'), ('Курьер опаздывает', 'delivery'),
                 ('Какой объём термоса?', 'product'), ('Не приходит письмо для входа', 'other')]
        for message, expected in cases:
            result = server.demo_analysis('', message)
            self.assertEqual(result['category'], expected)
            self.assertTrue(result['draft'])

    def test_llm_failure_preserves_ticket(self):
        ticket = self.create()
        with patch.dict(os.environ, {'SUPPORT_MODE': 'llm', 'LLM_CHAT_URL': 'https://provider.example/chat', 'LLM_API_KEY': 'test-only', 'LLM_MODEL': 'test-model'}):
            with patch('server.urlopen', side_effect=TimeoutError):
                self.assertEqual(self.call(f'/api/tickets/{ticket}/analyze', {})[0], 502)
        stored = next(t for t in self.call('/api/tickets')[1]['tickets'] if t['id'] == ticket)
        self.assertEqual(stored['status'], 'new')
        self.assertEqual(stored['draft'], '')

    def test_llm_contract_with_mock_provider(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, *_):
                return json.dumps({'choices': [{'message': {'content': json.dumps({'category': 'return', 'draft': 'Уточним условия возврата.', 'reason': 'Запрос возврата'})}}]}).encode()
        with patch.dict(os.environ, {'SUPPORT_MODE': 'llm', 'LLM_CHAT_URL': 'https://provider.example/chat', 'LLM_API_KEY': 'test-only', 'LLM_MODEL': 'test-model'}):
            with patch('server.urlopen', return_value=Response()) as mock:
                result = server.analyze('Возврат', 'Хочу вернуть товар')
                self.assertEqual(result['engine'], 'llm')
                self.assertEqual(result['category'], 'return')
                payload = json.loads(mock.call_args.args[0].data)
                self.assertEqual(payload['messages'][0]['role'], 'system')
                self.assertEqual(json.loads(payload['messages'][1]['content'])['message'], 'Хочу вернуть товар')


if __name__ == '__main__':
    unittest.main(verbosity=2)
