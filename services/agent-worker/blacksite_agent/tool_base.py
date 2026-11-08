"""Base types shared by every tool module (kept apart to avoid import cycles)."""

from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict

from .fixtures import IncidentDataSource
from .schemas import Evidence, SecurityEvent, SimulatedOutcome


@dataclass
class ToolContext:
    data: IncidentDataSource
    seen_evidence: dict[str, Evidence] = field(default_factory=dict)
    seen_events: dict[str, SecurityEvent] = field(default_factory=dict)
    # Filled by simulate_response; read by draft_response_plan. Keyed by strategy id.
    simulated_outcomes: dict[str, SimulatedOutcome] = field(default_factory=dict)
    # Latest output of draft_response_plan; the final plan is assembled from it.
    plan_draft: dict | None = None


class ToolRefused(Exception):
    """Raised by a handler to reject a call. The message is shown to the model."""


class ToolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    args_model: type[ToolArgs]
    handler: Callable[[Any, ToolContext], dict]


@dataclass(frozen=True)
class ToolOutcome:
    ok: bool
    content: str


def _strip_fixture_flag(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_fixture_flag(v) for k, v in value.items() if k != "isFixture"}
    if isinstance(value, list):
        return [_strip_fixture_flag(v) for v in value]
    return value


def for_model(record: BaseModel) -> dict:
    """JSON-ready dict for tool output. Hides `isFixture`, which describes our test
    harness rather than the incident, so the model must never see it."""
    return _strip_fixture_flag(record.model_dump(mode="json", by_alias=True))
