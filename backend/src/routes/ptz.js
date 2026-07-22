const express = require("express");
const onvif = require("onvif");
const db = require("../db");

const router = express.Router();

function getCam(cameraRow) {
  return new Promise((resolve, reject) => {
    const cam = new onvif.Cam(
      {
        hostname: cameraRow.onvif_host,
        port: cameraRow.onvif_port || 80,
        username: cameraRow.username || "",
        password: cameraRow.password || "",
        timeout: 3000,
      },
      (err) => (err ? reject(err) : resolve(cam))
    );
  });
}

// POST /api/cameras/:id/ptz/move   body: { pan, tilt, zoom }  cada uno en [-1, 1]
router.post("/:id/ptz/move", async (req, res) => {
  const row = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Cámara no encontrada" });
  if (!row.ptz) return res.status(400).json({ error: "Esta cámara no tiene PTZ habilitado" });

  try {
    const cam = await getCam(row);
    const { pan = 0, tilt = 0, zoom = 0 } = req.body;
    cam.continuousMove({ x: pan, y: tilt, zoom }, (err) => {
      if (err) return res.status(502).json({ error: "El dispositivo ONVIF rechazó el comando", detail: err.message });
      res.json({ ok: true });
    });
  } catch (err) {
    res.status(502).json({ error: "No se pudo conectar al dispositivo ONVIF", detail: err.message });
  }
});

// POST /api/cameras/:id/ptz/stop
router.post("/:id/ptz/stop", async (req, res) => {
  const row = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Cámara no encontrada" });

  try {
    const cam = await getCam(row);
    cam.stop({}, (err) => (err ? res.status(502).json({ error: err.message }) : res.json({ ok: true })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/cameras/:id/ptz/home
router.post("/:id/ptz/home", async (req, res) => {
  const row = db.prepare("SELECT * FROM cameras WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Cámara no encontrada" });

  try {
    const cam = await getCam(row);
    cam.gotoHomePosition({}, (err) => (err ? res.status(502).json({ error: err.message }) : res.json({ ok: true })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
