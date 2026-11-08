"""FIXTURE DATA: stands in for SpacetimeDB until Person 3's interfaces exist.

Every record is marked is_fixture=True. Only incident data is fixture data; model
calls are always real. `run_token` makes evidence IDs unique per run, so a model
can only cite them by actually receiving the tool result.
"""

from datetime import datetime, timezone
from typing import Protocol

from .schemas import Alert, Evidence, SecurityEvent

_OCCURRED = datetime(2026, 11, 8, 14, 2, 11, tzinfo=timezone.utc)
_COLLECTED = datetime(2026, 11, 8, 14, 2, 13, tzinfo=timezone.utc)

FIXTURE_ALERT = Alert(
    alert_id="alert-001",
    incident_id="incident-001",
    asset_id="laptop-b",
    title="Monitored file changed on Laptop B",
    severity="medium",
)


class IncidentDataSource(Protocol):
    """The read interface a SpacetimeDB-backed client will implement."""

    def get_security_events(
        self, alert_id: str, limit: int
    ) -> tuple[list[SecurityEvent], list[Evidence]]: ...


class FixtureDataSource:
    def __init__(self, run_token: str) -> None:
        self.event = SecurityEvent(
            event_id=f"event-{run_token}",
            alert_id=FIXTURE_ALERT.alert_id,
            incident_id=FIXTURE_ALERT.incident_id,
            asset_id=FIXTURE_ALERT.asset_id,
            event_type="file_modified",
            severity="medium",
            occurred_at=_OCCURRED,
            source="endpoint-collector",
            details={
                "path": "/Users/demo/blacksite-monitored/canary.txt",
                "changeType": "content_modified",
                "process": "unknown",
            },
            is_test_event=True,
            is_fixture=True,
        )
        self.evidence = Evidence(
            evidence_id=f"evidence-{run_token}",
            incident_id=FIXTURE_ALERT.incident_id,
            asset_id=FIXTURE_ALERT.asset_id,
            event_ids=[self.event.event_id],
            kind="file_integrity_record",
            description="File-integrity record for the monitored canary file on Laptop B.",
            collected_at=_COLLECTED,
            is_test_event=True,
            is_fixture=True,
        )

    def get_security_events(
        self, alert_id: str, limit: int
    ) -> tuple[list[SecurityEvent], list[Evidence]]:
        if alert_id != self.event.alert_id:
            return [], []
        return [self.event][:limit], [self.evidence]
