"""Validated records exchanged between agents, tools, and the backend.

Records serialize to camelCase (`model_dump(by_alias=True)`) for SpacetimeDB and
the frontend, and accept either camelCase or snake_case on input.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Severity = Literal["low", "medium", "high", "critical"]
Confidence = Literal["low", "medium", "high"]
Classification = Literal["informational", "suspicious", "confirmed_compromise"]
StrategyId = Literal["immediate_isolation", "staged_failover_then_isolation"]
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


class ImpactAssessment(Record):
    incident_id: str
    potentially_affected_assets: list[str]
    confirmed_data_exposure: list[str]
    suspected_data_exposure: list[str]
    uncertainties: list[str]
    evidence_ids: list[str] = Field(min_length=1)


class SimulatedOutcome(Record):
    """Illustrative scenario assumptions, not real-world predictions."""

    strategy: StrategyId
    service_disruption: Level
    assets_affected: list[str]
    recovery_complexity: Level
    response_time_minutes: int = Field(ge=0)
    assumptions: list[str]
    is_simulated: Literal[True] = True


class StrategyComparison(Record):
    incident_id: str
    outcomes: list[SimulatedOutcome] = Field(min_length=2)
    preferred_strategy: StrategyId
    tradeoffs: str
    is_simulated: Literal[True] = True


class ResponsePlan(Record):
    incident_id: str
    incident_summary: str
    confirmed_observations: list[str]
    uncertainties: list[str]
    affected_assets: list[str]
    evidence_ids: list[str] = Field(min_length=1)
    strategy_comparison: StrategyComparison
    proposed_response: StrategyId
    rationale: str
    # Literals: a plan that skips human approval or claims real action fails validation.
    human_approval_required: Literal[True] = True
    is_simulated: Literal[True] = True


class CommanderBrief(Record):
    """The Commander's written judgement. Code merges it with the verified draft."""

    incident_summary: str
    confirmed_observations: list[str]
    uncertainties: list[str]


class AgentStep(Record):
    step: int
    role: str
    kind: Literal["model_response", "tool_call", "tool_rejected", "final_output", "repair"]
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
