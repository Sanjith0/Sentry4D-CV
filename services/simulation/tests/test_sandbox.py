import pytest

from blacksite_sim.sandbox import Neighbour, SimulationResult, simulate

LEVEL_ORDER = {"low": 0, "medium": 1, "high": 2}
NEIGHBOURS = [
    Neighbour("router-1", "high", "connects_via", 1),
    Neighbour("nas-1", "high", "shares_files_with", 1),
    Neighbour("laptop-a", "low", "connects_via", 2),
]


def test_strategies_differ_for_target_with_dependents():
    imm = simulate("immediate_isolation", "laptop-b", "medium", NEIGHBOURS)
    staged = simulate("staged_failover_then_isolation", "laptop-b", "medium", NEIGHBOURS)
    assert imm.response_time_minutes < staged.response_time_minutes
    assert LEVEL_ORDER[imm.service_disruption] >= LEVEL_ORDER[staged.service_disruption]
    assert LEVEL_ORDER[imm.service_disruption] > LEVEL_ORDER[staged.service_disruption]
    assert LEVEL_ORDER[imm.recovery_complexity] <= LEVEL_ORDER[staged.recovery_complexity]


def test_assets_affected_sorted_with_target_and_only_dependents():
    res = simulate("immediate_isolation", "laptop-b", "medium", NEIGHBOURS)
    assert res.assets_affected == ["laptop-b", "nas-1"]


def test_no_dependents():
    res = simulate("immediate_isolation", "camera-1", "low", [Neighbour("router-1", "high", "connects_via", 1)])
    assert res.assets_affected == ["camera-1"]
    assert res.service_disruption == "low"


def test_assumptions_disclaimer_and_determinism():
    a = simulate("staged_failover_then_isolation", "laptop-b", "medium", NEIGHBOURS)
    b = simulate("staged_failover_then_isolation", "laptop-b", "medium", list(NEIGHBOURS))
    assert a == b and isinstance(a, SimulationResult)
    assert a.assumptions and any("illustrative" in s and "not validated" in s for s in a.assumptions)


def test_result_is_frozen():
    res = simulate("immediate_isolation", "x", "low", [])
    with pytest.raises(Exception):
        res.strategy = "other"  # type: ignore[misc]


@pytest.mark.parametrize("args", [
    ("bogus", "x", "low", []),
    ("immediate_isolation", "x", "extreme", []),
])
def test_invalid_inputs_raise(args):
    with pytest.raises(ValueError):
        simulate(*args)


@pytest.mark.parametrize("kw", [
    dict(criticality="bad", relation="connects_via", hops=1),
    dict(criticality="low", relation="bad", hops=1),
    dict(criticality="low", relation="connects_via", hops=3),
])
def test_invalid_neighbour_raises(kw):
    with pytest.raises(ValueError):
        Neighbour("a", **kw)
