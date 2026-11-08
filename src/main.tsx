import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./app/App";

/** Phones get the AR-only viewer (?desktop forces the dashboard, ?ar forces AR). */
const q = new URLSearchParams(window.location.search);
const isPhone =
  !q.has("desktop") &&
  (q.has("ar") || (window.matchMedia?.("(pointer: coarse)").matches && Math.min(window.screen.width, window.screen.height) < 820));
const ARApp = lazy(() => import("./ar/ARApp"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPhone ? (
      <Suspense fallback={null}>
        <ARApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
