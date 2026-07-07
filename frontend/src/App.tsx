import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Nav from "./components/Nav";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import WorkflowsListPage from "./pages/WorkflowsListPage";
import WorkflowCreatePage from "./pages/WorkflowCreatePage";
import RunDetailPage from "./pages/RunDetailPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Nav />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/workflows" element={<ProtectedRoute><WorkflowsListPage /></ProtectedRoute>} />
          <Route path="/workflows/new" element={<ProtectedRoute><WorkflowCreatePage /></ProtectedRoute>} />
          <Route path="/runs/:runId" element={<ProtectedRoute><RunDetailPage /></ProtectedRoute>} />
          <Route path="/" element={<Navigate to="/workflows" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
