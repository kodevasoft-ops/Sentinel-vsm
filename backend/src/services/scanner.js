const { cidrToHosts } = require("./ipRange");
const { scanHosts } = require("./portProbe");
const { discoverLocalOnvif, identifyOnvifDevice } = require("./onvifProbe");
const { findWorkingRtspPath } = require("./rtspProbe");
const db = require("../db");

const CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY || "60", 10);
const TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS || "350", 10);

/**
 * Orquesta el escaneo de TODAS las redes configuradas, en el orden solicitado
 * por el usuario: primero la red más lejana (mayor número de saltos) y por
 * último la red local del servidor. Ej: Red 3 -> Red 2 -> Red 1.
 *
 * emit(event) recibe objetos { type, ... } que la ruta HTTP reenvía al
 * navegador como Server-Sent Events para mostrar el progreso en vivo.
 */
async function runFullScan(emit, credentials = {}) {
  const networks = db
    .prepare("SELECT * FROM networks ORDER BY scan_order ASC")
    .all(); // scan_order=1 (más lejana) se procesa primero, según el seed

  const existingHosts = new Set(
    db
      .prepare("SELECT onvif_host FROM cameras WHERE onvif_host IS NOT NULL")
      .all()
      .map((r) => r.onvif_host)
  );

  emit({ type: "scan_start", networks: networks.map((n) => ({ id: n.id, name: n.name, cidr: n.cidr })) });

  const allDiscovered = [];

  for (const network of networks) {
    emit({ type: "network_start", networkId: network.id, name: network.name, cidr: network.cidr });

    // Paso 1: en la red local del servidor, además del sondeo TCP dirigido,
    // se lanza un descubrimiento ONVIF multicast (WS-Discovery), mucho más
    // rápido y no requiere conocer el rango exacto.
    if (network.is_local) {
      const multicastHits = await discoverLocalOnvif(3000);
      for (const hit of multicastHits) {
        emit({ type: "host_hit", networkId: network.id, host: hit.host, via: "multicast" });
      }
    }

    // Paso 2: sondeo TCP dirigido por IP sobre todo el bloque CIDR. Este es el
    // método que SÍ funciona a través de routers para alcanzar Red 2 y Red 3,
    // siempre que el servidor tenga ruta IP hacia esos segmentos.
    const hosts = cidrToHosts(network.cidr);
    const openHosts = await scanHosts(hosts, {
      concurrency: CONCURRENCY,
      timeoutMs: TIMEOUT_MS,
      onProgress: (scanned, total) => {
        emit({ type: "network_progress", networkId: network.id, scanned, total });
      },
      onHost: (hit) => {
        emit({ type: "host_hit", networkId: network.id, host: hit.host, ports: hit.openPorts, via: "tcp" });
      },
    });

    // Paso 3: para cada IP con puertos de cámara abiertos, identificarla combinando dos métodos:
    //   a) ONVIF (fabricante, modelo, si tiene PTZ, y su URI RTSP oficial vía GetStreamUri)
    //   b) Si ONVIF no responde o no entrega RTSP: se prueban las rutas RTSP típicas de cada
    //      fabricante contra el puerto 554 y se CONFIRMA cuál existe de verdad (no se adivina a ciegas)
    for (const { host, openPorts } of openHosts) {
      const onvifPort = openPorts.includes(80) ? 80 : openPorts.includes(8000) ? 8000 : openPorts[0];
      const identity = await identifyOnvifDevice(host, onvifPort, credentials);

      let rtspUrl = identity?.rtspUrl || null;
      let manufacturer = identity?.manufacturer && identity.manufacturer !== "Desconocido" ? identity.manufacturer : null;
      let verified = Boolean(identity?.rtspUrl);
      let requiresAuth = false;

      if (!rtspUrl && openPorts.includes(554)) {
        const probe = await findWorkingRtspPath(host, 554, credentials);
        if (probe.rtspUrl) {
          rtspUrl = probe.rtspUrl;
          verified = probe.verified;
          requiresAuth = probe.requiresAuth;
          if (!manufacturer) manufacturer = probe.vendorGuess || probe.serverHeader || null;
        }
      }

      const device = {
        networkId: network.id,
        networkName: network.name,
        host,
        openPorts,
        isNew: !existingHosts.has(host),
        manufacturer: manufacturer || "Desconocido",
        model: identity?.model || null,
        ptz: identity?.ptz || false,
        onvifPort: identity ? onvifPort : null,
        rtspUrl,
        verified,               // true = el dispositivo confirmó esta ruta con un 200 OK real
        requiresAuth,           // true = la ruta existe pero pide usuario/contraseña
        identified: Boolean(identity) || verified,
      };

      allDiscovered.push(device);
      emit({ type: "device_found", device });
    }

    emit({ type: "network_done", networkId: network.id, found: openHosts.length });
  }

  emit({ type: "scan_complete", totalFound: allDiscovered.length });
  return allDiscovered;
}

module.exports = { runFullScan };
