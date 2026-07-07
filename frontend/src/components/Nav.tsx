import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";

export default function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <nav className="nav">
      <Link to="/workflows" className="nav-brand">PulseQueue</Link>
      {user && (
        <div className="nav-right">
          <span className="nav-user">{user.email} · {user.role}</span>
          <button className="nav-logout" onClick={handleLogout}>Log out</button>
        </div>
      )}
    </nav>
  );
}
