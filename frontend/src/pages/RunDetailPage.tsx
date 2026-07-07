import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, getAccessToken } from "../lib/api";
import { Run, Step } from "../lib/types";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:4000";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "gray",
  RUNNING: "blue",
  RETRYING: "amber",
  SUCCEEDED: "green",
  FAILED: "red",
  DEAD_LETTER: "red",
};

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [connected, setConnected] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const loadSnapshot = useCallback(async () => {
    if (!runId) return;
    const res = await apiFetch<{ runId: string; status: string; steps: Step[] }>(`/api/v1/runs/${runId}/steps`);
    setSteps(res.steps);
    const runRes = await apiFetch<Run>(`/api/v1/runs/${runId}`);
    setRun(runRes);
  }, [runId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // Live updates: connect once, merge incoming step/run events into state.
  // The initial REST fetch above is the source of truth for anything that
  // happened before the socket connects; the socket only carries what
  // changes *after* connection -- so a page refresh never shows stale data
  // even if a WS message was missed while disconnected.
  useEffect(() => {
    if (!runId) return;
    const token = getAccessToken();
    const ws = new WebSocket(`${WS_URL}/ws/runs?token=${token}&runId=${runId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "step.updated") {
        setSteps((prev) => {
          const idx = prev.findIndex((s) => s.id === msg.step.id);
          if (idx === -1) return [...prev, msg.step];
          const next = [...prev];
          next[idx] = msg.step;
          return next;
        });
      } else if (msg.type === "run.updated") {
        setRun((prev) => (prev ? { ...prev, ...msg.run } : msg.run));
      }
    };

    return () => ws.close();
  }, [runId]);

  async function handleReplay() {
    if (!runId) return;
    setReplaying(true);
    try {
      await apiFetch(`/api/v1/runs/${runId}/replay`, { method: "POST" });
      await loadSnapshot();
    } finally {
      setReplaying(false);
    }
  }

  const hasDeadLetter = steps.some((s) => s.status === "DEAD_LETTER");

  if (!run) return <div className="page"><p>Loading run...</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{run.workflow?.name ?? "Run"} <span className={`status-badge status-badge--${STATUS_COLORS[run.status]}`}>{run.status}</span></h1>
          <p className="card-meta">
            Run {run.id.slice(0, 8)} · <span className={connected ? "ws-connected" : "ws-disconnected"}>{connected ? "● live" : "○ disconnected"}</span>
          </p>
        </div>
        {hasDeadLetter && (
          <button className="btn-primary" onClick={handleReplay} disabled={replaying}>
            {replaying ? "Replaying..." : "Replay dead-lettered steps"}
          </button>
        )}
      </div>

      <div className="step-list">
        {steps.map((step) => (
          <div key={step.id} className="step-row">
            <span className={`status-dot status-dot--${STATUS_COLORS[step.status]}`} />
            <span className="step-key">{step.stepKey}</span>
            <span className="step-type">{step.type}</span>
            <span className={`status-badge status-badge--${STATUS_COLORS[step.status]}`}>{step.status}</span>
            <span className="step-attempts">attempt {step.attemptCount}</span>
            {step.error && <span className="step-error" title={step.error}>{step.error.slice(0, 60)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
