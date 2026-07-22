# Sentinel VMS

Software de videovigilancia (VMS) enterprise: conecta cámaras IP por RTSP, las organiza por nombre/zona/prioridad, las reproduce en el navegador (WebRTC/HLS), controla PTZ vía ONVIF, y **descubre cámaras automáticamente en múltiples segmentos de red** (Red 1 → Red 2 → Red 3).

## Arquitectura

```
Navegador (React, responsivo)
        │  REST + WebSocket (estado) + SSE (progreso de escaneo)
        ▼
Backend (Node/Express)  ── ONVIF/WS-Discovery + escaneo TCP dirigido
        │  registra cada cámara como "path"
        ▼
MediaMTX  ── se conecta a cada cámara por RTSP y la republica como:
        │      • WebRTC (WHEP) → baja latencia, con audio, lo que usa el navegador
        │      • HLS           → respaldo de compatibilidad
        ▼
Cámaras IP (RTSP / ONVIF) en Red 1, Red 2, Red 3...
```

**Por qué existe MediaMTX:** ningún navegador puede decodificar RTSP directamente (es una limitación de la Web, no de este proyecto). MediaMTX es el estándar de facto para este puente RTSP → WebRTC/HLS; lo usan proyectos como Frigate y Home Assistant.

## Puesta en marcha

```bash
cd sentinel-vms
cp backend/.env.example backend/.env
# edita backend/.env: ADMIN_PASSWORD, JWT_SECRET, y los CIDR reales de tus redes

docker compose up -d --build
```

- Backend API: `http://localhost:4000`
- MediaMTX WebRTC: `http://localhost:8889`
- Login por defecto: usuario `admin`, contraseña la que pongas en `ADMIN_PASSWORD`

Para desarrollo del frontend, copia `frontend/CameraOpsDashboard.jsx` a tu proyecto React (Vite/Next) con Tailwind y `lucide-react` instalados, y define `window.SENTINEL_API_BASE` si el backend no corre en `localhost:4000`.

## Configurar las redes a escanear

Las 3 redes vienen precargadas en la base de datos (`Red 1`, `Red 2`, `Red 3` con `192.168.1.0/24` a `.3.0/24`). Edítalas con la API:

```bash
curl -X PUT http://localhost:4000/api/networks/net-red3 \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"cidr":"10.20.30.0/24"}'
```

El escaneo siempre respeta `scan_order` ascendente, y por defecto Red 3 = orden 1 (se escanea primero), Red 1 = orden 3 (al final), tal como pediste.

## Cómo funciona realmente el escaneo multi-red (léelo antes de confiar en él)

Esto es importante y quiero ser directo: **hay una diferencia real entre "descubrir cámaras en tu propia red" y "descubrir cámaras en una red a 2 saltos de distancia"**, y el software no puede saltarse las reglas de una red IP:

1. **Red 1 (la red local del servidor):** aquí el backend usa **WS-Discovery**, el protocolo multicast estándar de ONVIF (`239.255.255.250:3702`). Es rápido y encuentra cámaras sin necesidad de conocer su IP exacta. Pero el multicast **no cruza routers**, así que solo funciona en el segmento directamente conectado.

2. **Red 2 y Red 3 (segmentos remotos, alcanzables por rutas IP):** aquí el multicast no sirve. El backend hace en su lugar un **sondeo TCP dirigido** IP por IP sobre todo el rango CIDR configurado (puertos 554, 80, 8000, 8899, 2020), y a cada IP que responde le pregunta por ONVIF (`GetDeviceInformation`, `GetStreamUri`) para confirmar que es una cámara real y obtener su RTSP y si tiene PTZ.

3. **Requisito indispensable:** el servidor donde corre el backend necesita **tener ruta IP** hacia Red 2 y Red 3 (rutas estáticas, VLANs enrutadas, o estar conectado a un router que las una) y que **no haya un firewall bloqueando esos puertos entre segmentos**. Si el servidor no tiene forma de alcanzar esas IPs por red, ningún software puede "ver a través" de esa frontera — ni este ni cualquier VMS comercial (Milestone, Genetec, Hikvision, etc. tienen exactamente la misma limitación).

Nota: en Windows con Docker Desktop, `network_mode: host` no aplica igual que en Linux (ver sección de Windows más abajo) — ahí el backend usa mapeo de puertos explícito y depende de que Docker Desktop deje pasar el tráfico TCP saliente hacia tu LAN, cosa que normalmente sí hace vía NAT.

## Extracción de datos e identificación de URL RTSP (cómo evita "adivinar a ciegas")

Cuando el escáner encuentra un host con un puerto de cámara abierto, sigue este orden para identificarlo y obtener su URL RTSP real:

1. **ONVIF** (`GetDeviceInformation` + `GetStreamUri`): si el dispositivo habla ONVIF, esto da el fabricante, modelo, si tiene PTZ, y la URL RTSP **oficial** que el propio dispositivo reporta. Es el método más confiable cuando funciona.
2. **Si ONVIF no responde o no tiene RTSP**, el backend prueba directamente contra el puerto 554 las rutas de stream típicas de los fabricantes más comunes (Hikvision, Dahua, Reolink, Foscam, genéricas), y **confirma con el dispositivo real** cuál existe — no se limita a adivinar y mostrarte una URL sin probarla. Una ruta se acepta solo si el dispositivo responde `200 OK` (accesible) o `401` (existe, pide autenticación); rutas inexistentes responden `404` y se descartan.
3. Cada cámara encontrada indica en la interfaz si su URL quedó **"verificada"** (confirmada con 200) o **"requiere usuario/contraseña"** (confirmada con 401).

**Credenciales durante el escaneo:** en "Agregar cámara" puedes expandir "Usar credenciales para autenticar durante el escaneo" y escribir el usuario/contraseña de tus cámaras. Con eso, el backend intenta autenticación **Basic** contra las rutas candidatas y, si funciona, entrega la URL RTSP ya con las credenciales incluidas, lista para guardar con un clic.

**Limitación honesta:** esto usa autenticación RTSP **Basic**, no **Digest**. La mayoría de cámaras IP modernas soportan ambas, pero algunas solo aceptan Digest — en ese caso el escáner marcará la ruta como "requiere usuario/contraseña" pero no arma la URL completa sola; copia el usuario/contraseña que usas en VLC y complétalos a mano en el formulario.

## Estructura del proyecto

```
sentinel-vms/
├── docker-compose.yml
├── mediamtx.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.js            # Express + auth JWT + WebSocket de estado
│       ├── db.js                # SQLite (cámaras + redes configuradas)
│       ├── routes/
│       │   ├── cameras.js       # CRUD de cámaras
│       │   ├── networks.js      # CRUD de segmentos de red a escanear
│       │   ├── scan.js          # SSE: progreso de escaneo en vivo
│       │   └── ptz.js           # Control PTZ (ONVIF continuousMove/stop/home)
│       └── services/
│           ├── ipRange.js       # CIDR -> lista de IPs host
│           ├── portProbe.js     # Sondeo TCP concurrente con límite configurable
│           ├── onvifProbe.js    # WS-Discovery + identificación ONVIF unicast
│           ├── scanner.js       # Orquesta Red3 -> Red2 -> Red1
│           └── mediamtx.js      # Registra/consulta cámaras en MediaMTX
└── frontend/
    └── CameraOpsDashboard.jsx   # Dashboard React responsivo, conectado a la API real
```

## Frontend: responsividad

- **Escritorio (≥1024px):** sidebar fija, grid 2×2/3×3/4×4 completo, controles al pasar el mouse.
- **Tablet (640–1023px):** grid limitado a 2 columnas para mantener cada cámara legible, selector de layout como dropdown, sidebar se convierte en cajón (drawer).
- **Móvil (<640px):** una cámara por fila, controles siempre visibles (no dependen de hover), cajón de cámaras a pantalla completa, vista de foco apila el panel PTZ debajo del video en vez de al costado.

## Seguridad — antes de producción

- Cambia `JWT_SECRET` y `ADMIN_PASSWORD` en `.env`.
- Agrega HTTPS (proxy inverso con Caddy/Nginx) — las credenciales de las cámaras (`username`/`password` de la tabla `cameras`) viajan y se guardan en texto plano en este MVP; en producción deben cifrarse en reposo.
- Restringe con firewall qué hosts pueden llamar a la API de control de MediaMTX (puerto 9997).
- Considera roles de usuario (operador/administrador) — este MVP solo tiene un usuario admin.
