import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";

const EXAMPLE_DAG = {
  steps: [
    { key: "fetch", type: "HTTP", dependsOn: [], config: { url: "https://httpstat.us/200" }, maxRetries: 3 },
    { key: "enrich", type: "AI_ENRICHMENT", dependsOn: ["fetch"], config: { prompt: "Summarize this lead" }, maxRetries: 2 },
    { key: "notify", type: "WEBHOOK", dependsOn: ["enrich"], config: { url: "https://httpstat.us/200" }, maxRetries: 3 },
  ],
};

export default function WorkflowCreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [dagText, setDagText] = useState(JSON.stringify(EXAMPLE_DAG, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    let dag;
    try {
      dag = JSON.parse(dagText);
    } catch {
      setError("DAG is not valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const wf = await apiFetch<{ id: string }>("/api/v1/workflows", {
        method: "POST",
        body: JSON.stringify({ name, dag }),
      });
      navigate(`/workflows`, { state: { createdId: wf.id } });
    } catch (err: any) {
      setError(err?.body?.message || "Failed to create workflow. Check your DAG for cycles or missing dependencies.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>New workflow</h1>
      <form className="workflow-form" onSubmit={handleSubmit}>
        {error && <div className="error-banner">{error}</div>}
        <label>
          Workflow name
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </label>
        <label>
          DAG definition (JSON)
          <textarea
            value={dagText}
            onChange={(e) => setDagText(e.target.value)}
            rows={16}
            spellCheck={false}
            className="dag-editor"
          />
        </label>
        <p className="hint">
          Step types: <code>HTTP</code>, <code>SCRIPT</code>, <code>AI_ENRICHMENT</code>, <code>WEBHOOK</code>.
          Each step needs a unique <code>key</code> and a <code>dependsOn</code> array of other step keys.
        </p>
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create workflow"}
        </button>
      </form>
    </div>
  );
}
