import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { Workflow } from "../lib/types";

export default function WorkflowsListPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ data: Workflow[] }>("/api/v1/workflows");
      setWorkflows(res.data);
    } catch {
      setError("Failed to load workflows.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleTrigger(id: string) {
    setTriggering(id);
    setError(null);
    try {
      const res = await apiFetch<{ runId: string }>(`/api/v1/workflows/${id}/trigger`, { method: "POST" });
      window.location.href = `/runs/${res.runId}`;
    } catch {
      setError("Failed to trigger workflow.");
      setTriggering(null);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Workflows</h1>
        <Link to="/workflows/new" className="btn-primary">+ New workflow</Link>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <p>Loading...</p>}

      {!loading && workflows.length === 0 && (
        <div className="empty-state">
          <p>No workflows yet.</p>
          <Link to="/workflows/new" className="btn-primary">Create your first workflow</Link>
        </div>
      )}

      <div className="card-grid">
        {workflows.map((wf) => (
          <div key={wf.id} className="card">
            <h3>{wf.name}</h3>
            <p className="card-meta">{wf.dagJson.steps.length} step{wf.dagJson.steps.length !== 1 ? "s" : ""}</p>
            <div className="card-steps">
              {wf.dagJson.steps.map((s) => (
                <span key={s.key} className={`step-chip step-chip--${s.type.toLowerCase()}`}>{s.key}</span>
              ))}
            </div>
            <button className="btn-primary" onClick={() => handleTrigger(wf.id)} disabled={triggering === wf.id}>
              {triggering === wf.id ? "Triggering..." : "Trigger run"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
