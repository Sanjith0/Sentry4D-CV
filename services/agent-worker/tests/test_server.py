"""Offline tests of the WebSocket message dispatch (no real sockets, no model calls)."""

from blacksite_agent.fixtures import FIXTURE_ALERT
from blacksite_agent.server import SCRIPTABLE_ASSET_ID, _dispatch


class FakeWorker:
    def __init__(self):
        self.alerts = []
        self.selections = []

    def enqueue_alert(self, raw):
        self.alerts.append(raw)

    def enqueue_selection(self, raw):
        self.selections.append(raw)


class FakeBackend:
    def __init__(self):
        self.noted = []
        self.errors = []

    def note_alert_asset(self, alert_id, asset_id):
        self.noted.append((alert_id, asset_id))

    def publish_error(self, session_id, message, retryable):
        self.errors.append((session_id, message, retryable))


def test_start_attack_on_the_scriptable_asset_enqueues_an_alert():
    worker, backend = FakeWorker(), FakeBackend()
    _dispatch({"type": "start_attack", "assetId": SCRIPTABLE_ASSET_ID}, worker, backend)
    assert len(worker.alerts) == 1
    alert = worker.alerts[0]
    assert alert["assetId"] == SCRIPTABLE_ASSET_ID
    assert alert["title"] == FIXTURE_ALERT.title
    assert not backend.errors
    assert backend.noted == [(alert["alertId"], SCRIPTABLE_ASSET_ID)]


def test_start_attack_on_an_unscripted_asset_is_rejected_without_a_model_call():
    worker, backend = FakeWorker(), FakeBackend()
    _dispatch({"type": "start_attack", "assetId": "laptop-a"}, worker, backend)
    assert not worker.alerts
    assert backend.errors and backend.errors[0][2] is False
    assert "laptop-a" in backend.errors[0][1]


def test_two_start_attacks_get_different_alert_ids():
    worker, backend = FakeWorker(), FakeBackend()
    _dispatch({"type": "start_attack", "assetId": SCRIPTABLE_ASSET_ID}, worker, backend)
    _dispatch({"type": "start_attack", "assetId": SCRIPTABLE_ASSET_ID}, worker, backend)
    assert worker.alerts[0]["alertId"] != worker.alerts[1]["alertId"]


def test_select_option_enqueues_a_selection():
    worker, backend = FakeWorker(), FakeBackend()
    _dispatch(
        {"type": "select_option", "sessionId": "s1", "stepId": "triage", "attempt": 1, "optionId": "B"},
        worker,
        backend,
    )
    assert worker.selections == [
        {"sessionId": "s1", "selection": {"stepId": "triage", "attempt": 1, "optionId": "B"}}
    ]
    assert not backend.errors


def test_unknown_message_type_is_ignored():
    worker, backend = FakeWorker(), FakeBackend()
    _dispatch({"type": "nonsense"}, worker, backend)
    assert not worker.alerts and not worker.selections and not backend.errors
