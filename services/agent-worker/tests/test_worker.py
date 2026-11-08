"""Offline tests of the attack-initiated worker against a stand-in for SpacetimeDB."""

import threading
import time

import pytest

from test_session import TrainingLLM

from blacksite_agent.fixtures import FIXTURE_ALERT
from blacksite_agent.llm import LLMError
from blacksite_agent.session import SessionEngine
from blacksite_agent.tools import build_registry
from blacksite_agent.worker import TrainingWorker

ALERT = FIXTURE_ALERT.model_dump(by_alias=True)


class StandInBackend:
    """Records everything the worker would write to SpacetimeDB."""

    def __init__(self):
        self.summaries, self.steps, self.results, self.scores = [], [], [], []
        self.debriefs, self.errors = [], []

    def publish_session(self, summary):
        self.summaries.append(summary)

    def publish_step(self, session_id, step):
        self.steps.append((session_id, step))

    def publish_result(self, session_id, result):
        self.results.append((session_id, result))

    def publish_score(self, session_id, event):
        self.scores.append((session_id, event))

    def publish_debrief(self, session_id, debrief):
        self.debriefs.append((session_id, debrief))

    def publish_error(self, session_id, message, retryable):
        self.errors.append((session_id, message, retryable))

    def public_text(self):
        records = (
            self.summaries
            + [s for _, s in self.steps]
            + [r for _, r in self.results]
            + [s for _, s in self.scores]
            + [d for _, d in self.debriefs]
        )
        return " ".join(r.model_dump_json(by_alias=True) for r in records)


class FlakyLLM(TrainingLLM):
    """Fails while `failing` is true, like an NVIDIA rate limit."""

    failing = False
    failing_role = None

    def complete(self, messages, tools, trace, role, tool_choice="auto"):
        if self.failing or role == self.failing_role:
            raise LLMError("NVIDIA API returned HTTP 429. Rate limited.")
        return super().complete(messages, tools, trace, role, tool_choice)


@pytest.fixture
def llm():
    return FlakyLLM()


@pytest.fixture
def backend():
    return StandInBackend()


@pytest.fixture
def engine(llm):
    return SessionEngine(llm, build_registry())


@pytest.fixture
def worker(engine, backend):
    return TrainingWorker(engine, backend)


def selection(session_id, step_id, attempt, option):
    return {
        "sessionId": session_id,
        "selection": {"stepId": step_id, "attempt": attempt, "optionId": option},
    }


def start(worker, backend):
    worker.enqueue_alert(ALERT)
    worker.process_pending()
    return backend.summaries[0].session_id


def choose(worker, session_id, step_id, attempt, option):
    worker.enqueue_selection(selection(session_id, step_id, attempt, option))
    worker.process_pending()


def play_correctly(worker, backend, session_id):
    for step_id in ("triage", "contain", "recover"):
        choose(worker, session_id, step_id, 1, "B")


def test_initiated_attack_starts_a_session_with_no_prompt(worker, backend):
    session_id = start(worker, backend)
    assert backend.summaries[0].status == "active"
    assert backend.steps[0][0] == session_id and backend.steps[0][1].step_id == "triage"
    assert not backend.errors


def test_nothing_runs_until_the_queue_is_processed(worker, backend, llm):
    worker.enqueue_alert(ALERT)
    assert not llm.calls and not backend.steps


def test_correct_choice_moves_to_the_next_step(worker, backend):
    session_id = start(worker, backend)
    choose(worker, session_id, "triage", 1, "B")
    assert backend.results[0][1].points == 100
    assert backend.scores[0][1].step_id == "triage"
    assert backend.steps[-1][1].step_id == "contain"
    assert backend.summaries[-1].current_step_index == 1


def test_wrong_choice_publishes_feedback_and_stays_on_the_step(worker, backend):
    session_id = start(worker, backend)
    choose(worker, session_id, "triage", 1, "A")
    assert backend.results[0][1].hint and not backend.scores
    assert [s.step_id for _, s in backend.steps] == ["triage"]


def test_full_session_ends_in_a_debrief_and_score(worker, backend):
    session_id = start(worker, backend)
    play_correctly(worker, backend, session_id)
    assert len(backend.debriefs) == 1
    assert backend.summaries[-1].status == "complete" and backend.summaries[-1].score == 300
    assert len(backend.scores) == 3 and not backend.errors


def test_duplicate_alert_starts_no_second_session(worker, backend, llm):
    start(worker, backend)
    calls = len(llm.calls)
    worker.enqueue_alert(ALERT)
    worker.process_pending()
    assert len(backend.summaries) == 1 and len(llm.calls) == calls


def test_agent_raised_alert_is_ignored(worker, backend, llm):
    worker.enqueue_alert({**ALERT, "origin": "agent"})
    worker.process_pending()
    assert not backend.summaries and not llm.calls


def test_redelivered_selection_scores_and_advances_once(worker, backend):
    session_id = start(worker, backend)
    choose(worker, session_id, "triage", 1, "B")
    choose(worker, session_id, "triage", 1, "B")
    assert len(backend.scores) == 1
    assert [s.step_id for _, s in backend.steps] == ["triage", "contain"]
    assert backend.results[0][1] == backend.results[1][1]
    assert backend.summaries[-1].score == 100


def test_answers_and_principles_are_never_published(worker, backend, engine):
    session_id = start(worker, backend)
    choose(worker, session_id, "triage", 1, "A")
    principles = [s.judging_principle for s in engine.store.get(session_id).scenario.steps]
    choose(worker, session_id, "triage", 2, "B")
    text = backend.public_text()
    assert "verdicts" not in text and "judgingPrinciple" not in text
    assert "reason-A" not in text
    assert not any(p in text for p in principles)


def test_wrong_attempt_does_not_reveal_the_answer(worker, backend):
    session_id = start(worker, backend)
    choose(worker, session_id, "triage", 1, "A")
    assert backend.results[0][1].correct_option_id is None


def test_rate_limit_is_reported_and_step_can_be_retried(worker, backend, llm):
    llm.failing = True
    worker.enqueue_alert(ALERT)
    worker.process_pending()
    session_id = backend.summaries[0].session_id
    assert backend.errors == [(session_id, "NVIDIA API returned HTTP 429. Rate limited.", True)]
    assert not backend.steps

    llm.failing = False
    worker.enqueue_retry(session_id)
    worker.process_pending()
    assert backend.steps[0][1].step_id == "triage"


def test_failed_judging_can_be_resubmitted_without_losing_the_attempt(worker, backend, llm):
    session_id = start(worker, backend)
    llm.failing = True
    choose(worker, session_id, "triage", 1, "B")
    assert backend.errors[-1][2] is True and not backend.results
    llm.failing = False
    choose(worker, session_id, "triage", 1, "B")
    assert backend.results[0][1].points == 100


def test_failed_debrief_can_be_retried_without_rescoring(worker, backend, llm):
    session_id = start(worker, backend)
    llm.failing_role = "Instructor"
    play_correctly(worker, backend, session_id)
    assert backend.errors[-1][2] is True and not backend.debriefs
    assert backend.summaries[-1].status == "complete"

    llm.failing_role = None
    worker.enqueue_retry(session_id)
    worker.process_pending()
    assert len(backend.debriefs) == 1
    assert backend.summaries[-1].score == 300 and len(backend.scores) == 3


@pytest.mark.parametrize(
    "bad",
    [
        {"sessionId": "s"},
        {"sessionId": "s", "selection": {"stepId": "triage", "attempt": 1, "optionId": "Z"}},
        {"sessionId": "s", "selection": {"stepId": "nope", "attempt": 1, "optionId": "A"}},
        {"sessionId": "s", "selection": {"stepId": "triage", "attempt": 9, "optionId": "A"}},
    ],
)
def test_malformed_selection_is_rejected_without_a_model_call(worker, backend, llm, bad):
    worker.enqueue_selection(bad)
    worker.process_pending()
    assert backend.errors[-1] == (None, "The selection was malformed.", False)
    assert not llm.calls


def test_malformed_alert_is_rejected(worker, backend, llm):
    worker.enqueue_alert({"alertId": "only-this"})
    worker.process_pending()
    assert backend.errors == [(None, "The alert was malformed.", False)] and not llm.calls


def test_invalid_move_is_reported_as_not_retryable(worker, backend):
    session_id = start(worker, backend)
    choose(worker, session_id, "contain", 1, "A")
    assert backend.errors == [(session_id, "That step is not the current step.", False)]


def test_unknown_session_is_reported(worker, backend):
    choose(worker, "session-nope", "triage", 1, "A")
    assert backend.errors == [("session-nope", "Unknown session.", False)]


def test_unexpected_error_does_not_stop_the_worker_or_leak_details(worker, backend, engine, llm):
    original = engine.present_step
    engine.present_step = lambda session_id: (_ for _ in ()).throw(RuntimeError("secret detail"))
    worker.enqueue_alert(ALERT)
    worker.process_pending()
    assert backend.errors[-1][1] == "An internal error occurred."
    assert "secret detail" not in str(backend.errors)

    engine.present_step = original
    worker.enqueue_retry(backend.summaries[0].session_id)
    worker.process_pending()
    assert backend.steps


def test_background_thread_handles_an_initiated_attack(worker, backend):
    stop = threading.Event()
    thread = threading.Thread(target=worker.run_forever, args=(stop, 0.01), daemon=True)
    thread.start()
    worker.enqueue_alert(ALERT)
    deadline = time.monotonic() + 5
    while not backend.steps and time.monotonic() < deadline:
        time.sleep(0.01)
    stop.set()
    thread.join(timeout=5)
    assert backend.steps and not thread.is_alive()
