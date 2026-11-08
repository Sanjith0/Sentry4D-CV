import { useEffect } from "react";
import type { DeviceId } from "../../config/devices";
import {
  useCyberAlertStore,
  type ChoiceResult,
  type Debrief,
  type SessionSummary,
  type StepPresentation,
} from "./useCyberAlertStore";

/** services/agent-worker/blacksite_agent/server.py. */
const WS_URL = "ws://localhost:8787";

interface InboundMessage {
  type: "session" | "step" | "result" | "score" | "debrief" | "error";
  sessionId: string | null;
  assetId: DeviceId | null;
  data: unknown;
}

let activeSocket: WebSocket | null = null;

/** Sends a message to the agent-worker bridge; a no-op (logged) if it isn't connected. */
export function sendCyberAlertMessage(msg: unknown): void {
  if (activeSocket?.readyState !== WebSocket.OPEN) {
    console.warn("[Sentry3D] cyber-alert bridge is not connected; dropped", msg);
    return;
  }
  activeSocket.send(JSON.stringify(msg));
}

export function startAttack(assetId: DeviceId): void {
  sendCyberAlertMessage({ type: "start_attack", assetId });
}

export function selectOption(sessionId: string, stepId: string, attempt: number, optionId: string): void {
  sendCyberAlertMessage({ type: "select_option", sessionId, stepId, attempt, optionId });
}

/**
 * Connects to the BLACKSITE agent-worker's WebSocket bridge and feeds its
 * messages into useCyberAlertStore. Reconnects with backoff; harmless if the
 * server isn't running yet — devices simply stay idle until it is.
 */
export function useCyberAlertSocket(): void {
  useEffect(() => {
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const socket = new WebSocket(WS_URL);
      activeSocket = socket;
      socket.onopen = () => {
        retryDelay = 1000;
        useCyberAlertStore.getState().setConnected(true);
      };
      socket.onclose = () => {
        useCyberAlertStore.getState().setConnected(false);
        if (closed) return;
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (event) => {
        let msg: InboundMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const store = useCyberAlertStore.getState();
        switch (msg.type) {
          case "session":
            store.onSession(msg.assetId, msg.data as SessionSummary);
            break;
          case "step":
            if (msg.sessionId) store.onStep(msg.sessionId, msg.data as StepPresentation);
            break;
          case "result":
            if (msg.sessionId) store.onResult(msg.sessionId, msg.data as ChoiceResult);
            break;
          case "debrief":
            if (msg.sessionId) store.onDebrief(msg.sessionId, msg.data as Debrief);
            break;
          case "error":
            store.onError(msg.sessionId, (msg.data as { message?: string })?.message ?? "Unknown error.");
            break;
          case "score":
            break; // the next session summary already reflects the new score
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      activeSocket?.close();
      activeSocket = null;
    };
  }, []);
}
