import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
import server

PARENT = 'accounts/1/locations/2'
RID = PARENT + '/reviews/3'


def review(comment='Spotless car, friendly team.', rating='FIVE', reply=None, age_days=0):
    stamp = datetime.fromtimestamp(time.time() - age_days * 86400, timezone.utc).isoformat()
    data = {'reviewId': '3', 'name': RID, 'reviewer': {'displayName': 'Sarah'},
            'comment': comment, 'starRating': rating, 'createTime': stamp, 'updateTime': stamp}
    if reply:
        data['reviewReply'] = {'comment': reply, 'updateTime': stamp}
    return data


class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db, self.old_secret = server.DB, server.SECRET_FILE
        server.DB = Path(self.tmp.name) / 'test.sqlite'
        server.SECRET_FILE = Path(self.tmp.name) / 'secrets.json'
        server.OAUTH.clear()
        server.init()

    def tearDown(self):
        server.DB, server.SECRET_FILE = self.old_db, self.old_secret
        server.OAUTH.clear()
        self.tmp.cleanup()

    def insert(self, raw=None):
        with server.conn() as c:
            server.ingest(c, raw or review(), PARENT)
        return server.get_review(RID)

    def test_settings_and_consent(self):
        self.assertEqual(server.settings()['threshold'], 4)
        with self.assertRaisesRegex(ValueError, 'Confirm'):
            server.save_settings({'auto_mode': 'publish'})
        server.save_settings({'business': 'My wash', 'threshold': 5})
        self.assertEqual(server.settings()['business'], 'My wash')
        with self.assertRaisesRegex(ValueError, 'Business hours'):
            server.save_settings({'start': '18:00', 'end': '09:00'})

    def test_oauth_state_and_secret(self):
        with patch.dict(server.os.environ, {'GOOGLE_CLIENT_ID': 'client', 'GOOGLE_CLIENT_SECRET': 'secret'}):
            url = server.oauth_start()
            self.assertIn('code_challenge=', url)
            self.assertIn('business.manage', url)
            with self.assertRaisesRegex(ValueError, 'expired'):
                server.oauth_finish({'state': ['invalid'], 'code': ['abc']})
            state = server.OAUTH['state']
            with patch.object(server, 'request', return_value={'refresh_token': 'fresh', 'access_token': 'short'}):
                server.oauth_finish({'state': [state], 'code': ['abc']})
            self.assertEqual(server.local_secrets()['refresh_token'], 'fresh')
            self.assertNotIn('fresh', json.dumps(server.state()))

    def test_disconnect_revokes_local_token_and_stops_automation(self):
        server.save_local_secrets({'refresh_token': 'test-refresh-token'})
        s = server.settings()
        s.update(auto_mode='publish', publish_consent=True)
        with server.conn() as c:
            c.execute('UPDATE settings SET data=? WHERE id=1', (json.dumps(s),))
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
        with patch.object(server.urllib.request, 'urlopen', return_value=Response()) as call:
            server.disconnect_google()
            self.assertIn(b'test-refresh-token', call.call_args.args[0].data)
        self.assertFalse(server.SECRET_FILE.exists())
        self.assertEqual(server.settings()['auto_mode'], 'off')

    def test_discover_locations_and_toggle(self):
        def remote(url, **_):
            if 'accountmanagement' in url:
                return {'accounts': [{'name': 'accounts/1'}]}
            return {'locations': [{'name': 'locations/2', 'title': 'City Centre'}]}
        with patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', side_effect=remote):
            self.assertEqual(server.discover(), 1)
        self.assertEqual(server.location_names(), [PARENT])
        server.action('location', {'name': PARENT, 'enabled': False})
        self.assertEqual(server.location_names(), [])

    def test_sync_keeps_draft_and_invalidates_changed_approval(self):
        original = review()
        self.insert(original)
        server.save_draft(RID, 'Thank you for visiting.', 'approve')
        with patch.dict(server.os.environ, {'GOOGLE_LOCATION': PARENT}), patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', return_value={'reviews': [original]}):
            server.sync()
        self.assertEqual(server.get_review(RID)['status'], 'approved')
        changed = review('A different comment that needs checking.')
        changed['updateTime'] = datetime.now(timezone.utc).isoformat()
        with patch.dict(server.os.environ, {'GOOGLE_LOCATION': PARENT}), patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', return_value={'reviews': [changed]}):
            server.sync()
        self.assertEqual(server.get_review(RID)['status'], 'draft')
        self.assertIn('changed', server.get_review(RID)['flag'])

    def test_external_reply_is_reconciled(self):
        self.insert()
        with server.conn() as c:
            server.ingest(c, review(reply='Posted elsewhere'), PARENT)
        self.assertEqual(server.get_review(RID)['draft'], 'Posted elsewhere')
        self.assertEqual(server.get_review(RID)['status'], 'published')

    def test_old_google_reviews_are_not_cached(self):
        with patch.dict(server.os.environ, {'GOOGLE_LOCATION': PARENT}), patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', return_value={'reviews': [review(age_days=31)]}):
            server.sync()
        with self.assertRaisesRegex(ValueError, 'not found'):
            server.get_review(RID)
        self.insert()
        with server.conn() as c:
            c.execute('UPDATE reviews SET first_seen=? WHERE id=?', (time.time() - 31 * 86400, RID))
        server.purge()
        with self.assertRaisesRegex(ValueError, 'not found'):
            server.get_review(RID)

    def test_structured_ai_reply_and_risk_flag(self):
        row = self.insert(review('Excellent service but my door was damaged.'))
        result = {'status': 'completed', 'output': [{'content': [{'type': 'output_text', 'text': json.dumps({'reply': 'We are sorry to hear about the damage.', 'needs_review': False, 'reason': '', 'theme': 'service'})}]}]}
        with patch.dict(server.os.environ, {'OPENAI_API_KEY': 'test'}), patch.object(server, 'request', return_value=result) as req:
            drafted = server.generate(row)
            self.assertIn('complaint', drafted['flag'].lower())
            self.assertFalse(req.call_args.args[1]['store'])
            self.assertEqual(req.call_args.args[1]['text']['format']['type'], 'json_schema')

    def test_sample_flow_never_publishes(self):
        server.action('sample', {})
        server.action('approve', {'id': 'demo-1', 'draft': 'Thank you Sarah.'})
        with self.assertRaisesRegex(ValueError, 'Sample'):
            server.publish(server.get_review('demo-1'))
        server.action('simulate', {'id': 'demo-1'})
        self.assertEqual(server.get_review('demo-1')['status'], 'sample-replied')
        self.assertEqual(server.analytics(server.state()['reviews'])['total'], 0)

    def test_owner_example_does_not_copy_review_text(self):
        self.insert()
        server.action('approve', {'id': RID, 'draft': 'Many thanks for your feedback.'})
        examples = server.state()['examples']
        self.assertEqual(examples[0]['reply'], 'Many thanks for your feedback.')
        self.assertEqual(examples[0]['original'], '')
        self.assertNotIn('Spotless car', json.dumps(examples))

    def test_publish_rechecks_existing_reply_and_edit(self):
        row = self.insert()
        row = server.save_draft(RID, 'Thank you.', 'approve')
        with patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', return_value={'reviewReply': {'comment': 'Already replied'}}):
            with self.assertRaisesRegex(ValueError, 'already'):
                server.publish(row)
        with patch.object(server, 'google_token', return_value='token'), patch.object(server, 'request', return_value={'updateTime': 'changed', 'comment': row['text']}):
            with self.assertRaisesRegex(ValueError, 'changed'):
                server.publish(row)
        with self.assertRaisesRegex(ValueError, 'Save and approve'):
            server.action('publish', {'id': RID, 'draft': 'Edited without approval'})

    def test_automation_skips_backlog_and_honours_risk(self):
        row = self.insert()
        s = server.settings()
        s.update(auto_mode='draft', auto_since=time.time() + 1, delay_minutes=0)
        with server.conn() as c:
            c.execute('UPDATE settings SET data=? WHERE id=1', (json.dumps(s),))
        with patch.object(server, 'sync'), patch.object(server, 'generate') as generate:
            server.automation_tick(time.time() + 90)
            generate.assert_not_called()
        s['auto_since'] = time.time() - 1
        with server.conn() as c:
            c.execute('UPDATE settings SET data=? WHERE id=1', (json.dumps(s),))
        with patch.object(server, 'sync'), patch.object(server, 'generate', return_value={'reply': 'Thank you for the lovely review.', 'flag': '', 'theme': 'service'}):
            server.automation_tick(time.time() + 90)
        self.assertEqual(server.get_review(RID)['status'], 'draft')

    def test_publish_hours_and_daily_limit(self):
        s = server.settings()
        self.assertTrue(server.within_hours(s, datetime(2026, 10, 2, 10, 0, tzinfo=server.ZoneInfo('Europe/Dublin')).timestamp()))
        self.assertFalse(server.within_hours(s, datetime(2026, 10, 2, 20, 0, tzinfo=server.ZoneInfo('Europe/Dublin')).timestamp()))
        server.audit('auto-published', RID)
        self.assertEqual(server.today_count(s), 1)

    def test_auto_publish_requires_unflagged_draft_and_cap(self):
        self.insert()
        s = server.settings()
        s.update(auto_mode='publish', publish_consent=True, auto_since=time.time() - 1,
                 delay_minutes=0, limit=1)
        with server.conn() as c:
            c.execute('UPDATE settings SET data=? WHERE id=1', (json.dumps(s),))
        with patch.object(server, 'sync'), patch.object(server, 'within_hours', return_value=True), patch.object(server, 'today_count', return_value=0), patch.object(server, 'generate', return_value={'reply': 'Many thanks for your visit.', 'flag': '', 'theme': 'service'}), patch.object(server, 'publish') as publish:
            server.automation_tick(time.time() + 60)
            publish.assert_called_once()
            self.assertTrue(publish.call_args.kwargs['automatic'])
        with server.conn() as c:
            c.execute('UPDATE reviews SET status="new" WHERE id=?', (RID,))
        with patch.object(server, 'sync'), patch.object(server, 'within_hours', return_value=True), patch.object(server, 'today_count', return_value=1), patch.object(server, 'generate') as generate:
            server.automation_tick(time.time() + 60)
            generate.assert_not_called()

    def test_reply_guard_holds_contact_details_and_avoided_words(self):
        s = server.settings()
        s['words_avoid'] = 'amazing, perfect'
        self.assertIn('contact', server.reply_guard('Email me at me@example.com', s))
        self.assertIn('avoid', server.reply_guard('That is perfect!', s))

    def test_insights_include_complaints_and_known_staff(self):
        server.save_settings({'staff_names': 'John, Mary'})
        self.insert(review('John removed a stain. Spotless clean.'))
        data = server.analytics(server.state()['reviews'])
        self.assertIn(('John', 1), data['staff'])
        self.assertIn(('cleanliness', 1), data['compliments'])

    def test_http_sample_workflow_and_origin_check(self):
        try:
            httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        except PermissionError:
            self.skipTest('this environment blocks loopback sockets')
        old_port = server.PORT
        server.PORT = httpd.server_port
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.PORT}'
        def post(path, data, origin=None):
            headers = {'Content-Type': 'application/json'}
            if origin:
                headers['Origin'] = origin
            req = urllib.request.Request(base + path, json.dumps(data).encode(), headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=3) as response:
                return json.load(response)
        try:
            post('/api/sample', {})
            post('/api/save', {'id': 'demo-2', 'draft': 'Thank you.'})
            post('/api/approve', {'id': 'demo-2', 'draft': 'Thank you.'})
            post('/api/simulate', {'id': 'demo-2'})
            with urllib.request.urlopen(base + '/api/state', timeout=3) as response:
                data = json.load(response)
            self.assertEqual(next(x['status'] for x in data['reviews'] if x['id'] == 'demo-2'), 'sample-replied')
            with self.assertRaises(urllib.error.HTTPError) as error:
                post('/api/sample', {}, 'https://elsewhere.example')
            self.assertEqual(error.exception.code, 400)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.PORT = old_port


if __name__ == '__main__':
    unittest.main()
