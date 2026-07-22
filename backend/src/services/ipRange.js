/**
 * Utilidades para convertir un bloque CIDR (ej. "192.168.2.0/24") en la lista
 * de direcciones IP host que deben ser sondeadas durante un escaneo.
 */

function ipToLong(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function longToIp(long) {
  return [24, 16, 8, 0].map((shift) => (long >>> shift) & 255).join(".");
}

/**
 * Devuelve todas las IPs "host" de un CIDR (excluye red y broadcast en /30 o mayor).
 * Para /31 y /32 devuelve las IPs literales (casos de enlaces punto a punto o host único).
 */
function cidrToHosts(cidr) {
  const [ip, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);

  if (bits >= 31) {
    return [ip];
  }

  const maskLong = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const ipLong = ipToLong(ip);
  const network = ipLong & maskLong;
  const broadcast = network | (~maskLong >>> 0);

  const hosts = [];
  for (let cur = network + 1; cur < broadcast; cur++) {
    hosts.push(longToIp(cur >>> 0));
  }
  return hosts;
}

module.exports = { cidrToHosts, ipToLong, longToIp };
