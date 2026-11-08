"""Play a training session against the live NVIDIA API.

Run from services/agent-worker:
  .venv/bin/python -m blacksite_agent.train          # you choose
  .venv/bin/python -m blacksite_agent.train --auto   # tries A, B, C and runs checks

There is no offline mode. The attack is scripted; every agent call is real.
"""

import argparse
import sys
import time

from .agent import AgentError
from .config import ConfigError, load_settings
from .fixtures import FIXTURE_ALERT
from .llm import LLMError, NemotronClient
from .schemas import Selection, StepPresentation
from .session import MAX_ATTEMPTS, POINTS, InvalidChoice, SessionEngine
from .tools import build_registry


def _fail(message: str) -> int:
    print(f"TRAINING FAILED: {message}", file=sys.stderr)
    return 1


def _show_step(step: StepPresentation, seconds: float) -> None:
    print(f"\n=== Step {step.step_number}/{step.total_steps}: {step.title} ({seconds:.1f}s) ===")
    print(f"Objective: {step.objective}\n\n{step.narrative}\n\n{step.leading_question}\n")
    for option in step.options:
        print(f"  {option.option_id}) {option.label}")


def _ask(tried: set[str]) -> str:
    while True:
        answer = input("\nYour choice: ").strip().upper()
        if answer in ("A", "B", "C", "D") and answer not in tried:
            return answer
        print("Enter A, B, C or D, and not one you have already tried.")


def _auto_pick(tried: set[str]) -> str:
    return next(o for o in ("A", "B", "C", "D") if o not in tried)


def play(engine: SessionEngine, session_id: str, auto: bool) -> list[tuple]:
    """Runs the session and returns (selection, result) pairs."""
    played = []
    while engine.store.get(session_id).status != "complete":
        started = time.monotonic()
        step = engine.present_step(session_id)
        _show_step(step, time.monotonic() - started)
        tried: set[str] = set()
        for attempt in range(1, MAX_ATTEMPTS + 1):
            option_id = _auto_pick(tried) if auto else _ask(tried)
            tried.add(option_id)
            selection = Selection(step_id=step.step_id, attempt=attempt, option_id=option_id)
            started = time.monotonic()
            result = engine.submit_choice(session_id, selection)
            elapsed = time.monotonic() - started
            played.append((selection, result))
            outcome = result.consequence
            verdict = "CORRECT" if result.correct else "NOT QUITE"
            print(f"\n[{option_id}] {verdict}  +{result.points} points  ({elapsed:.1f}s, AI-judged)")
            print(
                f"Simulated result: disruption {outcome.service_disruption}, "
                f"{outcome.response_time_minutes} min, "
                f"affected {', '.join(outcome.assets_affected)}"
            )
            print(result.explanation)
            if result.hint:
                print(f"Hint: {result.hint}")
            if result.step_resolved:
                if not result.correct:
                    print(f"The answer was {result.correct_option_id}.")
                break
    return played


def _run_checks(engine: SessionEngine, session_id: str, played: list[tuple]) -> bool:
    session = engine.store.get(session_id)
    trace = engine.trace_for(session_id)
    first_selection, first_result = played[0]
    score_before = session.score
    replay = engine.submit_choice(session_id, first_selection)
    model_requested = sum(
        1
        for step in trace.steps
        if step.kind == "tool_call" and not (step.tool_call_id or "").startswith("engine-")
    )
    expected = sum(
        POINTS[e.attempt - 1] if e.points else 0 for e in session.score_events
    )
    checks = {
        "All three steps resolved": all(r.resolved for r in session.step_records),
        "Score matches the points table": session.score == expected,
        "Judge ran exactly once per step": trace.count("judgement") == 3,
        "Double submission changes nothing": replay == first_result
        and session.score == score_before,
        "Duplicate alert starts no session": engine.start_session(FIXTURE_ALERT) is None,
        "Model requested at least three tool calls": model_requested >= 3,
        "Debrief produced": session.debrief is not None,
    }
    print("\n=== CHECKS ===")
    for label, passed in checks.items():
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")
    print(
        f"Tool calls: {trace.count('tool_call')} ({model_requested} model-requested)  "
        f"Corrections: {trace.count('repair')}  "
        f"Model calls: {trace.count('model_response')}"
    )
    return all(checks.values())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auto", action="store_true", help="Pick options automatically.")
    parser.add_argument("--trace", action="store_true", help="Print the full sanitized trace.")
    args = parser.parse_args()

    try:
        settings = load_settings()
    except ConfigError as exc:
        return _fail(str(exc))

    engine = SessionEngine(
        NemotronClient(settings),
        build_registry(),
        trace_secrets=(settings.api_key.get_secret_value(),),
    )
    session = engine.start_session(FIXTURE_ALERT)
    print(f"Model   : {settings.model}")
    print(f"Scenario: {session.scenario.title} (scripted training exercise)")

    trace = engine.trace_for(session.session_id)
    try:
        played = play(engine, session.session_id, args.auto)
        started = time.monotonic()
        debrief = engine.get_debrief(session.session_id)
        print(f"\n=== Debrief ({time.monotonic() - started:.1f}s) ===\n{debrief.summary}")
        print("Strengths:\n  - " + "\n  - ".join(debrief.strengths))
        print("To improve:\n  - " + "\n  - ".join(debrief.improvements))
        print(f"\nFinal score: {engine.get_score(session.session_id)} / {sum([POINTS[0]] * 3)}")
    except (LLMError, AgentError, InvalidChoice) as exc:
        print(trace.render())
        return _fail(trace.clean(str(exc)))

    if args.trace:
        print("\n=== TRACE ===")
        print(trace.render())
    if args.auto:
        return 0 if _run_checks(engine, session.session_id, played) else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
