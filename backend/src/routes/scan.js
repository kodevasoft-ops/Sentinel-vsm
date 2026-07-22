const express = require("express");
const { runFullScan } = require("../services/scanner");

const router = express.Router();

let scanInProgress = false;

/**
 * GET /api/scan/stream
 * Server-Sent Events: el frontend abre esta conexión y recibe eventos en vivo
 * mientras se escanean Red 3 -> Red 2 -> Red 1 (orden configurado en la BD).
 */
router.get("/stream", async (req, res) => {
  if (scanInProgress) {
    res.status(409).json({ error: "Ya hay un escaneo en curso" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  scanInProgress = true;
  const credentials = { username: req.query.user || "", password: req.query.pass || "" };
  try {
    await runFullScan(emit, credentials);
  } catch (err) {
    emit({ type: "scan_error", message: err.message });
  } finally {
    scanInProgress = false;
    res.end();
  }
});

module.exports = router;
