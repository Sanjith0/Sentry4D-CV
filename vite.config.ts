import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { investigatorMiddleware } from "./server/investigator.ts";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const CAMERA_IDS = ["cam1", "cam2", "cam3", "cam4"];
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whitelisted config files the app may rewrite in dev, with validation. */
const CONFIGS: Record<string, { file: string; validate: (d: unknown) => void }> = {
  "camera-poses": {
    file: "src/config/camera-poses.json",
    validate(d) {
      const o = d as Record<string, Record<string, unknown>>;
      for (const id of CAMERA_IDS) {
        const p = o?.[id];
        if (!p) throw new Error(`missing ${id}`);
        const pos = p.position as unknown[];
        if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) throw new Error(`${id}.position invalid`);
        for (const k of ["yaw", "pitch", "roll", "fov"]) if (!isNum(p[k])) throw new Error(`${id}.${k} invalid`);
        if ((p.fov as number) < 5 || (p.fov as number) > 150) throw new Error(`${id}.fov out of range`);
      }
      if (Object.keys(o).some((k) => !CAMERA_IDS.includes(k))) throw new Error("unknown camera id");
    },
  },
  "person-annotations": {
    file: "src/data/person-annotations.json",
    validate(d) {
      const o = d as { version?: unknown; datasets?: unknown; syncOffsets?: Record<string, unknown> };
      if (o?.syncOffsets !== undefined && !CAMERA_IDS.every((id) => isNum(o.syncOffsets?.[id]))) throw new Error("syncOffsets invalid");
      if (o?.version !== 1 || !Array.isArray(o.datasets)) throw new Error("expected {version: 1, datasets: [...]}");
      for (const ds of o.datasets as Record<string, unknown>[]) {
        if (typeof ds?.personId !== "string" || !Array.isArray(ds.observations)) throw new Error("dataset needs personId + observations");
        for (const ob of ds.observations as Record<string, unknown>[]) {
          if (!isNum(ob?.masterTime) || !CAMERA_IDS.includes(ob.cameraId as string)) throw new Error("observation needs masterTime + valid cameraId");
          const px = ob.pixel as unknown[];
          const wp = ob.worldPosition as unknown[];
          if (!Array.isArray(px) || px.length !== 2 || !px.every(isNum)) throw new Error("observation.pixel invalid");
          if (!Array.isArray(wp) || wp.length !== 3 || !wp.every(isNum)) throw new Error("observation.worldPosition invalid");
        }
        if (ds.visibility !== undefined) {
          if (!Array.isArray(ds.visibility)) throw new Error("visibility must be an array");
          for (const m of ds.visibility as Record<string, unknown>[]) {
            if (!isNum(m?.masterTime) || !CAMERA_IDS.includes(m.cameraId as string)) throw new Error("visibility mark needs masterTime + valid cameraId");
            if (!["observed", "occluded", "out-of-frame", "unknown"].includes(m.state as string)) throw new Error("visibility mark state invalid");
          }
        }
      }
    },
  },
  "camera-sync": {
    file: "src/config/camera-sync.json",
    validate(d) {
      const o = d as Record<string, unknown>;
      for (const id of CAMERA_IDS) if (!isNum(o?.[id])) throw new Error(`${id} offset invalid`);
      if (Object.keys(o).some((k) => !CAMERA_IDS.includes(k))) throw new Error("unknown camera id");
    },
  },
};

/**
 * Dev-only endpoint: POST /__sentry3d/save-config {name, data} rewrites a
 * whitelisted JSON file in src/config. The running app already has the values,
 * so the resulting file change is not hot-reloaded (the module is still
 * invalidated, so the next page load reads the new file).
 */
function sentry3dConfigWriter(): Plugin {
  const recentWrites = new Map<string, number>();
  return {
    name: "sentry3d-config-writer",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__sentry3d/save-config", (req, res) => {
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 1_000_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const { name, data } = JSON.parse(raw) as { name: string; data: unknown };
            const cfg = CONFIGS[name];
            if (!cfg) throw new Error(`unknown config "${name}"`);
            cfg.validate(data);
            const abs = path.resolve(server.config.root, cfg.file);
            recentWrites.set(abs, Date.now());
            fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
            server.config.logger.info(`[sentry3d] saved ${cfg.file}`, { timestamp: true });
            reply(200, { ok: true, file: cfg.file });
          } catch (e) {
            reply(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        });
      });
    },
    handleHotUpdate({ file }) {
      const t = recentWrites.get(path.resolve(file));
      if (t && Date.now() - t < 3000) {
        recentWrites.delete(path.resolve(file));
        return []; // written by the app itself: skip HMR / full reload
      }
    },
  };
}

/**
 * AI Investigator API (server-side NVIDIA Nemotron agent). NVIDIA_API_KEY is read from .env on the
 * server only (no VITE_ prefix, so Vite never exposes it to the browser bundle).
 */
function sentry4dInvestigator(env: Record<string, string>): Plugin {
  return {
    name: "sentry4d-investigator",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        investigatorMiddleware({
          root: server.config.root,
          load: (id) => server.ssrLoadModule(id),
          env: { NVIDIA_API_KEY: env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY, NVIDIA_MODEL: env.NVIDIA_MODEL || process.env.NVIDIA_MODEL, NVIDIA_BASE_URL: env.NVIDIA_BASE_URL || process.env.NVIDIA_BASE_URL, NVIDIA_FALLBACK_MODEL: env.NVIDIA_FALLBACK_MODEL || process.env.NVIDIA_FALLBACK_MODEL },
        }),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "NVIDIA_");
  return {
    plugins: [react(), tailwindcss(), sentry3dConfigWriter(), sentry4dInvestigator(env)],
  };
});
