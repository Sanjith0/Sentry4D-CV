"""Starts a training session when a simulated attack is initiated, with no prompt.

A backend (SpacetimeDB, once connected) feeds alerts and selections in through the
enqueue methods. One thread works through them in order, so long agent calls never
block the backend's callbacks. Only public records are published: rulings and judging
principles stay inside the engine.
"""

import logging
import queue
import threading
from typing import Callable, Protocol

from pydantic import ValidationError

from .agent import AgentError
from .llm import LLMError
from .schemas import (
    Alert,
    ChoiceResult,
    Debrief,
    Record,
    ScoreEvent,
    Selection,
    StepPresentation,
    TrainingSession,
)
from .session import InvalidChoice, SessionEngine

logger = logging.getLogger(__name__)


class SessionSummary(Record):
    """The client-visible part of a session."""

    session_id: str
    alert_id: str
    scenario_title: str
    status: str
    current_step_index: int
    score: int


class SelectionEvent(Record):
    session_id: str
    selection: Selection


class TrainingBackend(Protocol):
    """What the worker writes. Each publish should be an upsert on the record's key."""

    def publish_session(self, summary: SessionSummary) -> None: ...

    def publish_step(self, session_id: str, step: StepPresentation) -> None: ...

    def publish_result(self, session_id: str, result: ChoiceResult) -> None: ...

    def publish_score(self, session_id: str, event: ScoreEvent) -> None: ...

    def publish_debrief(self, session_id: str, debrief: Debrief) -> None: ...

    def publish_error(
        self, session_id: str | None, message: str, retryable: bool
    ) -> None: ...


def summarize(session: TrainingSession) -> SessionSummary:
    return SessionSummary(
        session_id=session.session_id,
        alert_id=session.alert_id,
        scenario_title=session.scenario.title,
        status=session.status,
        current_step_index=session.current_step_index,
        score=session.score,
    )


class TrainingWorker:
    def __init__(self, engine: SessionEngine, backend: TrainingBackend) -> None:
        self.engine = engine
        self.backend = backend
        self._events: queue.Queue[Callable[[], None]] = queue.Queue()
        self._handled: set[tuple[str, str, int]] = set()

    def enqueue_alert(self, raw: dict) -> None:
        """A simulated attack was initiated."""
        self._events.put(lambda: self._on_alert(raw))

    def enqueue_selection(self, raw: dict) -> None:
        self._events.put(lambda: self._on_selection(raw))

    def enqueue_retry(self, session_id: str) -> None:
        """Generate the current step or debrief again after a retryable failure."""
        self._events.put(lambda: self._guarded(session_id, lambda: self._advance(session_id)))

    def process_pending(self) -> None:
        """Handle everything queued so far, on the calling thread."""
        while True:
            try:
                event = self._events.get_nowait()
            except queue.Empty:
                return
            event()

    def run_forever(self, stop: threading.Event, poll_seconds: float = 0.2) -> None:
        while not stop.is_set():
            try:
                event = self._events.get(timeout=poll_seconds)
            except queue.Empty:
                continue
            event()

    def _on_alert(self, raw: dict) -> None:
        try:
            alert = Alert.model_validate(raw)
        except ValidationError:
            self.backend.publish_error(None, "The alert was malformed.", retryable=False)
            return

        def start() -> None:
            session = self.engine.start_session(alert)
            if session is None:  # A duplicate, or an agent's own alert.
                return
            self.backend.publish_session(summarize(session))
            started[0] = session.session_id
            self._advance(session.session_id)

        started: list[str | None] = [None]
        self._guarded(None, start, started)

    def _on_selection(self, raw: dict) -> None:
        try:
            event = SelectionEvent.model_validate(raw)
        except ValidationError:
            self.backend.publish_error(None, "The selection was malformed.", retryable=False)
            return
        self._guarded(event.session_id, lambda: self._choose(event))

    def _choose(self, event: SelectionEvent) -> None:
        selection = event.selection
        key = (event.session_id, selection.step_id, selection.attempt)
        replay = key in self._handled
        result = self.engine.submit_choice(event.session_id, selection)
        self.backend.publish_result(event.session_id, result)
        if replay:
            return
        self._handled.add(key)

        session = self.engine.store.get(event.session_id)
        self.backend.publish_session(summarize(session))
        if result.step_resolved:
            self.backend.publish_score(event.session_id, session.score_events[-1])
            self._advance(event.session_id)

    def _advance(self, session_id: str) -> None:
        session = self.engine.store.get(session_id)
        if session is None:
            raise InvalidChoice("Unknown session.")
        if session.status == "complete":
            self.backend.publish_debrief(session_id, self.engine.get_debrief(session_id))
        else:
            self.backend.publish_step(session_id, self.engine.present_step(session_id))

    def _guarded(
        self,
        session_id: str | None,
        action: Callable[[], None],
        started: list[str | None] | None = None,
    ) -> None:
        """Failures are reported to the backend, so one bad event cannot stop the worker."""

        def current() -> str | None:
            return started[0] if started else session_id

        try:
            action()
        except (LLMError, AgentError) as exc:
            # These messages are written to be safe to show and log.
            self.backend.publish_error(current(), str(exc), retryable=True)
        except InvalidChoice as exc:
            self.backend.publish_error(current(), str(exc), retryable=False)
        except Exception as exc:  # The worker must survive anything a single event does.
            logger.error("Unexpected worker failure: %s", type(exc).__name__)
            self.backend.publish_error(current(), "An internal error occurred.", retryable=False)
