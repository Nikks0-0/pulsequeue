import { useState, FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(tenantName, email, password);
      navigate("/workflows");
    } catch (err: any) {
      setError(err?.body?.error === "email_already_registered" ? "That email is already registered." : "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Create your organization</h1>
        <p className="auth-hint">This creates a new tenant and makes you its admin.</p>
        {error && <div className="error-banner">{error}</div>}
        <label>
          Organization name
          <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} required minLength={2} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create organization"}
        </button>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
