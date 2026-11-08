"""Validated records exchanged between agents, tools, and the backend.

Records serialize to camelCase (`model_dump(by_alias=True)`) for SpacetimeDB and
the frontend, and accept either camelCase or snake_case on input.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

Severity = Literal["low", "medium", "high", "critical"]
Confidence = Literal["low", "medium", "high"]
Classification = Literal["informational", "suspicious", "confirmed_compromise"]
# Every simulated action a training option can map to. Nothing here runs for real.
StrategyId = Literal[
    "immediate_isolation",
    "staged_failover_then_isolation",
    "block_traffic",
    "reset_credentials",
    "restore_from_backup",
    "preserve_evidence",
    "monitor_only",
]
StepId = Literal["triage", "contain", "recover"]
OptionId = Literal["A", "B", "C", "D"]
Level = Literal["low", "medium", "high"]


class Record(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class Alert(Record):
    alert_id: str
    incident_id: str
    asset_id: str
    title: str
    severity: Severity
    # Alerts raised by the agents themselves never start an investigation.
    origin: Literal["telemetry", "agent"] = "telemetry"


class SecurityEvent(Record):
    event_id: str
    alert_id: str
    incident_id: str
    asset_id: str
    event_type: str
    severity: Severity
    occurred_at: datetime
    source: str
    details: dict[str, str] = Field(default_factory=dict)
    is_test_event: bool = False
    is_fixture: bool = False


class Evidence(Record):
    evidence_id: str
    incident_id: str
    asset_id: str
    event_ids: list[str]
    kind: str
    description: str
    collected_at: datetime
    is_test_event: bool = False
    is_fixture: bool = False


class Finding(Record):
    incident_id: str
    summary: str
    evidence_ids: list[str] = Field(min_length=1)
    confidence: Confidence
    classification: Classification
    recommended_action: str
    confirmed_facts: list[str] = Field(default_factory=list)
    hypotheses: list[str] = Field(default_factory=list)


class SimulatedOutcome(Record):
    """Illustrative scenario assumptions, not real-world predictions."""

    strategy: StrategyId
    service_disruption: Level
    assets_affected: list[str]
    recovery_complexity: Level
    response_time_minutes: int = Field(ge=0)
    assumptions: list[str]
    is_simulated: Literal[True] = True


class AgentStep(Record):
    step: int
    role: str
    kind: Literal[
        "model_response", "tool_call", "tool_rejected", "final_output", "repair", "judgement"
    ]
    latency_ms: int | None = None
    response_id: str | None = None
    served_model: str | None = None
    finish_reason: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_arguments: str | None = None
    tool_result: str | None = None
    detail: str | None = None


class Asset(Record):
    asset_id: str
    name: str
    kind: Literal["laptop", "router", "storage", "camera", "server"]
    criticality: Level
    location: str
    is_fixture: bool = False


class RelatedAsset(Record):
    """An asset connected to the queried asset. `direction` is relative to the query."""

    asset: Asset
    relation: Literal["connects_via", "shares_files_with", "backs_up_to"]
    direction: Literal["outbound", "inbound"]
    hops: int = Field(ge=1, le=2)


class CvObservation(Record):
    observation_id: str
    asset_id: str
    kind: Literal["qr_scan", "object_detection"]
    description: str
    observed_at: datetime
    confidence: float = Field(ge=0, le=1)
    is_fixture: bool = False


class DataScope(Record):
    asset_id: str
    data_classes: list[str]
    sensitivity: Level
    backup_present: bool
    notes: str
    is_fixture: bool = False


class IncidentContext(Record):
    incident_id: str
    title: str
    status: Literal["open", "contained", "closed"]
    primary_asset_id: str
    alert_ids: list[str]
    severity: Severity
    opened_at: datetime
    response_status: Literal["none", "proposed", "approved", "rejected"]
    is_fixture: bool = False


class ScenarioStep(Record):
    """One authored stage of an attack. Options and answers are never authored here."""

    step_id: StepId
    title: str
    objective: str
    # Authored guidance for the Judge only. Must never reach a learner or a pre-choice agent.
    judging_principle: str
    events: list[SecurityEvent]
    evidence: list[Evidence]


class Scenario(Record):
    scenario_id: str
    title: str
    alert_id: str
    incident_id: str
    target_asset_id: str
    steps: list[ScenarioStep] = Field(min_length=3, max_length=3)


class GuideBriefing(Record):
    narrative: str
    leading_question: str
    evidence_ids: list[str] = Field(min_length=1)


class DesignedOption(Record):
    label: str = Field(max_length=240)
    action: StrategyId


class OptionDraft(Record):
    options: list[DesignedOption] = Field(min_length=4, max_length=4)

    @model_validator(mode="after")
    def _actions_are_distinct(self):
        if len({o.action for o in self.options}) != 4:
            raise ValueError("Each of the four options must use a different action.")
        return self


class TrainingOption(Record):
    option_id: OptionId
    label: str
    action: StrategyId


class StepPresentation(Record):
    """What the learner sees before choosing. Contains no ruling."""

    step_id: StepId
    step_number: int
    total_steps: int
    title: str
    objective: str
    narrative: str
    leading_question: str
    evidence_ids: list[str]
    options: list[TrainingOption] = Field(min_length=4, max_length=4)


class OptionVerdict(Record):
    option_id: OptionId
    correct: bool
    reasoning: str


class StepJudgement(Record):
    """The AI's single ruling on all four options for a step. Server-side only."""

    verdicts: list[OptionVerdict] = Field(min_length=4, max_length=4)

    @model_validator(mode="after")
    def _exactly_one_correct(self):
        if sorted(v.option_id for v in self.verdicts) != ["A", "B", "C", "D"]:
            raise ValueError("verdicts must cover A, B, C and D exactly once.")
        if sum(v.correct for v in self.verdicts) != 1:
            raise ValueError("Exactly one option must be correct.")
        return self

    @property
    def correct_option_id(self) -> str:
        return next(v.option_id for v in self.verdicts if v.correct)

    def verdict_for(self, option_id: str) -> OptionVerdict:
        return next(v for v in self.verdicts if v.option_id == option_id)


class ConsequenceFeedback(Record):
    narrative: str
    hint: str


class Debrief(Record):
    summary: str
    strengths: list[str]
    improvements: list[str]


class Selection(Record):
    step_id: StepId
    attempt: int = Field(ge=1, le=3)
    option_id: OptionId


class ChoiceResult(Record):
    selection: Selection
    correct: bool
    points: int
    step_resolved: bool
    consequence: SimulatedOutcome
    explanation: str
    hint: str | None = None
    # Set only once the step is resolved, so a retry cannot read it.
    correct_option_id: OptionId | None = None
    total_score: int
    session_complete: bool
    ai_judged: Literal[True] = True


class ScoreEvent(Record):
    step_id: StepId
    attempt: int
    points: int


class StepRecord(Record):
    step_id: StepId
    presentation: StepPresentation | None = None
    judgement: StepJudgement | None = None
    results: list[ChoiceResult] = Field(default_factory=list)
    resolved: bool = False


class TrainingSession(Record):
    session_id: str
    alert_id: str
    scenario: Scenario
    status: Literal["active", "complete"] = "active"
    current_step_index: int = 0
    score: int = 0
    score_events: list[ScoreEvent] = Field(default_factory=list)
    step_records: list[StepRecord]
    debrief: Debrief | None = None
