"""WebSocket bridge between the training worker and the Sentry3D 3D viewer.

Run from services/agent-worker:
  .venv/bin/python -m blacksite_agent.server

The frontend's useCyberAlertSocket hook connects to ws://localhost:8787 and a
client (the DEVICES panel, or any test script) sends
  {"type": "start_attack", "assetId": "laptop-b"}
to kick off a scripted attack, and
  {"type": "select_option", "sessionId": ..., "stepId": ..., "attempt": 1, "optionId": "A"}
to answer the current step. There is no offline mode: every agent call this
triggers is a real call to the configured model (see train.py).
"""

import asyncio
import json
import logging
import secrets
import sys
import threading

import websockets

from .config import ConfigError, load_settings
from .fixtures import FIXTURE_ALERT
from .llm import NemotronClient
from .schemas import Alert
from .session import SessionEngine
from .tools import build_registry
from .worker import TrainingWorker
from .ws_backend import WebSocketBackend

logger = logging.getLogger(__name__)

# Only this asset has an authored scenario today (fixtures.py stands in for
# SpacetimeDB). Starting an attack on any other asset_id fails cleanly through
# TrainingWorker's existing error path instead of crashing the server.
SCRIPTABLE_ASSET_ID = FIXTURE_ALERT.asset_id


def _dispatch(msg: dict, worker: TrainingWorker, backend: WebSocketBackend) -> None:
    kind = msg.get("type")
    if kind == "start_attack":
        asset_id = msg.get("assetId")
        if asset_id != SCRIPTABLE_ASSET_ID:
            backend.publish_error(
                None,
                f"No scripted scenario for asset '{asset_id}' yet. Try '{SCRIPTABLE_ASSET_ID}'.",
                retryable=False,
            )
            return
        alert = Alert(
            alert_id=f"alert-{secrets.token_hex(4)}",
            incident_id=FIXTURE_ALERT.incident_id,
            asset_id=asset_id,
            title=FIXTURE_ALERT.title,
            severity=FIXTURE_ALERT.severity,
        )
        backend.note_alert_asset(alert.alert_id, alert.asset_id)
        worker.enqueue_alert(alert.model_dump(by_alias=True))
    elif kind == "select_option":
        worker.enqueue_selection(
            {
                "sessionId": msg.get("sessionId"),
                "selection": {
                    "stepId": msg.get("stepId"),
                    "attempt": msg.get("attempt"),
                    "optionId": msg.get("optionId"),
                },
            }
        )
    else:
        logger.warning("Unknown message type: %s", kind)


async def _handle_client(ws, worker: TrainingWorker, backend: WebSocketBackend) -> None:
    backend.register(ws)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            _dispatch(msg, worker, backend)
    finally:
        backend.unregister(ws)


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"TRAINING SERVER FAILED: {exc}", file=sys.stderr)
        return 1

    engine = SessionEngine(
        NemotronClient(settings),
        build_registry(),
        trace_secrets=(settings.api_key.get_secret_value(),),
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    backend = WebSocketBackend(loop)
    worker = TrainingWorker(engine, backend)

    stop = threading.Event()
    threading.Thread(target=worker.run_forever, args=(stop,), daemon=True).start()

    async def serve() -> None:
        async with websockets.serve(lambda ws: _handle_client(ws, worker, backend), "localhost", 8787):
            print("[blacksite] WebSocket bridge listening on ws://localhost:8787")
            await asyncio.Future()  # run forever

    try:
        loop.run_until_complete(serve())
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
