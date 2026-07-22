const net = require("net");

/**
 * Envía una solicitud RTSP cruda (protocolo de texto, similar a HTTP) y
 * devuelve el código de estado y los headers relevantes. Esto es lo que
 * permite CONFIRMAR si una ruta de stream existe de verdad, en vez de
 * simplemente adivinarla.
 */
function rtspRequest(host, port, path, method, { timeoutMs = 1500, authHeader = null } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
    socket.connect(port, host, () => {
      const url = `rtsp://${host}:${port}${path}`;
      let req = `${method} ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: SentinelVMS-Scanner\r\n`;
      if (authHeader) req += `Authorization: ${authHeader}\r\n`;
      req += `\r\n`;
      socket.write(req);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("\r\n\r\n")) {
        const statusLine = buffer.split("\r\n")[0];
        const match = statusLine.match(/RTSP\/1\.0 (\d+)/);
        const code = match ? parseInt(match[1], 10) : null;
        const serverMatch = buffer.match(/Server:\s*(.+)\r/i);
        finish({ code, server: serverMatch ? serverMatch[1].trim() : null });
      }
    });
  });
}

// Rutas de stream típicas de los fabricantes de cámaras IP más comunes.
// El orden importa: se prueban en este orden y se usa la primera que el
// dispositivo confirme (200 o 401 — ambos significan "esta ruta existe").
const CANDIDATE_PATHS = [
  { path: "/Streaming/Channels/101", vendor: "Hikvision (u OEM compatible)" },
  { path: "/Streaming/Channels/1", vendor: "Hikvision (u OEM compatible)" },
  { path: "/cam/realmonitor?channel=1&subtype=0", vendor: "Dahua (u OEM compatible)" },
  { path: "/h264Preview_01_main", vendor: "Reolink" },
  { path: "/h264/ch1/main/av_stream", vendor: "Foscam / genérica H264" },
  { path: "/live/ch0", vendor: "NVR genérico" },
  { path: "/live/ch00_0", vendor: "NVR genérico" },
  { path: "/onvif1", vendor: "ONVIF genérico" },
  { path: "/stream1", vendor: "Genérica" },
  { path: "/videoMain", vendor: "Genérica" },
  { path: "/media/video1", vendor: "Genérica" },
];

/**
 * Intenta identificar una URL RTSP real y funcional para el host, probando
 * primero OPTIONS (para confirmar que el puerto de verdad habla RTSP y leer
 * el header "Server", que casi siempre delata el fabricante), y luego
 * DESCRIBE contra cada ruta candidata hasta que el dispositivo confirme una.
 *
 * Devuelve verified:true solo cuando el dispositivo respondió 200 (ruta
 * accesible) o 401 (ruta existe pero pide autenticación) a un DESCRIBE real
 * — nunca se devuelve una URL como "encontrada" sin haberla probado.
 */
async function findWorkingRtspPath(host, port = 554, { username = "", password = "" } = {}) {
  const options = await rtspRequest(host, port, "/", "OPTIONS");
  if (!options) return { reachable: false };

  const basicAuth = username ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : null;

  for (const candidate of CANDIDATE_PATHS) {
    let result = await rtspRequest(host, port, candidate.path, "DESCRIBE");
    if (!result) continue;

    // Si pide autenticación y tenemos credenciales, reintentamos ya autenticados
    if (result.code === 401 && basicAuth) {
      const authed = await rtspRequest(host, port, candidate.path, "DESCRIBE", { authHeader: basicAuth });
      if (authed) result = authed;
    }

    if (result.code === 200 || result.code === 401) {
      const authPrefix = result.code === 200 && username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
      return {
        reachable: true,
        verified: result.code === 200,
        requiresAuth: result.code === 401,
        vendorGuess: candidate.vendor,
        serverHeader: options.server,
        rtspUrl: `rtsp://${authPrefix}${host}:${port}${candidate.path}`,
      };
    }
  }

  return { reachable: true, verified: false, serverHeader: options.server, rtspUrl: null };
}

module.exports = { findWorkingRtspPath };
