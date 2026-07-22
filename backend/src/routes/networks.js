const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");

const router = express.Router();

// GET /api/networks  -> lista las redes configuradas, en orden de escaneo
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM networks ORDER BY scan_order ASC").all();
  res.json(rows);
});

// POST /api/networks -> agregar un nuevo segmento de red (ej. "Red 4": 192.168.4.0/24)
router.post("/", (req, res) => {
  const { name, cidr, scanOrder, isLocal, notes } = req.body;
  if (!name || !cidr) return res.status(400).json({ error: "name y cidr son obligatorios" });

  const id = uuid();
  db.prepare(
    "INSERT INTO networks (id, name, cidr, scan_order, is_local, notes) VALUES (?,?,?,?,?,?)"
  ).run(id, name, cidr, scanOrder ?? 99, isLocal ? 1 : 0, notes || "");

  res.status(201).json(db.prepare("SELECT * FROM networks WHERE id = ?").get(id));
});

// PUT /api/networks/:id -> editar CIDR / orden de escaneo
router.put("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM networks WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Red no encontrada" });

  const name = req.body.name ?? existing.name;
  const cidr = req.body.cidr ?? existing.cidr;
  const scanOrder = req.body.scanOrder ?? existing.scan_order;
  const isLocal = req.body.isLocal !== undefined ? (req.body.isLocal ? 1 : 0) : existing.is_local;
  const notes = req.body.notes ?? existing.notes;

  db.prepare("UPDATE networks SET name=?, cidr=?, scan_order=?, is_local=?, notes=? WHERE id=?").run(
    name, cidr, scanOrder, isLocal, notes, req.params.id
  );

  res.json(db.prepare("SELECT * FROM networks WHERE id = ?").get(req.params.id));
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM networks WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

module.exports = router;
