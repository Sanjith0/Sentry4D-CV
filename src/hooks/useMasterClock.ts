import { useEffect } from "react";
import { useReplayStore } from "../store/useReplayStore";

/** The single master clock. Videos and scene entities follow `currentTime`; nothing else drives it. */
export function useMasterClock() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1); // clamp after tab switches
      last = now;
      useReplayStore.getState().tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
