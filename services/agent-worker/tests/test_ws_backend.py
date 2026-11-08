"""Offline tests of the WebSocket broadcast backend (no real sockets)."""

import asyncio
import json
import threading
import time

import pytest

from blacksite_agent.schemas import ChoiceResult, Selection, SimulatedOutcome
from blacksite_agent.worker import SessionSummary
from blacksite_agent.ws_backend import WebSocketBackend


class FakeSocket:
    """Stands in for a websockets ServerConnection."""

    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send(self, payload):
        if self.fail:
            raise ConnectionError("client went away")
        self.sent.append(payload)


@pytest.fixture
def loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)


@pytest.fixture
def backend(loop):
    return WebSocketBackend(loop)


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_publish_session_tags_the_session_with_its_noted_asset(backend):
    ws = FakeSocket()
    backend.register(ws)
    backend.note_alert_asset("alert-1", "laptop-b")
    backend.publish_session(
        SessionSummary(
            session_id="session-1",
            alert_id="alert-1",
            scenario_title="Monitored file changed",
            status="active",
            current_step_index=0,
            score=0,
        )
    )
    assert wait_for(lambda: ws.sent)
    sent = json.loads(ws.sent[0])
    assert sent["type"] == "session"
    assert sent["sessionId"] == "session-1"
    assert sent["assetId"] == "laptop-b"
    assert sent["data"]["status"] == "active"


def test_session_with_no_noted_asset_has_no_asset_id(backend):
    ws = FakeSocket()
    backend.register(ws)
    backend.publish_session(
        SessionSummary(
            session_id="session-2",
            alert_id="alert-unknown",
            scenario_title="x",
            status="active",
            current_step_index=0,
            score=0,
        )
    )
    assert wait_for(lambda: ws.sent)
    assert json.loads(ws.sent[0])["assetId"] is None


def test_later_publishes_on_the_same_session_keep_the_asset_id(backend):
    ws = FakeSocket()
    backend.register(ws)
    backend.note_alert_asset("alert-1", "laptop-b")
    backend.publish_session(
        SessionSummary(
            session_id="session-1",
            alert_id="alert-1",
            scenario_title="x",
            status="active",
            current_step_index=0,
            score=0,
        )
    )
    backend.publish_score(
        "session-1",
        __import__("blacksite_agent.schemas", fromlist=["ScoreEvent"]).ScoreEvent(
            step_id="triage", attempt=1, points=100
        ),
    )
    assert wait_for(lambda: len(ws.sent) >= 2)
    assert json.loads(ws.sent[-1])["assetId"] == "laptop-b"


def test_error_with_no_session_has_no_asset_id(backend):
    ws = FakeSocket()
    backend.register(ws)
    backend.publish_error(None, "The alert was malformed.", False)
    assert wait_for(lambda: ws.sent)
    sent = json.loads(ws.sent[0])
    assert sent["type"] == "error"
    assert sent["sessionId"] is None
    assert sent["assetId"] is None
    assert sent["data"] == {"message": "The alert was malformed.", "retryable": False}


def test_a_failing_client_is_dropped_without_affecting_others(backend):
    good = FakeSocket()
    bad = FakeSocket(fail=True)
    backend.register(good)
    backend.register(bad)
    backend.publish_error(None, "hello", False)
    assert wait_for(lambda: good.sent)
    assert wait_for(lambda: bad not in backend._clients)
    assert good in backend._clients


def test_unregister_stops_further_sends(backend):
    ws = FakeSocket()
    backend.register(ws)
    backend.unregister(ws)
    backend.publish_error(None, "hello", False)
    time.sleep(0.2)
    assert not ws.sent


def test_result_and_debrief_serialize_through_model_dump(backend):
    ws = FakeSocket()
    backend.register(ws)
    outcome = SimulatedOutcome(
        strategy="monitor_only",
        service_disruption="low",
        assets_affected=["laptop-b"],
        recovery_complexity="low",
        response_time_minutes=5,
        assumptions=["nothing"],
    )
    backend.publish_result(
        "session-1",
        ChoiceResult(
            selection=Selection(step_id="triage", attempt=1, option_id="A"),
            correct=False,
            points=0,
            step_resolved=False,
            consequence=outcome,
            explanation="not quite",
            total_score=0,
            session_complete=False,
        ),
    )
    assert wait_for(lambda: ws.sent)
    data = json.loads(ws.sent[0])["data"]
    assert data["correct"] is False
    assert data["consequence"]["assetsAffected"] == ["laptop-b"]
