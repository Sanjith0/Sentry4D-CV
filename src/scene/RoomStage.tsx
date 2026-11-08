import { Suspense, useCallback, useEffect } from "react";
import { roomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import { ErrorBoundary } from "../lib/ErrorBoundary";
import type { RoomBounds } from "../types/security";
import { ProceduralRoom } from "./ProceduralRoom";
import { RoomModel } from "./RoomModel";

/** Probes for room.glb; loads it when present, otherwise renders the procedural placeholder. */
export function RoomStage() {
  const status = useViewStore((s) => s.roomStatus);
  const setRoomStatus = useViewStore((s) => s.setRoomStatus);
  const setRoomBounds = useViewStore((s) => s.setRoomBounds);

  useEffect(() => {
    let cancelled = false;
    fetch(roomConfig.url, { method: "HEAD" })
      .then((r) => {
        const type = r.headers.get("content-type") ?? "";
        // Dev servers may answer missing files with index.html.
        const present = r.ok && !type.includes("text/html");
        if (!cancelled) setRoomStatus(present ? "loading" : "missing");
      })
      .catch(() => !cancelled && setRoomStatus("missing"));
    return () => {
      cancelled = true;
    };
  }, [setRoomStatus]);

  const onLoaded = useCallback(
    (b: RoomBounds) => {
      setRoomBounds(b);
      setRoomStatus("loaded");
    },
    [setRoomBounds, setRoomStatus],
  );

  if (status === "checking") return null;
  if (status === "missing") return <ProceduralRoom />;

  return (
    <ErrorBoundary fallback={<ProceduralRoom />} onError={(e) => setRoomStatus("error", e.message)}>
      <Suspense fallback={null}>
        <RoomModel onLoaded={onLoaded} />
      </Suspense>
    </ErrorBoundary>
  );
}
