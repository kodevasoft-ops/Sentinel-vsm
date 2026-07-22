const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const mediamtx = require("../services/mediamtx");

const router = express.Router();

function serialize(cam) {
  const { webrtc, hls } = mediamtx.getPlaybackUrls(cam.id);
  return {
    id: cam.id,
    name: cam.name,
    zone: cam.zone,
    rtsp: cam.rtsp_url,
    onvifHost: cam.onvif_host,
    onvifPort: cam.onvif_port,
    priority: cam.priority,
    ptz: Boolean(cam.ptz),
    manufacturer: cam.manufacturer,
    model: cam.model,
    networkId: cam.network_id,
    online: Boolean(cam.online),
    lastSeen: cam.last_seen,
    playback: { webrtc, hls },
  };
}

// GET /api/cameras
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM cameras ORDER BY priority ASC, name ASC").all();
  res.json(rows.map(serialize));
});

// POST /api/cameras  (alta manual o desde el escáner)
router.post("/", async (req, res) => {
  const { name, zone, rtsp, onvifHost, onvifPort, username, password, priority, ptz, manufacturer, model, networkId } = req.body;

  if (!name || !rtsp) {
    return res.status(400).json({ error: "name y rtsp son obligatorios" });
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO cameras (id, name, zone, rtsp_url, onvif_host, onvif_port, username, password, priority, ptz, manufacturer, model, network_id, online)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id,
    name,
    zone || "",
    rtsp,
    onvifHost || null,
    onvifPort || null,
    username || null,
    password || null,
    priority || "media",
    ptz ? 1 : 0,
    manufacturer || null,
    model || null,
    networkId || null
  );

  let mediamtxWarning = null;
  try {
    await mediamtx.registerCamera(id, rtsp);
  } catch (err) {
    // La cámara queda guardada aunque MediaMTX no haya podido registrarla; se lo
    // avisamos al frontend en vez de tragarnos el error en silencio.
    mediamtxWarning = err.message;
    console.error("No se pudo registrar en MediaMTX:", err.message);
  }

  const row = db.prepare("SELECT * FROM cameras WHERE id = ?").get(id);
  res.status(201).json({ ...serialize(row), mediamtxWarning });
});

// PUT /api/cameras/:id  (edición completa: nombre, zona, prioridad, PTZ, RTSP, credenciales ONVIF)
router.put("/:id", async (req, res) => {
  const existing = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Cámara no encontrada" });

  const name = req.body.name ?? existing.name;
  const zone = req.body.zone ?? existing.zone;
  const priority = req.body.priority ?? existing.priority;
  const ptz = req.body.ptz !== undefined ? (req.body.ptz ? 1 : 0) : existing.ptz;
  const rtsp = req.body.rtsp ?? existing.rtsp_url;
  const onvifHost = req.body.onvifHost ?? existing.onvif_host;
  const onvifPort = req.body.onvifPort ?? existing.onvif_port;
  const username = req.body.username ?? existing.username;
  const password = req.body.password ?? existing.password;

  db.prepare(
    `UPDATE cameras SET name=?, zone=?, priority=?, ptz=?, rtsp_url=?, onvif_host=?, onvif_port=?, username=?, password=? WHERE id=?`
  ).run(name, zone, priority, ptz, rtsp, onvifHost, onvifPort, username, password, req.params.id);

  // Si la URL RTSP cambió, hay que volver a registrar el path en MediaMTX para que apunte a la nueva fuente
  if (rtsp !== existing.rtsp_url) {
    try {
      await mediamtx.registerCamera(req.params.id, rtsp);
    } catch (err) {
      console.error("No se pudo re-registrar en MediaMTX:", err.message);
    }
  }

  res.json(serialize(db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id)));
});

// DELETE /api/cameras/:id
router.delete("/:id", async (req, res) => {
  const existing = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Cámara no encontrada" });

  await mediamtx.removeCamera(req.params.id);
  db.prepare("DELETE FROM cameras WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// POST /api/cameras/:id/reconnect  -> fuerza a MediaMTX a reintentar la conexión RTSP desde cero
router.post("/:id/reconnect", async (req, res) => {
  const row = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Cámara no encontrada" });

  try {
    await mediamtx.reconnectCamera(row.id, row.rtsp_url);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: "No se pudo reconectar", detail: err.message });
  }
});

// GET /api/cameras/diagnostics/mediamtx -> revisa si el backend puede hablar con MediaMTX ahora mismo
router.get("/diagnostics/mediamtx", async (req, res) => {
  const result = await mediamtx.checkConnectivity();
  res.status(result.ok ? 200 : 502).json(result);
});

module.exports = router;
