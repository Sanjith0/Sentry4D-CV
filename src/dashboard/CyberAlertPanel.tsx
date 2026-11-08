import { ShieldAlert, Wifi, WifiOff, X } from "lucide-react";
import { getDevice } from "../config/devices";
import { selectOption } from "../features/devices/useCyberAlertSocket";
import { useCyberAlertStore, type OptionId } from "../features/devices/useCyberAlertStore";

const STAGE_LABEL: Record<string, string> = {
  alert: "ALERT",
  investigating: "INVESTIGATING",
  resolved: "RESOLVED",
};

/**
 * The gamified response guide: shows the current scenario step from the
 * BLACKSITE agent-worker (triage → contain → recover), lets the learner pick
 * one of four AI-judged options, and shows the result/consequence before
 * advancing. Opens automatically when a session starts (useCyberAlertStore).
 */
export function CyberAlertPanel() {
  const connected = useCyberAlertStore((s) => s.connected);
  const activeSessionId = useCyberAlertStore((s) => s.activeSessionId);
  const session = useCyberAlertStore((s) => (activeSessionId ? s.sessions[activeSessionId] : null));
  const openSession = useCyberAlertStore((s) => s.openSession);
  const lastError = useCyberAlertStore((s) => s.lastError);

  if (!activeSessionId || !session) return null;
  const device = getDevice(session.deviceId);
  const { summary, step, lastResult, debrief, tried } = session;
  const stage = summary.status === "complete" ? "resolved" : summary.currentStepIndex > 0 ? "investigating" : "alert";
  const tone = stage === "resolved" ? "border-emerald-400/60" : stage === "investigating" ? "border-amber-400/60" : "border-red-500/60";

  const choose = (optionId: OptionId) => {
    if (!step || tried.includes(optionId)) return;
    selectOption(activeSessionId, step.stepId, tried.length + 1, optionId);
  };

  return (
    <div
      className={`glass pointer-events-auto absolute top-16 right-3 z-10 max-h-[calc(100%-5rem)] w-[340px] overflow-y-auto rounded-lg !${tone} p-2.5 font-mono text-[11px] fade-in`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <ShieldAlert className="h-3.5 w-3.5 text-red-300" />
        <span className="label !text-slate-300">
          CYBER ALERT · {device?.name ?? session.deviceId ?? "UNKNOWN DEVICE"}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[9px] text-slate-500">
          {connected ? <Wifi className="h-3 w-3 text-emerald-400" /> : <WifiOff className="h-3 w-3 text-red-400" />}
        </span>
        <button type="button" title="Close" onClick={() => openSession(null)} className="text-slate-400 hover:text-slate-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-1.5 flex items-center justify-between text-[10px] text-slate-400">
        <span>{summary.scenarioTitle}</span>
        <span className="text-slate-300">{STAGE_LABEL[stage]} · SCORE {summary.score}</span>
      </div>

      {step && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-slate-500">
            STEP {step.stepNumber}/{step.totalSteps} · {step.title.toUpperCase()}
          </div>
          <div className="leading-snug text-slate-200">{step.narrative}</div>
          <div className="leading-snug text-cyan-200">{step.leadingQuestion}</div>
          <div className="space-y-1 pt-1">
            {step.options.map((o) => {
              const isTried = tried.includes(o.optionId);
              const isLastChoice = lastResult?.selection.optionId === o.optionId;
              const outcome = isLastChoice ? (lastResult!.correct ? "correct" : "wrong") : null;
              return (
                <button
                  key={o.optionId}
                  type="button"
                  disabled={isTried || summary.status === "complete"}
                  onClick={() => choose(o.optionId)}
                  className={`flex w-full items-start gap-2 rounded border px-2 py-1 text-left leading-snug disabled:opacity-60 ${
                    outcome === "correct"
                      ? "border-emerald-400/70 bg-emerald-400/10 text-emerald-100"
                      : outcome === "wrong"
                        ? "border-red-500/70 bg-red-500/10 text-red-100"
                        : isTried
                          ? "border-ink-600 text-slate-500"
                          : "border-ink-500 text-slate-200 hover:border-cyan-400/70 hover:text-cyan-100"
                  }`}
                >
                  <span className="font-semibold">{o.optionId}</span>
                  <span>{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {lastResult && (
        <div className="mt-2 space-y-0.5 border-t border-ink-600 pt-1.5 text-[10px] leading-snug text-slate-300">
          <div>{lastResult.explanation}</div>
          {lastResult.hint && <div className="text-amber-200">Hint: {lastResult.hint}</div>}
          <div className="text-slate-500">
            Simulated: {lastResult.consequence.serviceDisruption} disruption, {lastResult.consequence.responseTimeMinutes} min, affected{" "}
            {lastResult.consequence.assetsAffected.join(", ")}
          </div>
        </div>
      )}

      {debrief && (
        <div className="mt-2 space-y-1 border-t border-ink-600 pt-1.5 text-[10px] leading-snug">
          <div className="font-semibold text-slate-200">TRAINING COMPLETE</div>
          <div className="text-slate-300">{debrief.summary}</div>
          {debrief.strengths.length > 0 && <div className="text-emerald-300">+ {debrief.strengths.join(" · ")}</div>}
          {debrief.improvements.length > 0 && <div className="text-amber-300">→ {debrief.improvements.join(" · ")}</div>}
        </div>
      )}

      {lastError && <div className="mt-1.5 text-[10px] text-red-300">{lastError}</div>}
    </div>
  );
}
