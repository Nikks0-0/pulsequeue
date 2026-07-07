// The worker trusts that dagJson stored in Postgres was already validated
// by the API (schema + cycle checks happen at creation time in api/src/dag).
// We only need the shape here, not a runtime validator.
export interface DagStep {
  key: string;
  type: "HTTP" | "SCRIPT" | "AI_ENRICHMENT" | "WEBHOOK";
  dependsOn: string[];
  config: Record<string, unknown>;
  maxRetries: number;
}

export interface Dag {
  steps: DagStep[];
}
