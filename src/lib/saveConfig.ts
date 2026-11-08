/**
 * Writes a project config file through the dev server (vite.config.ts →
 * sentry3dConfigWriter). Only available under `npm run dev`; the file lands in
 * src/config/ so it can be committed like any other source change.
 */
export type ProjectConfigName = "camera-poses" | "camera-sync" | "person-annotations" | "device-positions";

export const canSaveToProject = import.meta.env.DEV;

export async function saveProjectConfig(name: ProjectConfigName, data: unknown): Promise<string> {
  if (!canSaveToProject) throw new Error("Saving to the project only works with `npm run dev`. Use COPY JSON instead.");
  const res = await fetch("/__sentry3d/save-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Save failed (HTTP ${res.status})`);
  return body.file ?? name;
}
