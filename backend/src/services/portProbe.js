const net = require("net");

// Puertos típicos de cámaras IP / servidores ONVIF
const CAMERA_PORTS = [554, 8554, 80, 8000, 8080, 8899, 2020];

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Sondea un host en la lista de puertos típicos de cámaras/ONVIF.
 * Devuelve la lista de puertos abiertos encontrados (vacía si el host no responde).
 */
async function probeHost(host, timeoutMs, ports = CAMERA_PORTS) {
  const results = await Promise.all(ports.map((p) => probePort(host, p, timeoutMs)));
  return ports.filter((_, i) => results[i]);
}

/**
 * Ejecuta probeHost sobre una lista grande de IPs respetando un límite de concurrencia,
 * reportando progreso mediante el callback onProgress(scanned, total).
 */
async function scanHosts(hosts, { concurrency, timeoutMs, onProgress, onHost }) {
  let index = 0;
  let scanned = 0;
  const openHosts = [];

  async function worker() {
    while (index < hosts.length) {
      const myIndex = index++;
      const host = hosts[myIndex];
      const openPorts = await probeHost(host, timeoutMs);
      scanned++;
      if (openPorts.length > 0) {
        openHosts.push({ host, openPorts });
        if (onHost) onHost({ host, openPorts });
      }
      if (onProgress) onProgress(scanned, hosts.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, worker);
  await Promise.all(workers);
  return openHosts;
}

module.exports = { probeHost, scanHosts, CAMERA_PORTS };
