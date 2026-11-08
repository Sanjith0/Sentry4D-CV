/**
 * OWNED BY JASON — integration stub.
 * Replace this file with the real implementation (people, X-ray, chair, Sentry Mode).
 * Contract: see SceneActorsProps in src/types/security.ts.
 *
 * Store integration points (import { useReplayStore } from "../../store/useReplayStore"):
 *   - useReplayStore.getState().setEvents(events)          → timeline markers + incident panel
 *   - useReplayStore.getState().setActiveSubjectCount(n)    → header subject counter
 *   - useReplayStore.getState().setSelectedEntity(info)     → incident panel details
 *   - useReplayStore.getState().currentTime                 → per-frame reads inside useFrame
 */
import type { SceneActorsProps } from "../../types/security";

export function SceneActors(_props: SceneActorsProps) {
  return null;
}

export default SceneActors;
