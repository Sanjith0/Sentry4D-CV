import { useEffect } from "react";
import { securityCameras } from "../config/cameras";
import { useMasterClock } from "../hooks/useMasterClock";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { Scene3D } from "../scene/Scene3D";
import { Header } from "../dashboard/Header";
import { CCTVPanel } from "../dashboard/CCTVPanel";
import { ReplayTimeline } from "../dashboard/ReplayTimeline";
import { ViewportHud } from "../dashboard/ViewerToolbar";
import { LoadingOverlay } from "../dashboard/LoadingOverlay";
import { EnlargedFeed } from "../dashboard/EnlargedFeed";
import { CameraSyncPanel } from "../dashboard/CameraSyncPanel";
import { AnnotationPanel } from "../features/annotation/AnnotationPanel";
import { useEvidenceSync } from "../features/sentry/useEvidence";
import { EvidencePanel } from "../features/sentry/EvidencePanel";
import { InvestigatorPanel } from "../features/investigator/InvestigatorPanel";
import { DemoOverlay } from "../features/demo/DemoOverlay";
import { DemoWall } from "../features/demo/DemoWall";
import { useDemoStore } from "../features/demo/useDemoStore";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The demo walkthrough owns the viewer while it runs: Escape leaves it, nothing else gets through.
      if (useDemoStore.getState().phase !== "idle") {
        if (e.code === "Escape") useDemoStore.getState().stop();
        if (!e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Escape") {
        const v = useViewStore.getState();
        if (v.syncPanelOpen) v.setSyncPanelOpen(false);
        else if (v.focusedFeedId) v.setFocusedFeed(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const r = useReplayStore.getState();
      const v = useViewStore.getState();
      const free = r.cameraMode === "free";
      switch (e.code) {
        case "KeyK":
          r.togglePlay();
          break;
        case "Space":
          if (!free) {
            e.preventDefault();
            r.togglePlay();
          }
          break;
        case "ArrowLeft":
          r.seek(r.currentTime - (e.shiftKey ? 1 : 5));
          break;
        case "ArrowRight":
          r.seek(r.currentTime + (e.shiftKey ? 1 : 5));
          break;
        case "Digit1":
        case "Digit2":
        case "Digit3":
        case "Digit4": {
          const cam = securityCameras[Number(e.code.slice(-1)) - 1];
          if (cam) r.viewThroughCamera(cam.id);
          break;
        }
        case "KeyF":
          r.setCameraMode("free");
          break;
        case "KeyO":
          r.setCameraMode("orbit");
          break;
        case "KeyT":
          r.setCameraMode("topdown");
          break;
        case "KeyR":
          v.resetView();
          break;
        case "KeyX":
          r.toggleXray();
          break;
        case "KeyM":
          r.toggleSentry();
          break;
        case "KeyC":
          v.toggleCoverage();
          break;
        case "KeyH":
          v.toggleCeiling();
          break;
        case "KeyG":
          v.toggleCleanWindows();
          break;
        case "KeyL":
          v.toggleWireframe();
          break;
        case "KeyY":
          v.setSyncPanelOpen(!v.syncPanelOpen);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

if (import.meta.env.DEV) {
  // Debug handle for teammates: window.__sentry.replay.getState() etc.
  Promise.all([
    import("../scene/viewportCamera"),
    import("../lib/videoProjection"),
    import("../features/annotation/useAnnotationStore"),
    import("../features/sentry/trajectory"),
    import("../lib/videoRegistry"),
    import("../features/reconstruction/useAppearanceStore"),
    import("../features/reconstruction/useAvatarStore"),
  ]).then(([{ viewport }, projection, { useAnnotationStore }, trajectory, registry, { useAppearanceStore }, { useAvatarStore }]) => {
    (window as unknown as Record<string, unknown>).__sentry = {
      replay: useReplayStore,
      view: useViewStore,
      viewport,
      projection,
      annotations: useAnnotationStore,
      trajectory,
      registry,
      appearance: useAppearanceStore,
      avatar: useAvatarStore,
    };
  });
}

export default function App() {
  useMasterClock();
  useShortcuts();
  useEvidenceSync();
  const annotating = useViewStore((s) => s.annotating);
  const demo = useDemoStore((s) => s.phase !== "idle");
  // sentry4d.vercel.app/?demo starts the walkthrough by itself (for screen recordings and shared links)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("demo")) useDemoStore.getState().start();
  }, []);
  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        {annotating && <AnnotationPanel />}
        {/* The demo walkthrough takes the whole window: the viewport grows over the panels (which stay
            mounted underneath: the four recordings keep playing there) and gets the demo's own overlay. */}
        <main className={demo ? "fixed inset-0 z-[80] bg-ink-950" : "relative min-w-0 flex-1 bg-ink-950"}>
          <Scene3D />
          {!demo && <ViewportHud />}
          {!annotating && !demo && <EvidencePanel />}
          <LoadingOverlay />
          {!demo && <EnlargedFeed />}
          {!demo && <CameraSyncPanel />}
          {demo && <DemoWall />}
          {demo && <DemoOverlay />}
        </main>
        <InvestigatorPanel />
        <CCTVPanel />
      </div>
      <ReplayTimeline />
    </div>
  );
}
