import json

import pytest

from blacksite_agent.fixtures import FixtureDataSource
from blacksite_agent.tools import ToolContext, build_registry

ALLOWED = ("simulate_response",)


def run(args: dict, ctx: ToolContext | None = None):
    ctx = ctx or ToolContext(data=FixtureDataSource("test"))
    out = build_registry().execute("simulate_response", json.dumps(args), ALLOWED, ctx)
    return out, ctx


@pytest.mark.parametrize("strategy", ["immediate_isolation", "staged_failover_then_isolation"])
def test_both_strategies(strategy):
    out, ctx = run({"strategy": strategy, "target_asset_id": "laptop-b"})
    assert out.ok
    body = json.loads(out.content)
    sim = body["simulation"]
    assert sim["strategy"] == strategy
    assert sim["assetsAffected"] == ["laptop-b", "nas-1"]
    assert sim["isSimulated"] is True
    assert "No action was taken" in body["notice"]
    assert ctx.simulated_outcomes[strategy].strategy == strategy
    assert not any("could not be looked up" in a for a in sim["assumptions"])


def test_strategies_differ():
    a, _ = run({"strategy": "immediate_isolation", "target_asset_id": "laptop-b"})
    b, _ = run({"strategy": "staged_failover_then_isolation", "target_asset_id": "laptop-b"})
    sa, sb = json.loads(a.content)["simulation"], json.loads(b.content)["simulation"]
    assert sa["responseTimeMinutes"] < sb["responseTimeMinutes"]


def test_invalid_strategy():
    out, ctx = run({"strategy": "wipe_everything", "target_asset_id": "laptop-b"})
    assert not out.ok and ctx.simulated_outcomes == {}


def test_invalid_asset_pattern():
    out, _ = run({"strategy": "immediate_isolation", "target_asset_id": "../etc"})
    assert not out.ok


def test_unknown_asset():
    out, ctx = run({"strategy": "immediate_isolation", "target_asset_id": "ghost-9"})
    assert not out.ok and "ghost-9" in json.loads(out.content)["error"]
    assert ctx.simulated_outcomes == {}


def test_extra_args_rejected():
    out, _ = run({"strategy": "immediate_isolation", "target_asset_id": "laptop-b", "limit": 5})
    assert not out.ok


def test_deterministic():
    args = {"strategy": "staged_failover_then_isolation", "target_asset_id": "laptop-b"}
    assert run(args)[0].content == run(args)[0].content
