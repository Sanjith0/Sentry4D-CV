"""FIXTURE DATA: stands in for SpacetimeDB until Person 3's interfaces exist.

Every record is marked is_fixture=True. Only incident data is fixture data; model
calls are always real. `run_token` makes evidence IDs unique per run, so a model
can only cite them by actually receiving the tool result.
"""

from datetime import datetime, timedelta, timezone
from typing import Protocol

from .schemas import (
    Alert,
    Asset,
    CvObservation,
    DataScope,
    Evidence,
    IncidentContext,
    RelatedAsset,
    Scenario,
    ScenarioStep,
    SecurityEvent,
)

_OCCURRED = datetime(2026, 11, 8, 14, 2, 11, tzinfo=timezone.utc)
_COLLECTED = datetime(2026, 11, 8, 14, 2, 13, tzinfo=timezone.utc)

FIXTURE_ALERT = Alert(
    alert_id="alert-001",
    incident_id="incident-001",
    asset_id="laptop-b",
    title="Monitored file changed on Laptop B",
    severity="medium",
)


_ASSETS = {
    a.asset_id: a
    for a in [
        Asset(asset_id="laptop-b", name="Laptop B", kind="laptop", criticality="medium",
              location="Desk 2", is_fixture=True),
        Asset(asset_id="laptop-a", name="Laptop A", kind="laptop", criticality="low",
              location="Desk 1", is_fixture=True),
        Asset(asset_id="router-1", name="Office Router", kind="router", criticality="high",
              location="Network shelf", is_fixture=True),
        Asset(asset_id="nas-1", name="Team NAS", kind="storage", criticality="high",
              location="Network shelf", is_fixture=True),
        Asset(asset_id="camera-1", name="Room Camera", kind="camera", criticality="low",
              location="Ceiling corner", is_fixture=True),
    ]
}

# (source, relation, target)
_EDGES = [
    ("laptop-b", "connects_via", "router-1"),
    ("laptop-a", "connects_via", "router-1"),
    ("nas-1", "connects_via", "router-1"),
    ("camera-1", "connects_via", "router-1"),
    ("laptop-b", "shares_files_with", "nas-1"),
    ("laptop-b", "backs_up_to", "nas-1"),
]

_DATA_SCOPES = {
    d.asset_id: d
    for d in [
        DataScope(asset_id="laptop-b", data_classes=["project documents", "monitored canary file"],
                  sensitivity="medium", backup_present=True,
                  notes="Backed up to nas-1.", is_fixture=True),
        DataScope(asset_id="laptop-a", data_classes=["personal documents"], sensitivity="low",
                  backup_present=False, notes="No backup configured.", is_fixture=True),
        DataScope(asset_id="nas-1", data_classes=["shared project files", "laptop backups"],
                  sensitivity="high", backup_present=False,
                  notes="Holds backups for laptop-b.", is_fixture=True),
        DataScope(asset_id="router-1", data_classes=["network configuration"], sensitivity="medium",
                  backup_present=False, notes="No user data stored.", is_fixture=True),
        DataScope(asset_id="camera-1", data_classes=["room video"], sensitivity="medium",
                  backup_present=False, notes="Video retained locally.", is_fixture=True),
    ]
}

_CV_OBSERVATIONS = [
    CvObservation(observation_id="cv-001", asset_id="laptop-b", kind="qr_scan",
                  description="Registered QR code scanned and linked to asset laptop-b.",
                  observed_at=datetime(2026, 11, 8, 13, 58, 40, tzinfo=timezone.utc),
                  confidence=0.99, is_fixture=True),
    CvObservation(observation_id="cv-002", asset_id="laptop-b", kind="object_detection",
                  description="Laptop detected at Desk 2 with the lid open.",
                  observed_at=datetime(2026, 11, 8, 14, 1, 5, tzinfo=timezone.utc),
                  confidence=0.91, is_fixture=True),
]

_INCIDENT = IncidentContext(
    incident_id=FIXTURE_ALERT.incident_id,
    title=FIXTURE_ALERT.title,
    status="open",
    primary_asset_id=FIXTURE_ALERT.asset_id,
    alert_ids=[FIXTURE_ALERT.alert_id],
    severity=FIXTURE_ALERT.severity,
    opened_at=_OCCURRED,
    response_status="none",
    is_fixture=True,
)


class IncidentDataSource(Protocol):
    """The read interface a SpacetimeDB-backed client will implement."""

    def get_security_events(
        self, alert_id: str, limit: int
    ) -> tuple[list[SecurityEvent], list[Evidence]]: ...

    def get_incident_context(self, incident_id: str) -> IncidentContext | None: ...

    def get_related_assets(self, asset_id: str) -> list[RelatedAsset]: ...

    def get_cv_observations(self, asset_id: str) -> list[CvObservation]: ...

    def get_data_scope(self, asset_id: str) -> DataScope | None: ...


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

    def get_incident_context(self, incident_id: str) -> IncidentContext | None:
        return _INCIDENT if incident_id == _INCIDENT.incident_id else None

    def get_related_assets(self, asset_id: str) -> list[RelatedAsset]:
        """Assets within two hops, nearest first. Unknown assets return an empty list."""
        if asset_id not in _ASSETS:
            return []
        found: list[RelatedAsset] = []
        seen = {asset_id}
        frontier = [asset_id]
        for hops in (1, 2):
            next_frontier: list[str] = []
            for node in frontier:
                for source, relation, target in _EDGES:
                    if node not in (source, target):
                        continue
                    other = target if node == source else source
                    if other in seen:
                        continue
                    seen.add(other)
                    next_frontier.append(other)
                    found.append(
                        RelatedAsset(
                            asset=_ASSETS[other],
                            relation=relation,
                            direction="outbound" if node == source else "inbound",
                            hops=hops,
                        )
                    )
            frontier = next_frontier
        return found

    def get_cv_observations(self, asset_id: str) -> list[CvObservation]:
        return [o for o in _CV_OBSERVATIONS if o.asset_id == asset_id]

    def get_data_scope(self, asset_id: str) -> DataScope | None:
        return _DATA_SCOPES.get(asset_id)


_SCENARIO_T0 = datetime(2026, 11, 8, 14, 0, 0, tzinfo=timezone.utc)

# (step, title, objective, judging principle,
#  [(event_type, severity, minute, details, description)])
_SCENARIO_STAGES = [
    (
        "triage",
        "Something changed",
        "Establish what is happening and keep the facts intact before anything is altered.",
        "Capturing volatile evidence comes before changing the system. Doing nothing is not "
        "acceptable when there are signs of active compromise.",
        [
            ("file_modified", "medium", 2,
             {"path": "/Users/demo/blacksite-monitored/canary.txt", "process": "unknown"},
             "File-integrity record: a monitored file was modified by an unidentified process."),
            ("outbound_connection", "high", 3,
             {"destination": "203.0.113.42:443", "process": "unknown", "bytesSent": "48211"},
             "Network record: the same process opened an outbound connection to an unfamiliar host."),
        ],
    ),
    (
        "contain",
        "It is spreading",
        "Stop the spread to other systems while limiting disruption to the team.",
        "Stopping active spread comes first, even at high simulated disruption. Only among "
        "actions that actually stop it should the less disruptive one be preferred. "
        "Observing or collecting evidence does not stop spread.",
        [
            ("smb_write_burst", "critical", 11,
             {"share": "nas-1:/projects", "filesWritten": "812", "source": "{asset}"},
             "File-server log: a rapid burst of writes to the shared drive from this laptop."),
            ("file_renamed", "high", 12,
             {"pattern": "*.lockd", "count": "640", "location": "nas-1:/projects"},
             "File-server log: hundreds of shared files renamed with an unfamiliar extension."),
        ],
    ),
    (
        "recover",
        "Getting back safely",
        "Return to normal operation without letting the attacker back in.",
        "Close the attacker's access before restoring data. Credentials known to be misused "
        "must be dealt with first, or restored systems can be compromised again.",
        [
            ("backup_verified", "low", 34,
             {"snapshot": "nas-1:daily-0600", "status": "clean", "ageHours": "8"},
             "Backup report: a snapshot from before the first event passes integrity checks."),
            ("credential_reuse", "high", 36,
             {"account": "svc-backup", "target": "router-1", "result": "login_succeeded"},
             "Authentication log: an account used on the affected laptop logged in to the router."),
        ],
    ),
]


def build_scenario(alert: Alert, run_token: str) -> Scenario:
    """A scripted ransomware-style training attack on the alert's asset."""
    steps = []
    number = 0
    for step_id, title, objective, principle, stage_events in _SCENARIO_STAGES:
        events, evidence = [], []
        for event_type, severity, minute, details, description in stage_events:
            number += 1
            occurred = _SCENARIO_T0 + timedelta(minutes=minute)
            event = SecurityEvent(
                event_id=f"event-{run_token}-{number}",
                alert_id=alert.alert_id,
                incident_id=alert.incident_id,
                asset_id=alert.asset_id,
                event_type=event_type,
                severity=severity,
                occurred_at=occurred,
                source="training-scenario",
                details={k: v.format(asset=alert.asset_id) for k, v in details.items()},
                is_fixture=True,
            )
            events.append(event)
            evidence.append(
                Evidence(
                    evidence_id=f"evidence-{run_token}-{number}",
                    incident_id=alert.incident_id,
                    asset_id=alert.asset_id,
                    event_ids=[event.event_id],
                    kind=event_type,
                    description=description,
                    collected_at=occurred + timedelta(seconds=30),
                    is_fixture=True,
                )
            )
        steps.append(
            ScenarioStep(
                step_id=step_id,
                title=title,
                objective=objective,
                judging_principle=principle,
                events=events,
                evidence=evidence,
            )
        )
    return Scenario(
        scenario_id="ransomware-precursor",
        title="Ransomware outbreak drill",
        alert_id=alert.alert_id,
        incident_id=alert.incident_id,
        target_asset_id=alert.asset_id,
        steps=steps,
    )


class ScenarioDataSource(FixtureDataSource):
    """Reveals only the evidence of the steps reached so far."""

    def __init__(self, scenario: Scenario, run_token: str) -> None:
        super().__init__(run_token)
        self.scenario = scenario
        self.current_step_index = 0

    def get_security_events(
        self, alert_id: str, limit: int
    ) -> tuple[list[SecurityEvent], list[Evidence]]:
        if alert_id != self.scenario.alert_id:
            return [], []
        revealed = self.scenario.steps[: self.current_step_index + 1]
        events = [e for step in revealed for e in step.events]
        evidence = [e for step in revealed for e in step.evidence]
        return events[:limit], evidence

    def get_incident_context(self, incident_id: str) -> IncidentContext | None:
        if incident_id != self.scenario.incident_id:
            return None
        return IncidentContext(
            incident_id=incident_id,
            title=self.scenario.title,
            status="open",
            primary_asset_id=self.scenario.target_asset_id,
            alert_ids=[self.scenario.alert_id],
            severity="high",
            opened_at=_SCENARIO_T0,
            response_status="none",
            is_fixture=True,
        )
