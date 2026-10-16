import json
import os
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class Tools(unittest.TestCase):
    def test_get_menu_is_the_whole_menu(self):
        call = {"id": "c1", "function": {"name": "get_menu", "arguments": "{}"}}
        result = json.loads(server.run_tool(call)["content"])
        self.assertEqual(result, {"menu": server.MENU, "note": "This is the whole menu."})
        self.assertEqual(result["menu"][0]["sizes"]["large"], 4.8)

    def test_place_order_numbers_orders(self):
        first = server.place_order("Sam", [{"item": "Latte", "size": "large", "milk": "oat", "quantity": 1}])
        second = server.place_order("Ana", [{"item": "Cold brew", "size": "small"}])
        self.assertRegex(first["order_id"], r"^BL-\d{4}$")
        self.assertEqual(int(second["order_id"][3:]), int(first["order_id"][3:]) + 1)
        self.assertTrue(first["pay_at_pickup"])
        ready = datetime.fromisoformat(first["ready_by"].replace("Z", "+00:00")) - datetime.now(timezone.utc)
        self.assertLess(abs(ready - timedelta(minutes=10)), timedelta(minutes=1))

    def test_place_order_refuses_what_is_not_on_the_menu(self):
        self.assertEqual(server.place_order("Sam", [{"item": "Matcha latte", "size": "large"}]), {"error": "Unknown item: Matcha latte"})
        self.assertEqual(server.place_order("Sam", [{"item": "Flat white", "size": "large"}]), {"error": "Unknown size: large"})
        self.assertEqual(server.place_order("Sam", [{"item": "Chai", "size": "small", "milk": "almond"}]), {"error": "Unknown milk: almond"})


class PersonText(unittest.TestCase):
    def test_ids_and_notes(self):
        tap = {"text": "Oat", "choice": {"title": "Oat"}, "replyTo": {"text": "Which milk?", "fromAgent": True}}
        self.assertEqual(server.person_text("m2", tap), '[m2, tapped] Oat (replying to your message "Which milk?")')
        photo = {"text": "", "attachments": [{"kind": "image", "mime": "image/png", "name": "photo.png", "data": "iVBO"}]}
        self.assertEqual(server.person_text("m1", photo), "[m1] (sent an image: photo.png)")


class Endpoint(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"FAKE_MODEL": "1", "CHINWAG_AGENT_TOKEN": "t"}))
        self.enterContext(mock.patch.object(server.Handler, "log_message", lambda *args: None))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.url = f"http://127.0.0.1:{httpd.server_address[1]}/chinwag"

    def post(self, headers):
        body = {"conversationId": "whatsapp:test.order.whatsapp.1", "messageId": "m1", "channel": "whatsapp", "message": {"text": "hi"}}
        with urlopen(Request(self.url, json.dumps(body).encode(), {"content-type": "application/json", **headers})) as response:
            return response.status, json.load(response)

    def test_answers_with_replies(self):
        self.assertEqual(self.post({"authorization": "Bearer t"}), (200, {"replies": [{"type": "message", "text": server.FAKE_REPLY}]}))
        self.assertEqual(server.histories["whatsapp:test.order.whatsapp.1"][0], {"role": "user", "content": "[m1] hi"})

    def test_needs_the_token(self):
        with self.assertRaises(HTTPError) as caught:
            self.post({})
        self.assertEqual(caught.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
