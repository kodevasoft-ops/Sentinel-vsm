const onvif = require("onvif");

/**
 * Descubrimiento multicast WS-Discovery (estándar ONVIF).
 * IMPORTANTE: el multicast NO atraviesa routers por defecto, así que esto solo
 * encuentra cámaras que están en el MISMO segmento L2 que el servidor Sentinel
 * (típicamente "Red 1", la red local del servidor). Para Red 2 y Red 3 se usa
 * el sondeo unicast dirigido por IP en scanner.js.
 */
function discoverLocalOnvif(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = [];
    try {
      onvif.Discovery.on("device", (cam, rinfo) => {
        found.push({
          host: rinfo.address,
          xaddrs: cam.probeMatches?.probeMatch?.[0]?.XAddrs || null,
        });
      });
      onvif.Discovery.probe({ timeout: timeoutMs }, () => resolve(found));
    } catch (err) {
      resolve(found);
    }
  });
}

/**
 * Intenta conectarse a una IP concreta como si fuera un dispositivo ONVIF
 * (unicast, funciona a través de routers si hay ruta IP). Si responde,
 * devuelve fabricante/modelo y la URI RTSP del stream principal.
 */
function identifyOnvifDevice(host, port, { username = "", password = "" } = {}, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);

    const cam = new onvif.Cam(
      { hostname: host, port, username, password, timeout: timeoutMs },
      (err) => {
        clearTimeout(timer);
        if (err) return resolve(null);

        cam.getDeviceInformation((infoErr, info) => {
          const base = {
            host,
            port,
            manufacturer: info?.manufacturer || "Desconocido",
            model: info?.model || "Genérico ONVIF",
            ptz: Boolean(cam.capabilities?.PTZ),
          };

          cam.getStreamUri({ protocol: "RTSP" }, (streamErr, stream) => {
            resolve({
              ...base,
              rtspUrl: stream?.uri || null,
            });
          });
        });
      }
    );
  });
}

module.exports = { discoverLocalOnvif, identifyOnvifDevice };
