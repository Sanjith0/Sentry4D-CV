/**
 * Vercel serverless entry for the AI Investigator (same agent as the dev-server middleware).
 * NVIDIA_API_KEY / NVIDIA_MODEL / NVIDIA_FALLBACK_MODEL / NVIDIA_BASE_URL come from Vercel env vars (server-side only).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { investigatorMiddleware } from "../investigator.ts";
import * as trajectory from "../../src/features/sentry/trajectory.ts";
import * as evidence from "../../src/features/sentry/evidence.ts";
import * as subjects from "../../src/config/subjects.ts";
import * as incident from "../../src/config/incident.ts";
import * as cameras from "../../src/config/cameras.ts";
import * as roomConfig from "../../src/config/roomConfig.ts";
import poses from "../../src/config/camera-poses.json" with { type: "json" };
import sync from "../../src/config/camera-sync.json" with { type: "json" };
import annotations from "../../src/data/person-annotations.json" with { type: "json" };
import carried from "../../experiments/reconstruction/review/clip02-carried.json" with { type: "json" };

const MODULES: Record<string, Record<string, unknown>> = {
  "/src/features/sentry/trajectory.ts": trajectory,
  "/src/features/sentry/evidence.ts": evidence,
  "/src/config/subjects.ts": subjects,
  "/src/config/incident.ts": incident,
  "/src/config/cameras.ts": cameras,
  "/src/config/roomConfig.ts": roomConfig,
};
const JSONS: Record<string, unknown> = {
  "src/config/camera-poses.json": poses,
  "src/config/camera-sync.json": sync,
  "src/data/person-annotations.json": annotations,
  "experiments/reconstruction/review/clip02-carried.json": carried,
};

const handler = investigatorMiddleware({
  root: process.cwd(),
  load: async (id) => {
    const m = MODULES[id];
    if (!m) throw new Error(`module not bundled: ${id}`);
    return m;
  },
  readJson: (p) => JSONS[p] ?? null,
  env: process.env,
});

export const config = { maxDuration: 300 };

export default function (req: IncomingMessage, res: ServerResponse) {
  return handler(req, res, () => {
    res.statusCode = 404;
    res.end();
  });
}
