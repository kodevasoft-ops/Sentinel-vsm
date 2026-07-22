require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");

const db = require("./db");
const mediamtx = require("./services/mediamtx");
const cameraRoutes = require("./routes/cameras");
const networkRoutes = require("./routes/networks");
const scanRoutes = require("./routes/scan");
const ptzRoutes = require("./routes/ptz");

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-cambiar";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
// Contraseña por defecto SOLO para desarrollo; en producción usar ADMIN_PASSWORD hasheada.
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10);

// --- Autenticación mínima (JWT) ---
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || !bcrypt.compareSync(password || "", ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }
  const token = jwt.sign({ sub: username, role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  // EventSource (usado para el streaming de escaneo) no permite enviar headers,
  // así que también aceptamos el token como query param (?token=...) en esa ruta.
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token || null;
  if (!token) return res.status(401).json({ error: "Falta token de autenticación" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// A partir de aquí, todo requiere sesión iniciada
app.use("/api/cameras", requireAuth, cameraRoutes);
app.use("/api/cameras", requireAuth, ptzRoutes); // expone /api/cameras/:id/ptz/*
app.use("/api/networks", requireAuth, networkRoutes);
app.use("/api/scan", requireAuth, scanRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// --- Servidor HTTP + WebSocket para estado en vivo de las cámaras ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/status" });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Sondea periódicamente el estado (online/offline) de cada cámara vía MediaMTX
// y lo transmite a todos los paneles conectados.
async function pollStatuses() {
  const cameras = db.prepare("SELECT id FROM cameras").all();
  for (const { id } of cameras) {
    const status = await mediamtx.getPathStatus(id);
    db.prepare("UPDATE cameras SET online = ?, last_seen = datetime('now') WHERE id = ?").run(
      status.online ? 1 : 0,
      id
    );
    broadcast({ type: "camera_status", cameraId: id, online: status.online });
  }
}
setInterval(pollStatuses, 10_000);

/**
 * Vuelve a registrar TODAS las cámaras guardadas contra MediaMTX. Se corre al
 * arrancar el backend (por si MediaMTX se reinició, o si un registro anterior
 * falló, por ejemplo por el problema de autenticación que tuvimos) y así el
 * sistema se autorepara solo, sin depender de que alguien le dé clic a "Reconectar".
 * Si MediaMTX todavía no está listo (arrancó después que el backend), reintenta
 * con espera progresiva en vez de rendirse en el primer intento.
 */
async function resyncAllCameras(attempt = 1) {
  const health = await mediamtx.checkConnectivity();
  if (!health.ok) {
    const delay = Math.min(30000, 2000 * attempt);
    console.log(`MediaMTX aún no responde (intento ${attempt}), reintentando resync en ${delay / 1000}s…`);
    setTimeout(() => resyncAllCameras(attempt + 1), delay);
    return;
  }

  const cameras = db.prepare("SELECT * FROM cameras").all();
  let ok = 0;
  for (const cam of cameras) {
    try {
      await mediamtx.registerCamera(cam.id, cam.rtsp_url);
      ok++;
    } catch (err) {
      console.error(`No se pudo re-sincronizar la cámara "${cam.name}" (${cam.id}):`, err.message);
    }
  }
  console.log(`Resync con MediaMTX completo: ${ok}/${cameras.length} cámaras registradas.`);
}
resyncAllCameras();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Sentinel VMS backend escuchando en el puerto ${PORT}`);
});
