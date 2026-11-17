import http.client
import io
import unittest
from unittest.mock import patch
from tools.native_webdriver import request


class TransportTests(unittest.TestCase):
    def test_safe_queries_and_absolute_geometry_recover(self):
        for method,path,explicit in [
            ('GET','/session/test/screenshot',False),
            ('POST','/session/test/window/rect',False),
            ('POST','/session/test/window',False),
            ('POST','/session/test/element',False),
            ('POST','/session/test/execute/sync',True),
        ]:
            with self.subTest(path=path), patch('urllib.request.urlopen',side_effect=[http.client.RemoteDisconnected(),io.BytesIO(b'{"value":42}')]) as send, patch('time.sleep'):
                self.assertEqual(request('http://localhost',method,path,{},idempotent=explicit),42)
                self.assertEqual(send.call_count,2)

    def test_input_clicks_mutating_scripts_and_session_creation_are_never_replayed(self):
        for path in ['/session','/session/test/actions','/session/test/element/id/click','/session/test/element/id/value','/session/test/execute/sync']:
            with self.subTest(path=path), patch('urllib.request.urlopen',side_effect=http.client.RemoteDisconnected()) as send:
                with self.assertRaises(http.client.RemoteDisconnected):request('http://localhost','POST',path,{})
                self.assertEqual(send.call_count,1)

    def test_recovery_is_bounded(self):
        with patch('urllib.request.urlopen',side_effect=http.client.RemoteDisconnected()) as send, patch('time.sleep'):
            with self.assertRaises(http.client.RemoteDisconnected):request('http://localhost','GET','/status')
            self.assertEqual(send.call_count,3)

    def test_semantic_driver_errors_are_not_retried(self):
        with patch('urllib.request.urlopen',return_value=io.BytesIO(b'{"value":{"error":"invalid session id"}}')) as send:
            with self.assertRaisesRegex(RuntimeError,'invalid session id'):request('http://localhost','GET','/status')
            self.assertEqual(send.call_count,1)

    def test_driver_exit_stops_recovery_before_contacting_another_process(self):
        with patch('urllib.request.urlopen',side_effect=http.client.RemoteDisconnected()) as send, patch('time.sleep'):
            with self.assertRaisesRegex(RuntimeError,'Owned test driver exited'):
                request('http://localhost','GET','/status',alive=iter([True,False]).__next__)
            self.assertEqual(send.call_count,1)
