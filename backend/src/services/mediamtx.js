const fetch = require("node-fetch");

const API = process.env.MEDIAMTX_API_URL || "http://localhost:9997";
const WEBRTC_BASE = process.env.MEDIAMTX_WEBRTC_URL || "http://localhost:8889";
const HLS_BASE = process.env.MEDIAMTX_HLS_URL || "http://localhost:8888";

// Desde MediaMTX 1.x la API de control exige autenticación por defecto. Este usuario
// debe existir en mediamtx.yml bajo authInternalUsers con permission "action: api",
// y la contraseña debe ser IDÉNTICA en ambos lados.
const API_USER = process.env.MEDIAMTX_API_USER || "sentinel-backend";
const API_PASSWORD = process.env.MEDIAMTX_API_PASSWORD || "cambia-esta-clave-interna";
const AUTH_HEADER = "Basic " + Buffer.from(`${API_USER}:${API_PASSWORD}`).toString("base64");

function authedFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: AUTH_HEADER },
  });
}

/**
 * Registra una cámara en MediaMTX para que empiece a leer su RTSP y lo
 * republique como WebRTC (baja latencia, con audio) y HLS (compatibilidad).
 * "pathName" es el identificador único de la cámara (usamos el id de la BD).
 */
async function registerCamera(pathName, rtspUrl) {
  const res = await authedFetch(`${API}/v3/config/paths/add/${encodeURIComponent(pathName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: rtspUrl,
      sourceOnDemand: false,       // un VMS de verdad mantiene la conexión SIEMPRE activa, no solo
                                    // cuando alguien está mirando; así el estado online/offline es real
      sourceProtocol: "tcp",       // RTSP sobre TCP: mucho más confiable detrás de NAT/Docker que UDP
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const alreadyExists = res.status === 400 && /already exist/i.test(bodyText);
    if (!alreadyExists) {
      const hint = res.status === 401
        ? " — revisa que MEDIAMTX_API_PASSWORD (backend/.env) sea IDÉNTICA al password de 'sentinel-backend' en mediamtx.yml"
        : "";
      throw new Error(`MediaMTX rechazó el registro de ${pathName} (${res.status}): ${bodyText || "sin detalle"}${hint}`);
    }
  }
  return true;
}

/**
 * Fuerza a MediaMTX a soltar la conexión actual con la cámara y reintentar desde cero.
 * Útil cuando la cámara estuvo caída y ya volvió, o cuando la URL/credenciales cambiaron.
 */
async function reconnectCamera(pathName, rtspUrl) {
  await removeCamera(pathName);
  await new Promise((r) => setTimeout(r, 300));
  await registerCamera(pathName, rtspUrl);
}

async function removeCamera(pathName) {
  await authedFetch(`${API}/v3/config/paths/delete/${encodeURIComponent(pathName)}`, { method: "DELETE" }).catch(() => {});
}

function getPlaybackUrls(pathName) {
  return {
    webrtc: `${WEBRTC_BASE}/${pathName}/whep`,
    hls: `${HLS_BASE}/${pathName}/index.m3u8`,
  };
}

async function getPathStatus(pathName) {
  try {
    const res = await authedFetch(`${API}/v3/paths/get/${encodeURIComponent(pathName)}`);
    if (!res.ok) return { online: false };
    const data = await res.json();
    return { online: Boolean(data.ready), tracks: data.tracks || [], lastError: data.lastError || null };
  } catch {
    return { online: false };
  }
}

async function checkConnectivity() {
  try {
    const res = await authedFetch(`${API}/v3/paths/list`, { timeout: 3000 });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, apiUrl: API, status: res.status, detail: text || "MediaMTX respondió pero con error" };
    }
    const data = await res.json();
    return { ok: true, apiUrl: API, pathCount: data.items?.length ?? 0 };
  } catch (err) {
    return { ok: false, apiUrl: API, detail: err.message };
  }
}

module.exports = { registerCamera, removeCamera, reconnectCamera, getPlaybackUrls, getPathStatus, checkConnectivity };
