import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
import bridge


class Bridge(unittest.TestCase):
    def test_parse_sse_frames_and_comments(self):
        raw = ["retry: 3000\n", ": connected\n", "\n", "event: message\n", "id: m1\n", 'data: {"a":1}\n', "\n", ": ping\n", "event: reconnect\n", "data: {}\n", "\n"]
        got = list(bridge.parse_sse(raw))
        self.assertEqual(got, [("message", "m1", '{"a":1}'), ("reconnect", "m1", "{}")])

    def test_prompt_never_authorises_confirmation(self):
        p = bridge.build_prompt({"event_type": "approval.requested", "message": {"content": "Approve draft", "action_id": "act_1"}})
        self.assertIn("act_1", p)
        self.assertIn("Do NOT confirm", p)

    def test_reconnect_event_stops_stream(self):
        self.assertFalse(bridge.handle("reconnect", "m1", "{}"))

    def test_bad_json_is_skipped(self):
        self.assertTrue(bridge.handle("message", "x", "not json"))


if __name__ == "__main__":
    unittest.main()
