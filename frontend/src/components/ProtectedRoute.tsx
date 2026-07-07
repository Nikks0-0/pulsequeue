import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page"><p>Loading...</p></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
