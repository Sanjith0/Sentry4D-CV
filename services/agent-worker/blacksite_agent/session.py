"""Turn-based training sessions: present a step, take a choice, score it, move on.

Fairness rules enforced here:
- The Judge runs once per step, on the first selection, and never sees that selection.
- Its ruling is stored, so a retry can never contradict it.
- Points come from a fixed table in code, and each attempt is scored once.
"""

import json
import random
import secrets
from typing import Protocol

from .agent import AgentError, run_agent
from .fixtures import ScenarioDataSource, build_scenario
from .llm import NemotronClient
from .orchestrator import (
    CONSEQUENCE_EXPLAINER,
    INSTRUCTOR,
    JUDGE,
    OPTION_DESIGNER,
    SCENARIO_GUIDE,
    check_judgement_facts,
    check_pre_choice,
    claim_problem,
    missing_tools,
)
from .schemas import (
    Alert,
    ChoiceResult,
    Debrief,
    Scenario,
    ScenarioStep,
    ScoreEvent,
    Selection,
    SimulatedOutcome,
    StepPresentation,
    StepRecord,
    TrainingOption,
    TrainingSession,
)
from .tool_base import ToolContext, for_model
from .tools import ToolRegistry
from .trace import Trace

POINTS = (100, 50, 25)
MAX_ATTEMPTS = len(POINTS)
OPTION_IDS = ("A", "B", "C", "D")


class InvalidChoice(ValueError):
    """The submitted choice is not allowed at this point in the session."""


class SessionStore(Protocol):
    """Session persistence. A SpacetimeDB-backed store will implement this."""

    def get(self, session_id: str) -> TrainingSession | None: ...

    def save(self, session: TrainingSession) -> None: ...


class InMemorySessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, TrainingSession] = {}

    def get(self, session_id: str) -> TrainingSession | None:
        return self._sessions.get(session_id)

    def save(self, session: TrainingSession) -> None:
        self._sessions[session.session_id] = session


def _evidence_text(scenario: Scenario, step: ScenarioStep) -> str:
    return json.dumps(
        {
            "alertId": scenario.alert_id,
            "incidentId": scenario.incident_id,
            "assetId": scenario.target_asset_id,
            "stepObjective": step.objective,
            "events": [for_model(e) for e in step.events],
        }
    )


def guide_briefing(scenario: Scenario, step: ScenarioStep, number: int) -> str:
    return (
        f"Scenario: {scenario.title}. Step {number} of {len(scenario.steps)}: {step.title}.\n"
        f"Objective: {step.objective}\n"
        f"Alert ID: {scenario.alert_id}. Incident ID: {scenario.incident_id}. "
        f"Affected asset: {scenario.target_asset_id}."
    )


def judge_briefing(
    scenario: Scenario,
    step: ScenarioStep,
    options: list[TrainingOption],
    outcomes: dict[str, SimulatedOutcome],
) -> str:
    """Deliberately omits which option the learner selected."""
    listed = [
        {
            **o.model_dump(by_alias=True),
            "simulatedResult": outcomes[o.action].model_dump(
                mode="json", by_alias=True, exclude={"assumptions", "is_simulated", "strategy"}
            ),
        }
        for o in options
    ]
    return (
        f"Situation: {_evidence_text(scenario, step)}\n"
        f"Judging principle: {step.judging_principle}\n"
        f"Options: {json.dumps(listed)}"
    )


class SessionEngine:
    def __init__(
        self,
        llm: NemotronClient,
        registry: ToolRegistry,
        store: SessionStore | None = None,
        trace_secrets: tuple[str, ...] = (),
    ) -> None:
        self.llm = llm
        self.registry = registry
        self.store = store or InMemorySessionStore()
        self._trace_secrets = trace_secrets
        self._contexts: dict[str, ToolContext] = {}
        self._traces: dict[str, Trace] = {}
        self.processed_alert_ids: set[str] = set()

    def should_start(self, alert: Alert) -> bool:
        return alert.origin == "telemetry" and alert.alert_id not in self.processed_alert_ids

    def start_session(self, alert: Alert) -> TrainingSession | None:
        if not self.should_start(alert):
            return None
        gaps = missing_tools(self.registry)
        if gaps:
            raise NotImplementedError(f"Tools not implemented yet: {gaps}")
        self.processed_alert_ids.add(alert.alert_id)

        token = secrets.token_hex(4)
        scenario = build_scenario(alert, token)
        session = TrainingSession(
            session_id=f"session-{token}",
            alert_id=alert.alert_id,
            scenario=scenario,
            step_records=[StepRecord(step_id=s.step_id) for s in scenario.steps],
        )
        self._contexts[session.session_id] = ToolContext(data=ScenarioDataSource(scenario, token))
        self._traces[session.session_id] = Trace(secrets=self._trace_secrets)
        self.store.save(session)
        return session

    def trace_for(self, session_id: str) -> Trace:
        return self._traces[session_id]

    def get_score(self, session_id: str) -> int:
        return self._session(session_id).score

    def present_step(self, session_id: str) -> StepPresentation:
        """The current step's briefing and options. Generated once, then reused."""
        session = self._session(session_id)
        if session.status == "complete":
            raise InvalidChoice("This session is complete.")
        index = session.current_step_index
        record = session.step_records[index]
        if record.presentation:
            return record.presentation

        step = session.scenario.steps[index]
        context = self._context(session)
        trace = self._traces[session_id]
        scenario = session.scenario
        briefing = guide_briefing(scenario, step, index + 1)
        incident = self._fetch(
            session, "get_incident_context", {"incident_id": scenario.incident_id}, context
        )
        guide = run_agent(
            self.llm,
            SCENARIO_GUIDE,
            self.registry,
            context,
            f"{briefing}\nIncident record: {incident}",
            trace,
            check_pre_choice,
        )
        design_brief = (
            f"{briefing}\nSituation described to the learner: {guide.narrative}\n"
            f"Available evidence: {_evidence_text(session.scenario, step)}\n"
            f"Related assets: {self._related_assets(session, context)}"
        )
        draft = run_agent(
            self.llm, OPTION_DESIGNER, self.registry, context, design_brief, trace, check_pre_choice
        )

        # Shuffled so an option's position says nothing about the model's preference.
        designed = list(draft.options)
        random.Random(f"{session_id}:{step.step_id}").shuffle(designed)
        record.presentation = StepPresentation(
            step_id=step.step_id,
            step_number=index + 1,
            total_steps=len(session.scenario.steps),
            title=step.title,
            objective=step.objective,
            narrative=guide.narrative,
            leading_question=guide.leading_question,
            evidence_ids=guide.evidence_ids,
            options=[
                TrainingOption(option_id=oid, label=o.label, action=o.action)
                for oid, o in zip(OPTION_IDS, designed)
            ],
        )
        self.store.save(session)
        return record.presentation

    def submit_choice(self, session_id: str, selection: Selection) -> ChoiceResult:
        """Score one attempt. Resubmitting the same attempt returns the original result."""
        session = self._session(session_id)
        record = next(r for r in session.step_records if r.step_id == selection.step_id)

        if selection.attempt <= len(record.results):
            existing = record.results[selection.attempt - 1]
            if existing.selection.option_id != selection.option_id:
                raise InvalidChoice("That attempt was already made with a different option.")
            return existing

        index = session.current_step_index
        if session.status == "complete" or session.step_records[index] is not record:
            raise InvalidChoice("That step is not the current step.")
        if record.presentation is None:
            raise InvalidChoice("That step has not been presented yet.")
        if selection.attempt != len(record.results) + 1:
            raise InvalidChoice(f"Expected attempt {len(record.results) + 1}.")
        if selection.option_id in {r.selection.option_id for r in record.results}:
            raise InvalidChoice("That option was already tried.")

        step = session.scenario.steps[index]
        context = self._context(session)
        option = next(o for o in record.presentation.options if o.option_id == selection.option_id)

        # A failure before the attempt is recorded leaves it available to retry.
        if record.judgement is None:
            self._judge(session, step, record, context)

        correct = record.judgement.correct_option_id == selection.option_id
        consequence = context.simulated_outcomes[option.action]
        exhausted = not correct and selection.attempt == MAX_ATTEMPTS
        resolved = correct or exhausted
        points = POINTS[selection.attempt - 1] if correct else 0

        hint = None
        if resolved:
            explanation = record.judgement.verdict_for(record.judgement.correct_option_id).reasoning
        else:
            feedback = self._explain(session, step, option, consequence, context)
            explanation, hint = feedback.narrative, feedback.hint

        if resolved:
            record.resolved = True
            session.score += points
            session.score_events.append(
                ScoreEvent(step_id=step.step_id, attempt=selection.attempt, points=points)
            )
            session.current_step_index += 1
            if session.current_step_index == len(session.scenario.steps):
                session.status = "complete"

        result = ChoiceResult(
            selection=selection,
            correct=correct,
            points=points,
            step_resolved=resolved,
            consequence=consequence,
            explanation=explanation,
            hint=hint,
            correct_option_id=record.judgement.correct_option_id if resolved else None,
            total_score=session.score,
            session_complete=session.status == "complete",
        )
        record.results.append(result)
        self.store.save(session)
        return result

    def get_debrief(self, session_id: str) -> Debrief:
        """The Instructor's end-of-session review. Generated once, then reused."""
        session = self._session(session_id)
        if session.status != "complete":
            raise InvalidChoice("The debrief is available when the session is complete.")
        if session.debrief:
            return session.debrief

        history = []
        for step, record in zip(session.scenario.steps, session.step_records):
            labels = {o.option_id: o.label for o in record.presentation.options}
            correct_id = record.judgement.correct_option_id
            history.append(
                {
                    "step": step.title,
                    "objective": step.objective,
                    "learnerChoices": [
                        {"choice": labels[r.selection.option_id], "correct": r.correct}
                        for r in record.results
                    ],
                    "correctChoice": labels[correct_id],
                    "why": record.judgement.verdict_for(correct_id).reasoning,
                }
            )
        incident = self._fetch(
            session,
            "get_incident_context",
            {"incident_id": session.scenario.incident_id},
            self._context(session),
        )
        briefing = f"Incident record: {incident}\nSession history: {json.dumps(history)}"
        session.debrief = run_agent(
            self.llm,
            INSTRUCTOR,
            self.registry,
            self._context(session),
            briefing,
            self._traces[session_id],
        )
        self.store.save(session)
        return session.debrief

    def _session(self, session_id: str) -> TrainingSession:
        session = self.store.get(session_id)
        if session is None:
            raise InvalidChoice("Unknown session.")
        return session

    def _context(self, session: TrainingSession) -> ToolContext:
        context = self._contexts[session.session_id]
        last = len(session.scenario.steps) - 1
        context.data.current_step_index = min(session.current_step_index, last)
        return context

    def _fetch(
        self, session: TrainingSession, tool: str, args: dict, context: ToolContext
    ) -> str:
        """Run a real tool in code, so an agent needs no model call just to request it."""
        arguments = json.dumps(args)
        outcome = self.registry.execute(tool, arguments, (tool,), context)
        self._traces[session.session_id].add(
            "Session Engine",
            "tool_call" if outcome.ok else "tool_rejected",
            tool_call_id="engine-prefetch",
            tool_name=tool,
            tool_arguments=arguments,
            tool_result=outcome.content,
        )
        if not outcome.ok:
            raise AgentError(f"Could not fetch {tool}.")
        return outcome.content

    def _related_assets(self, session: TrainingSession, context: ToolContext) -> str:
        return self._fetch(
            session, "get_related_assets", {"asset_id": session.scenario.target_asset_id}, context
        )

    def _judge(
        self,
        session: TrainingSession,
        step: ScenarioStep,
        record: StepRecord,
        context: ToolContext,
    ) -> None:
        trace = self._traces[session.session_id]
        options = record.presentation.options
        outcomes = {o.action: self._simulate(session, o, context) for o in options}
        scope = self._fetch(
            session, "get_data_scope", {"asset_id": session.scenario.target_asset_id}, context
        )
        briefing = (
            f"{judge_briefing(session.scenario, step, options, outcomes)}\nData scope: {scope}"
        )
        record.judgement = run_agent(
            self.llm,
            JUDGE,
            self.registry,
            context,
            briefing,
            trace,
            lambda output, ctx: check_judgement_facts(output, options, ctx),
        )
        self.store.save(session)
        trace.add(
            JUDGE.name,
            "judgement",
            detail=f"{step.step_id}: {record.judgement.model_dump_json(by_alias=True)}",
        )

    def _simulate(
        self, session: TrainingSession, option: TrainingOption, context: ToolContext
    ) -> SimulatedOutcome:
        arguments = json.dumps(
            {"strategy": option.action, "target_asset_id": session.scenario.target_asset_id}
        )
        outcome = self.registry.execute(
            "simulate_response", arguments, ("simulate_response",), context
        )
        self._traces[session.session_id].add(
            "Session Engine",
            "tool_call" if outcome.ok else "tool_rejected",
            tool_call_id="engine-consequence",
            tool_name="simulate_response",
            tool_arguments=arguments,
            tool_result=outcome.content,
        )
        if not outcome.ok:
            raise AgentError("The simulation could not run for this option.")
        return context.simulated_outcomes[option.action]

    def _explain(
        self,
        session: TrainingSession,
        step: ScenarioStep,
        option: TrainingOption,
        consequence: SimulatedOutcome,
        context: ToolContext,
    ):
        """Receives only the learner's own choice, so its hint cannot name the answer."""
        briefing = (
            f"Asset: {session.scenario.target_asset_id}. Objective: {step.objective}\n"
            f"The learner chose: {option.label}\n"
            f"Simulated result: {consequence.model_dump_json(by_alias=True)}\n"
            f"Related assets: {self._related_assets(session, context)}"
        )

        def check_facts(output, _context) -> None:
            known = {consequence.response_time_minutes}
            for text in (output.narrative, output.hint):
                problem = claim_problem(text, consequence, known)
                if problem:
                    raise ValueError(f"Your feedback {problem}")

        return run_agent(
            self.llm,
            CONSEQUENCE_EXPLAINER,
            self.registry,
            context,
            briefing,
            self._traces[session.session_id],
            check_facts,
        )
