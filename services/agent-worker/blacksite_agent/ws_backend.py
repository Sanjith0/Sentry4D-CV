"""Broadcasts TrainingWorker's publish_* calls to connected frontend WebSocket clients.

Two threads are involved: TrainingWorker.run_forever (and therefore every
publish_* call) runs on its own thread, while the actual socket I/O belongs to
the asyncio event loop passed in here. Each publish is handed to that loop via
run_coroutine_threadsafe, so a slow or disconnected client can never block the
worker thread.
"""

import asyncio
import json
import logging

from .schemas import ChoiceResult, Debrief, Record, ScoreEvent, StepPresentation
from .worker import SessionSummary

logger = logging.getLogger(__name__)


class WebSocketBackend:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._clients: set = set()
        self._asset_by_alert: dict[str, str] = {}
        self._asset_by_session: dict[str, str] = {}

    def register(self, ws) -> None:
        self._clients.add(ws)

    def unregister(self, ws) -> None:
        self._clients.discard(ws)

    def note_alert_asset(self, alert_id: str, asset_id: str) -> None:
        """Called by the server before enqueueing an alert, so the session this
        alert starts (once it exists) can still be tagged with its device/asset id."""
        self._asset_by_alert[alert_id] = asset_id

    def _send(self, kind: str, session_id: str | None, data: "Record | dict") -> None:
        asset_id = self._asset_by_session.get(session_id) if session_id else None
        payload = json.dumps(
            {
                "type": kind,
                "sessionId": session_id,
                "assetId": asset_id,
                "data": data.model_dump(by_alias=True) if isinstance(data, Record) else data,
            }
        )
        asyncio.run_coroutine_threadsafe(self._broadcast(payload), self.loop)

    async def _broadcast(self, payload: str) -> None:
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

    # TrainingBackend protocol (see worker.py) ---------------------------------

    def publish_session(self, summary: SessionSummary) -> None:
        asset_id = self._asset_by_alert.get(summary.alert_id)
        if asset_id:
            self._asset_by_session[summary.session_id] = asset_id
        self._send("session", summary.session_id, summary)

    def publish_step(self, session_id: str, step: StepPresentation) -> None:
        self._send("step", session_id, step)

    def publish_result(self, session_id: str, result: ChoiceResult) -> None:
        self._send("result", session_id, result)

    def publish_score(self, session_id: str, event: ScoreEvent) -> None:
        self._send("score", session_id, event)

    def publish_debrief(self, session_id: str, debrief: Debrief) -> None:
        self._send("debrief", session_id, debrief)

    def publish_error(self, session_id: str | None, message: str, retryable: bool) -> None:
        self._send("error", session_id, {"message": message, "retryable": retryable})
