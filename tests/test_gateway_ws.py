import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import websockets
from websockets.frames import Close
import gateway.router as web


class GatewayCloseTests(unittest.TestCase):
    def test_backend_codes_reach_public_client(self):
        for code in [1000, 1008, 1013]:

            class Backend:
                close_code = code
                close_reason = "busy" if code == 1013 else "finished"

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    pass

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    if code != 1000:
                        raise websockets.ConnectionClosedError(
                            Close(code, self.close_reason),
                            Close(code, self.close_reason),
                            True,
                        )
                    raise StopAsyncIteration

            finished = []

            class Socket:
                url = SimpleNamespace(hostname="api.hilex.me")
                scope = {}
                headers = {}
                app = SimpleNamespace(
                    state=SimpleNamespace(
                        store=SimpleNamespace(
                            finish=lambda *args: finished.append(args)
                        )
                    )
                )
                application_state = SimpleNamespace(name="CONNECTED")

                async def accept(self, **kwargs):
                    pass

                async def receive(self):
                    await asyncio.Future()

                async def close(self, code=1000, reason=""):
                    self.code = code
                    self.reason = reason
                    self.application_state = SimpleNamespace(name="DISCONNECTED")

            ws = Socket()
            with (
                patch.object(web, "authorize_inference", return_value=("lease", {})),
                patch.object(web.websockets, "connect", return_value=Backend()),
            ):
                asyncio.run(web.websocket(ws, "tts"))
            self.assertEqual(ws.code, code)
            self.assertEqual(len(finished), 1)

    def test_client_disconnect_does_not_send_another_close(self):
        class Backend:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def __aiter__(self):
                return self

            async def __anext__(self):
                await asyncio.Future()

        finished = []

        class Socket:
            url = SimpleNamespace(hostname="api.hilex.me")
            scope = {}
            headers = {}
            app = SimpleNamespace(
                state=SimpleNamespace(
                    store=SimpleNamespace(finish=lambda *args: finished.append(args))
                )
            )
            application_state = SimpleNamespace(name="CONNECTED")
            client_state = SimpleNamespace(name="CONNECTED")

            async def accept(self, **kwargs):
                pass

            async def receive(self):
                self.client_state = SimpleNamespace(name="DISCONNECTED")
                return {"type": "websocket.disconnect"}

            async def close(self, **kwargs):
                raise AssertionError("must not send a close after client disconnect")

        with (
            patch.object(web, "authorize_inference", return_value=("lease", {})),
            patch.object(web.websockets, "connect", return_value=Backend()),
        ):
            asyncio.run(web.websocket(Socket(), "asr"))
        self.assertEqual(len(finished), 1)
