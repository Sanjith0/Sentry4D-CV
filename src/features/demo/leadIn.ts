import { securityCameras } from "../../config/cameras";
import { videoRegistry } from "../../lib/videoRegistry";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";

/**
 * The wall's lead-in (DemoScript.LEAD_IN): it opens on earlier footage than the clock's own. A second player
 * per recording shows that footage, so nothing is asked of the recordings themselves: they play on the
 * clock's time from before the first frame, out of sight, and are simply there when the wall goes over to
 * them. (One player for both would have to jump from the one footage to the other, and a player that jumps
 * stands still while it finds its frame.)
 *
 * All four or none: outside the sweep that takes it from the one footage to the other, the wall never shows
 * two different moments side by side. A player that cannot play, or stops, closes all of them, and the wall
 * shows the recordings' own pictures from then on.
 */
interface Player {
  video: HTMLVideoElement;
  /** Time in its recording (s) it was last put on. */
  put: number;
  /** Its time when it was last seen to have moved, and performance.now() then. */
  moved: number;
  movedAt: number;
}
const players = new Map<CameraId, Player>();
let holder: HTMLDivElement | null = null;
/** Counts the sets of players made: what a closed set still reports (a play() refused late) is not the next one's. */
let generation = 0;

/** A player that plays but has not moved for this long (s) has stopped. */
const STALLED = 0.4;

const offsetOf = (id: CameraId) => useReplayStore.getState().cameraOffsets[id] ?? 0;

/** Makes the players and parks them on incident time T. False (and none made) if a recording cannot be played there. */
export function openLeadIn(T: number): boolean {
  closeLeadIn();
  const mine = generation;
  const failed = () => {
    if (generation === mine) closeLeadIn();
  };
  // (in the page, out of sight: like the recordings' own players, which the wall draws from the same way)
  holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;";
  for (const cam of securityCameras.slice(0, 4)) {
    const main = videoRegistry.get(cam.id);
    const src = main?.currentSrc || main?.src;
    const at = T + offsetOf(cam.id);
    if (!main || !src || main.error || at < 0 || (Number.isFinite(main.duration) && at > main.duration - 0.5)) {
      closeLeadIn();
      return false;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.disablePictureInPicture = true;
    video.style.cssText = "display:block;width:2px;height:2px;";
    if (main.crossOrigin !== null) video.crossOrigin = main.crossOrigin;
    video.addEventListener("error", failed);
    video.addEventListener("loadedmetadata", () => {
      const p = players.get(cam.id);
      if (p?.video !== video) return;
      if (p.put > video.duration - 0.5) closeLeadIn();
      else if (Math.abs(video.currentTime - p.put) > 0.01) video.currentTime = p.put;
    });
    video.src = src;
    video.currentTime = at; // (before its metadata is in: where it starts from)
    players.set(cam.id, { video, put: at, moved: at, movedAt: 0 });
    holder.appendChild(video);
  }
  document.body.appendChild(holder);
  return true;
}

export const leadInOpen = () => players.size > 0;

/** Every player has the frame it was put on. (True with no players: there is nothing to wait for.) */
export function leadInSettled(): boolean {
  for (const { video, put } of players.values()) {
    if (video.seeking || video.readyState < 2 || Math.abs(video.currentTime - put) > 0.045) return false;
  }
  return true;
}

export function playLeadIn() {
  const now = performance.now();
  const mine = generation;
  for (const p of [...players.values()]) {
    p.moved = p.video.currentTime;
    p.movedAt = now;
    void p.video.play().catch(() => {
      if (generation === mine) closeLeadIn();
    });
  }
}

/** They all play, and have come between `min` and `max` seconds from where they were parked. */
export function leadInRolling(min: number, max: number): boolean {
  if (players.size === 0) return false;
  for (const { video, put } of players.values()) {
    const come = video.currentTime - put;
    if (video.error || video.paused || video.ended || video.seeking || video.readyState < 2 || come < min || come > max) return false;
  }
  return true;
}

/** While they play: one of them has stopped, or has no picture. */
export function leadInFaltered(): boolean {
  const now = performance.now();
  for (const p of players.values()) {
    const v = p.video;
    if (v.error || v.paused || v.ended || v.seeking || v.readyState < 2) return true;
    if (v.currentTime !== p.moved) {
      p.moved = v.currentTime;
      p.movedAt = now;
    } else if (now - p.movedAt > STALLED * 1000) return true;
  }
  return false;
}

/** Stepped: every player on the exact frame of incident time T. */
export function stepLeadIn(T: number) {
  for (const [id, p] of players) {
    if (!p.video.paused) p.video.pause();
    const at = T + offsetOf(id);
    if (p.put !== at) {
      p.put = at;
      p.video.currentTime = at;
    }
  }
}

/** The lead-in's picture of this camera, if it has one to show. */
export function leadInPicture(id: CameraId): HTMLVideoElement | undefined {
  const v = players.get(id)?.video;
  return v && v.videoWidth > 0 && v.readyState >= 2 && !v.seeking ? v : undefined;
}

export function closeLeadIn() {
  generation++;
  for (const { video } of players.values()) {
    video.pause();
    video.removeAttribute("src");
    video.load(); // (lets go of its decoder now, not when it is collected)
  }
  players.clear();
  holder?.remove();
  holder = null;
}

/** Dev / recording handle: per camera [incident time its player is on, paused, seeking, readyState]; null: no player. */
export function leadInState() {
  return securityCameras.slice(0, 4).map((cam) => {
    const v = players.get(cam.id)?.video;
    return v ? [v.currentTime - offsetOf(cam.id), v.paused ? 1 : 0, v.seeking ? 1 : 0, v.readyState] : null;
  });
}
