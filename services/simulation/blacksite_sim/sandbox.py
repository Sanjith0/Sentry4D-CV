"""Deterministic response sandbox. Pure function: no I/O, clock, randomness, or real action.

All numbers below are illustrative scenario assumptions, not validated predictions.
"""

from dataclasses import dataclass

STRATEGIES = ("immediate_isolation", "staged_failover_then_isolation")
LEVELS = ("low", "medium", "high")
RELATIONS = ("connects_via", "shares_files_with", "backs_up_to")
# Relations where the neighbour depends on the target and loses service when it is cut off.
DEPENDENCY_RELATIONS = ("shares_files_with", "backs_up_to")

CRITICALITY_SCORE = {"low": 0, "medium": 1, "high": 2}

# Scoring table. Disruption score = target criticality + per-dependent cost (immediate)
# or + a fixed cutover blip when dependents exist (staged). Thresholds map score -> level.
SCORING = {
    "immediate_isolation": {
        "base_minutes": 5, "minutes_per_dependent": 2,
        "dependent_disruption": 1,       # plus the dependent's criticality score
        "cutover_disruption": 0,
        "base_recovery_steps": 1, "recovery_steps_per_dependent": 1,
    },
    "staged_failover_then_isolation": {
        "base_minutes": 20, "minutes_per_dependent": 10,
        "dependent_disruption": 0,
        "cutover_disruption": 1,         # applied only when there are dependents
        "base_recovery_steps": 3, "recovery_steps_per_dependent": 1,
    },
}
DISRUPTION_THRESHOLDS = (1, 3)  # score <=1 low, <=3 medium, else high
RECOVERY_THRESHOLDS = (2, 4)    # steps <=2 low, <=4 medium, else high


@dataclass(frozen=True)
class Neighbour:
    asset_id: str
    criticality: str
    relation: str
    hops: int

    def __post_init__(self) -> None:
        if self.criticality not in LEVELS:
            raise ValueError(f"invalid criticality: {self.criticality!r}")
        if self.relation not in RELATIONS:
            raise ValueError(f"invalid relation: {self.relation!r}")
        if self.hops not in (1, 2):
            raise ValueError(f"invalid hops: {self.hops!r}")


@dataclass(frozen=True)
class SimulationResult:
    strategy: str
    service_disruption: str
    assets_affected: list[str]
    recovery_complexity: str
    response_time_minutes: int
    assumptions: list[str]


def _level(value: int, thresholds: tuple[int, int]) -> str:
    return LEVELS[0 if value <= thresholds[0] else 1 if value <= thresholds[1] else 2]


def simulate(
    strategy: str,
    target_asset_id: str,
    target_criticality: str,
    neighbours: list[Neighbour],
) -> SimulationResult:
    if strategy not in SCORING:
        raise ValueError(f"unknown strategy: {strategy!r}")
    if target_criticality not in LEVELS:
        raise ValueError(f"invalid target criticality: {target_criticality!r}")
    table = SCORING[strategy]

    dependents: dict[str, Neighbour] = {
        n.asset_id: n
        for n in neighbours
        if n.hops == 1 and n.relation in DEPENDENCY_RELATIONS and n.asset_id != target_asset_id
    }
    count = len(dependents)

    disruption = CRITICALITY_SCORE[target_criticality]
    disruption += sum(
        table["dependent_disruption"] + CRITICALITY_SCORE[d.criticality]
        for d in dependents.values()
        if table["dependent_disruption"]
    )
    if count:
        disruption += table["cutover_disruption"]

    steps = table["base_recovery_steps"] + table["recovery_steps_per_dependent"] * count
    minutes = table["base_minutes"] + table["minutes_per_dependent"] * count

    if strategy == "immediate_isolation":
        behaviour = (
            "Assumes the target is isolated at once, cutting off hop-1 dependents "
            "(shares_files_with, backs_up_to) immediately."
        )
    else:
        behaviour = (
            "Assumes hop-1 dependents are failed over first, then the target is isolated; "
            "slower, with more recovery steps."
        )
    assumptions = [
        "Numbers are illustrative scenario assumptions, not validated predictions.",
        behaviour,
        f"{count} dependent asset(s) at hop 1 counted for target {target_asset_id}.",
    ]
    return SimulationResult(
        strategy=strategy,
        service_disruption=_level(disruption, DISRUPTION_THRESHOLDS),
        assets_affected=sorted({target_asset_id, *dependents}),
        recovery_complexity=_level(steps, RECOVERY_THRESHOLDS),
        response_time_minutes=minutes,
        assumptions=assumptions,
    )
