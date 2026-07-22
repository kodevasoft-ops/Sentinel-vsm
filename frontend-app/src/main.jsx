import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import CameraOpsDashboard from "./CameraOpsDashboard.jsx";

// El componente del dashboard lee window.SENTINEL_API_BASE para saber a qué
// backend conectarse. Aquí lo llenamos desde la variable de entorno de Vite
// (definida en tu archivo .env como VITE_API_URL) antes de renderizar.
window.SENTINEL_API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CameraOpsDashboard />
  </React.StrictMode>
);
