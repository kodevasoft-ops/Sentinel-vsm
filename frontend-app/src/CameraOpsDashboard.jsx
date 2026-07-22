import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Video, Grid2x2, Grid3x3, LayoutGrid, Plus, Settings, Search, Mic, MicOff,
  ZoomIn, ZoomOut, Maximize2, X, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  Home, Wifi, WifiOff, Circle, AlertTriangle, Move, Camera as CameraIcon, Menu,
  RadarIcon, Loader2, CheckCircle2, ServerCrash, LogIn, Pencil, Trash2, Router, Save,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Backend connection
// ---------------------------------------------------------------------------
const API_BASE = (typeof window !== "undefined" && window.SENTINEL_API_BASE) || "http://localhost:4000";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLORS = {
  bg: "#0B1220", panel: "#121B2E", panelAlt: "#0E1626", border: "#1E2A42", borderLight: "#2A3A56",
  text: "#E7ECF5", textDim: "#8393AD", textFaint: "#546285",
  live: "#34D8B0", alta: "#FF6B4A", media: "#F5B942", baja: "#5B7FDB",
};
const PRIORITY_META = {
  alta: { label: "Alta", color: COLORS.alta },
  media: { label: "Media", color: COLORS.media },
  baja: { label: "Baja", color: COLORS.baja },
};

const DEMO_CAMERAS = [
  { id: "d1", name: "Entrada Principal", zone: "Perímetro", rtsp: "rtsp://192.168.1.11:554/stream1", priority: "alta", ptz: true, online: true },
  { id: "d2", name: "Recepción", zone: "Interior", rtsp: "rtsp://192.168.1.12:554/stream1", priority: "media", ptz: false, online: true },
  { id: "d3", name: "Estacionamiento Norte", zone: "Perímetro", rtsp: "rtsp://192.168.1.13:554/stream1", priority: "alta", ptz: true, online: true },
  { id: "d4", name: "Muelle de Carga", zone: "Logística", rtsp: "rtsp://192.168.1.14:554/stream1", priority: "media", ptz: true, online: true },
  { id: "d5", name: "Pasillo Piso 2", zone: "Interior", rtsp: "rtsp://192.168.1.15:554/stream1", priority: "baja", ptz: false, online: true },
  { id: "d6", name: "Bodega A", zone: "Logística", rtsp: "rtsp://192.168.1.16:554/stream1", priority: "media", ptz: false, online: false },
  { id: "d7", name: "Sala de Servidores", zone: "Interior", rtsp: "rtsp://192.168.1.17:554/stream1", priority: "alta", ptz: false, online: true },
  { id: "d8", name: "Perímetro Sur", zone: "Perímetro", rtsp: "rtsp://192.168.1.18:554/stream1", priority: "alta", ptz: true, online: true },
  { id: "d9", name: "Azotea", zone: "Perímetro", rtsp: "rtsp://192.168.1.19:554/stream1", priority: "baja", ptz: true, online: true },
];

const DEMO_NETWORKS = [
  { id: "net-red3", name: "Red 3", cidr: "192.168.3.0/24" },
  { id: "net-red2", name: "Red 2", cidr: "192.168.2.0/24" },
  { id: "net-red1", name: "Red 1", cidr: "192.168.1.0/24" },
];

const LAYOUTS = {
  "2x2": { cols: 2, count: 4, icon: Grid2x2, label: "2×2" },
  "3x3": { cols: 3, count: 9, icon: Grid3x3, label: "3×3" },
  "4x4": { cols: 4, count: 16, icon: LayoutGrid, label: "4×4" },
};

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}
const pad = (n) => n.toString().padStart(2, "0");

// ---------------------------------------------------------------------------
// Responsive helpers
// ---------------------------------------------------------------------------
function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}
function useBreakpoint() {
  const w = useWindowWidth();
  if (w < 640) return "sm";
  if (w < 1024) return "md";
  return "lg";
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
function useSentinelApi() {
  const [token, setToken] = useState(null);
  const [connected, setConnected] = useState(null); // null=checking, true/false
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    fetch(`${API_BASE}/api/health`, { signal: ctrl.signal })
      .then((r) => { if (!cancelled) setConnected(r.ok); })
      .catch(() => { if (!cancelled) setConnected(false); })
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  const login = useCallback(async (username, password) => {
    setAuthError("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setAuthError(data.error || "No se pudo iniciar sesión"); return false; }
      setToken(data.token);
      return true;
    } catch {
      setAuthError("No se pudo contactar al servidor");
      return false;
    }
  }, []);

  const authedFetch = useCallback(
    (path, opts = {}) =>
      fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
      }),
    [token]
  );

  return { connected, token, login, authError, authedFetch };
}

// ---------------------------------------------------------------------------
// Reproductor de video real: negocia WebRTC (protocolo WHEP) directamente
// contra MediaMTX. Si la conexión se cae, reintenta solo con backoff, y
// también expone un botón para forzar la reconexión manualmente.
// ---------------------------------------------------------------------------
async function connectWhep(url, videoEl) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const remoteStream = new MediaStream();
  videoEl.srcObject = remoteStream;
  pc.ontrack = (event) => remoteStream.addTrack(event.track);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });
  if (!res.ok) {
    pc.close();
    throw new Error(`WHEP rechazado (${res.status}) — revisa que la cámara esté conectándose en MediaMTX`);
  }
  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  return pc;
}

function LiveVideo({ camera, api, muted }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const retryRef = useRef(null);
  const [status, setStatus] = useState("connecting"); // connecting | live | error
  const [attempt, setAttempt] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [errorDetail, setErrorDetail] = useState("");

  const cleanup = () => {
    clearTimeout(retryRef.current);
    pcRef.current?.close();
    pcRef.current = null;
  };

  const connect = useCallback(async () => {
    cleanup();
    setStatus("connecting");
    try {
      const pc = await connectWhep(camera.playback.webrtc, videoRef.current);
      pcRef.current = pc;
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") { setStatus("live"); setErrorDetail(""); }
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          setStatus("error");
          setErrorDetail("La conexión WebRTC se cortó");
          scheduleRetry();
        }
      };
    } catch (err) {
      setStatus("error");
      setErrorDetail(err.message || "No se pudo conectar");
      scheduleRetry();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.playback?.webrtc]);

  function scheduleRetry() {
    const delay = Math.min(15000, 2000 * Math.pow(1.6, attempt));
    retryRef.current = setTimeout(() => setAttempt((a) => a + 1), delay);
  }

  useEffect(() => { connect(); return cleanup; }, [connect, attempt]);

  const manualReconnect = async () => {
    setReconnecting(true);
    // Le pide al backend que fuerce a MediaMTX a soltar y reintentar la conexión RTSP con la cámara
    try {
      const res = await api?.authedFetch?.(`/api/cameras/${camera.id}/reconnect`, { method: "POST" });
      if (res && !res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorDetail(data.detail || data.error || "MediaMTX rechazó la reconexión");
      }
    } catch {
      setErrorDetail("No se pudo contactar al backend para reconectar");
    }
    await new Promise((r) => setTimeout(r, 800));
    setAttempt((a) => a + 1);
    setReconnecting(false);
  };

  return (
    <div className="absolute inset-0 bg-black">
      <video ref={videoRef} autoPlay playsInline muted={muted} className="absolute inset-0 w-full h-full object-contain" />
      {status !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center" style={{ background: "rgba(7,11,20,0.92)" }}>
          {status === "connecting" ? (
            <>
              <Loader2 size={18} className="animate-spin" style={{ color: COLORS.textDim }} />
              <span className="text-[10px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>CONECTANDO…</span>
            </>
          ) : (
            <>
              <WifiOff size={20} style={{ color: COLORS.alta }} />
              <span className="text-[10px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>SEÑAL PERDIDA</span>
              {errorDetail && (
                <span className="text-[9px] font-mono break-all max-w-full" style={{ color: COLORS.alta }}>{errorDetail}</span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); manualReconnect(); }}
                className="mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-medium"
                style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text, background: COLORS.panelAlt }}
              >
                {reconnecting ? <Loader2 size={11} className="animate-spin" /> : <RadarIcon size={11} />}
                Reconectar
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simulated video surface — SOLO se usa para cámaras de demostración (sin backend real).
// Cuando la cámara tiene playback.webrtc real, se usa LiveVideo (arriba) en su lugar.
// ---------------------------------------------------------------------------
function FeedSurface({ camera, zoom, api, muted = true }) {
  const now = useClock();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const hasRealStream = Boolean(camera.playback?.webrtc) && Boolean(api?.token);

  if (hasRealStream) {
    return (
      <div className="absolute inset-0 overflow-hidden transition-transform duration-300" style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}>
        <LiveVideo camera={camera} api={api} muted={muted} />
      </div>
    );
  }

  if (!camera.online) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: "#070B14" }}>
        <WifiOff size={22} style={{ color: COLORS.textFaint }} />
        <span className="text-[11px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>SEÑAL PERDIDA</span>
      </div>
    );
  }

  const hue = (String(camera.id).length * 47 + camera.name.length * 13) % 360;
  return (
    <div className="absolute inset-0 overflow-hidden transition-transform duration-300" style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}>
      <div className="absolute inset-0" style={{ background: `radial-gradient(circle at 30% 20%, hsl(${hue} 35% 16%), #070B14 70%)` }} />
      <svg className="absolute inset-0 w-full h-full opacity-[0.12]" preserveAspectRatio="none">
        <line x1="0" y1="70%" x2="100%" y2="62%" stroke="#fff" strokeWidth="1" />
        <line x1="0" y1="85%" x2="100%" y2="80%" stroke="#fff" strokeWidth="1" />
        <line x1="20%" y1="0" x2="15%" y2="100%" stroke="#fff" strokeWidth="1" />
        <line x1="80%" y1="0" x2="85%" y2="100%" stroke="#fff" strokeWidth="1" />
      </svg>
      <div className="absolute inset-0 pointer-events-none scanline" />
      <div className="absolute inset-0 flex items-center justify-center">
        <CameraIcon size={28} style={{ color: "rgba(255,255,255,0.06)" }} />
      </div>
      <div className="absolute bottom-1.5 left-2 font-mono text-[10px] tracking-wide hidden xs:block" style={{ color: "rgba(231,236,245,0.55)" }}>{ts}</div>
      <div className="absolute bottom-1.5 right-2 font-mono text-[10px] tracking-wide hidden sm:block" style={{ color: "rgba(231,236,245,0.4)" }}>1080p · 25fps</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera tile
// ---------------------------------------------------------------------------
function CameraTile({ camera, onExpand, api }) {
  const [zoom, setZoom] = useState(1);
  const [muted, setMuted] = useState(true);
  const [hover, setHover] = useState(false);
  const pMeta = PRIORITY_META[camera.priority] || PRIORITY_META.media;

  return (
    <div
      className="relative rounded-md overflow-hidden group"
      style={{ background: "#070B14", border: `1px solid ${camera.online ? COLORS.border : "#3a1f1f"}`, boxShadow: hover ? `0 0 0 1px ${pMeta.color}55, 0 8px 24px -8px rgba(0,0,0,0.6)` : "none", transition: "box-shadow 150ms ease" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onExpand(camera)}
    >
      <div className="aspect-video relative">
        <FeedSurface camera={camera} zoom={zoom} api={api} muted={muted} />
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-2 py-1.5 bg-gradient-to-b from-black/70 to-transparent">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: pMeta.color, boxShadow: `0 0 6px ${pMeta.color}` }} />
            <span className="text-[11px] sm:text-[12px] font-medium truncate" style={{ color: COLORS.text }}>{camera.name}</span>
          </div>
          {camera.online && (
            <span className="flex items-center gap-1 px-1.5 py-[1px] rounded flex-shrink-0" style={{ background: "rgba(52,216,176,0.12)" }}>
              <Circle size={6} fill={COLORS.live} style={{ color: COLORS.live }} className="animate-pulse" />
              <span className="text-[9px] font-mono tracking-wider hidden xs:inline" style={{ color: COLORS.live }}>LIVE</span>
            </span>
          )}
        </div>
        <div className="absolute top-1.5 right-1.5 mt-6 px-1.5 py-[1px] rounded text-[9px] font-mono tracking-wide" style={{ background: `${pMeta.color}1f`, color: pMeta.color, border: `1px solid ${pMeta.color}40` }}>
          {pMeta.label.toUpperCase()}
        </div>
        {hover && camera.online && (
          <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 hidden sm:flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1">
              <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))} className="p-1 rounded hover:bg-white/10"><ZoomOut size={13} style={{ color: COLORS.text }} /></button>
              <span className="text-[10px] font-mono w-8 text-center" style={{ color: COLORS.textDim }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="p-1 rounded hover:bg-white/10"><ZoomIn size={13} style={{ color: COLORS.text }} /></button>
              <button onClick={() => setMuted((m) => !m)} className="p-1 rounded hover:bg-white/10 ml-1">{muted ? <MicOff size={13} style={{ color: COLORS.textDim }} /> : <Mic size={13} style={{ color: COLORS.live }} />}</button>
              {camera.ptz && <Move size={13} style={{ color: COLORS.baja }} className="ml-1" />}
            </div>
            <button onClick={() => onExpand(camera)} className="p-1 rounded hover:bg-white/10"><Maximize2 size={13} style={{ color: COLORS.text }} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fullscreen focus view w/ PTZ pad (responsive: side panel stacks below on mobile)
// ---------------------------------------------------------------------------
function FocusView({ camera, onClose, api, onEdit }) {
  const [zoom, setZoom] = useState(1);
  const [muted, setMuted] = useState(false);
  const bp = useBreakpoint();
  const pMeta = PRIORITY_META[camera.priority] || PRIORITY_META.media;

  const sendPtz = async (pan, tilt) => {
    if (!api?.token) return; // modo demo: sin backend real, solo UI
    await api.authedFetch(`/api/cameras/${camera.id}/ptz/move`, { method: "POST", body: JSON.stringify({ pan, tilt, zoom: 0 }) }).catch(() => {});
    setTimeout(() => api.authedFetch(`/api/cameras/${camera.id}/ptz/stop`, { method: "POST" }).catch(() => {}), 400);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6" style={{ background: "rgba(3,6,12,0.88)" }}>
      <div className="w-full max-w-4xl max-h-full overflow-y-auto rounded-lg" style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between px-3 sm:px-4 py-3 sticky top-0 z-10" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.panel }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: pMeta.color, boxShadow: `0 0 6px ${pMeta.color}` }} />
            <h3 className="text-sm font-semibold truncate" style={{ color: COLORS.text }}>{camera.name}</h3>
            <span className="text-[10px] font-mono px-1.5 py-[1px] rounded hidden sm:inline" style={{ color: COLORS.textDim, border: `1px solid ${COLORS.border}` }}>{camera.zone}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 flex-shrink-0"><X size={16} style={{ color: COLORS.textDim }} /></button>
        </div>

        <div className={bp === "lg" ? "flex" : "flex flex-col"}>
          <div className="relative flex-1 aspect-video">
            <FeedSurface camera={camera} zoom={zoom} api={api} muted={muted} />
          </div>

          <div className={bp === "lg" ? "w-52 p-3 flex flex-col gap-4" : "p-3 flex flex-col gap-4"} style={{ borderLeft: bp === "lg" ? `1px solid ${COLORS.border}` : "none", borderTop: bp === "lg" ? "none" : `1px solid ${COLORS.border}`, background: COLORS.panelAlt }}>
            <div>
              <div className="text-[10px] font-mono tracking-wide mb-1.5" style={{ color: COLORS.textFaint }}>ZOOM</div>
              <div className="flex items-center gap-2">
                <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))} className="p-1.5 rounded" style={{ border: `1px solid ${COLORS.border}` }}><ZoomOut size={13} style={{ color: COLORS.text }} /></button>
                <div className="flex-1 h-1 rounded-full relative" style={{ background: COLORS.border }}>
                  <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${((zoom - 1) / 2) * 100}%`, background: COLORS.live }} />
                </div>
                <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="p-1.5 rounded" style={{ border: `1px solid ${COLORS.border}` }}><ZoomIn size={13} style={{ color: COLORS.text }} /></button>
              </div>
            </div>

            {camera.ptz ? (
              <div>
                <div className="text-[10px] font-mono tracking-wide mb-1.5" style={{ color: COLORS.textFaint }}>CONTROL PTZ</div>
                <div className="grid grid-cols-3 gap-1 w-fit mx-auto">
                  <div />
                  <button onClick={() => sendPtz(0, 1)} className="p-2 rounded hover:bg-white/10" style={{ border: `1px solid ${COLORS.border}` }}><ChevronUp size={14} style={{ color: COLORS.text }} /></button>
                  <div />
                  <button onClick={() => sendPtz(-1, 0)} className="p-2 rounded hover:bg-white/10" style={{ border: `1px solid ${COLORS.border}` }}><ChevronLeft size={14} style={{ color: COLORS.text }} /></button>
                  <button onClick={() => api?.token && api.authedFetch(`/api/cameras/${camera.id}/ptz/home`, { method: "POST" }).catch(() => {})} className="p-2 rounded hover:bg-white/10" style={{ border: `1px solid ${COLORS.border}`, background: `${COLORS.live}15` }}><Home size={14} style={{ color: COLORS.live }} /></button>
                  <button onClick={() => sendPtz(1, 0)} className="p-2 rounded hover:bg-white/10" style={{ border: `1px solid ${COLORS.border}` }}><ChevronRight size={14} style={{ color: COLORS.text }} /></button>
                  <div />
                  <button onClick={() => sendPtz(0, -1)} className="p-2 rounded hover:bg-white/10" style={{ border: `1px solid ${COLORS.border}` }}><ChevronDown size={14} style={{ color: COLORS.text }} /></button>
                  <div />
                </div>
                <p className="text-[10px] mt-2 text-center" style={{ color: COLORS.textFaint }}>Mueve la cámara con las flechas · centro = Home</p>
              </div>
            ) : (
              <div className="text-[11px] leading-relaxed" style={{ color: COLORS.textFaint }}>Esta cámara no tiene motor PTZ habilitado.</div>
            )}

            <div>
              <div className="text-[10px] font-mono tracking-wide mb-1.5" style={{ color: COLORS.textFaint }}>AUDIO</div>
              <button onClick={() => setMuted((m) => !m)} className="w-full flex items-center justify-center gap-2 py-1.5 rounded text-[12px]" style={{ border: `1px solid ${COLORS.border}`, color: muted ? COLORS.textDim : COLORS.live }}>
                {muted ? <MicOff size={13} /> : <Mic size={13} />} {muted ? "Activar audio" : "Silenciar"}
              </button>
            </div>

            <div className="pt-2 text-[10px] font-mono leading-relaxed break-all" style={{ color: COLORS.textFaint, borderTop: `1px solid ${COLORS.border}` }}>
              <div className="pt-2">RTSP: {camera.rtsp}</div>
              <div>Prioridad: <span style={{ color: pMeta.color }}>{pMeta.label}</span></div>
            </div>
            <button onClick={onEdit} className="flex items-center justify-center gap-2 py-1.5 rounded text-[12px]" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textDim }}>
              <Pencil size={12} /> Editar cámara
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network scanner panel (Red 3 -> Red 2 -> Red 1, con soporte real SSE o simulación)
// ---------------------------------------------------------------------------
function ScannerPanel({ api, existingHosts, onPick }) {
  const [running, setRunning] = useState(false);
  const [networks, setNetworks] = useState(DEMO_NETWORKS);
  const [progress, setProgress] = useState({});   // { networkId: { scanned, total, done } }
  const [devices, setDevices] = useState([]);
  const [showCreds, setShowCreds] = useState(false);
  const [scanUser, setScanUser] = useState("");
  const [scanPass, setScanPass] = useState("");
  const esRef = useRef(null);
  const simTimer = useRef(null);
  const demo = !api.connected || !api.token;

  useEffect(() => {
    if (api.connected && api.token) {
      api.authedFetch("/api/networks").then((r) => r.json()).then(setNetworks).catch(() => {});
    }
    return () => {
      esRef.current?.close();
      clearTimeout(simTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.connected, api.token]);

  const startRealScan = () => {
    setDevices([]);
    setProgress({});
    setRunning(true);
    const params = new URLSearchParams({ token: api.token });
    if (scanUser) params.set("user", scanUser);
    if (scanPass) params.set("pass", scanPass);
    const es = new EventSource(`${API_BASE}/api/scan/stream?${params.toString()}`);
    esRef.current = es;
    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === "network_start") {
        setProgress((p) => ({ ...p, [data.networkId]: { scanned: 0, total: 1, done: false, name: data.name } }));
      } else if (data.type === "network_progress") {
        setProgress((p) => ({ ...p, [data.networkId]: { ...p[data.networkId], scanned: data.scanned, total: data.total } }));
      } else if (data.type === "device_found") {
        setDevices((d) => [...d, data.device]);
      } else if (data.type === "network_done") {
        setProgress((p) => ({ ...p, [data.networkId]: { ...p[data.networkId], done: true } }));
      } else if (data.type === "scan_complete" || data.type === "scan_error") {
        setRunning(false);
        es.close();
      }
    };
    es.onerror = () => { setRunning(false); es.close(); };
  };

  // Simulación local: útil para mostrar el flujo cuando el backend Sentinel no está conectado.
  const startSimulatedScan = () => {
    setDevices([]);
    setProgress({});
    setRunning(true);
    const order = DEMO_NETWORKS; // ya viene en orden Red3 -> Red2 -> Red1
    let netIdx = 0;

    const runNetwork = () => {
      if (netIdx >= order.length) { setRunning(false); return; }
      const net = order[netIdx];
      const total = 254;
      let scanned = 0;
      setProgress((p) => ({ ...p, [net.id]: { scanned: 0, total, done: false, name: net.name } }));

      const tick = () => {
        scanned += Math.floor(Math.random() * 30) + 15;
        if (scanned >= total) scanned = total;
        setProgress((p) => ({ ...p, [net.id]: { ...p[net.id], scanned } }));

        if (scanned === total) {
          // 1-2 dispositivos simulados encontrados por red
          const found = Math.random() > 0.3 ? 1 + Math.floor(Math.random() * 2) : 0;
          for (let i = 0; i < found; i++) {
            const lastOctet = 20 + Math.floor(Math.random() * 200);
            const base = net.cidr.split("/")[0].split(".").slice(0, 3).join(".");
            const host = `${base}.${lastOctet}`;
            const willVerify = Math.random() > 0.3;
            setDevices((d) => [...d, {
              networkId: net.id, networkName: net.name, host,
              openPorts: [554, 80], isNew: !existingHosts.has(host),
              manufacturer: ["Hikvision", "Dahua", "Axis", "Genérico ONVIF"][Math.floor(Math.random() * 4)],
              model: "IPC-" + Math.floor(Math.random() * 9000 + 1000),
              ptz: Math.random() > 0.5, onvifPort: 80,
              rtspUrl: `rtsp://${host}:554/stream1`, identified: true,
              verified: willVerify, requiresAuth: !willVerify,
            }]);
          }
          setProgress((p) => ({ ...p, [net.id]: { ...p[net.id], done: true } }));
          netIdx++;
          simTimer.current = setTimeout(runNetwork, 400);
        } else {
          simTimer.current = setTimeout(tick, 90);
        }
      };
      tick();
    };
    runNetwork();
  };

  const start = () => (demo ? startSimulatedScan() : startRealScan());

  return (
    <div className="rounded-md p-3" style={{ border: `1px solid ${COLORS.border}`, background: COLORS.panelAlt }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <RadarIcon size={14} style={{ color: COLORS.live }} />
          <span className="text-[12px] font-semibold" style={{ color: COLORS.text }}>Escáner de red multi-segmento</span>
        </div>
        <button
          onClick={start}
          disabled={running}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium disabled:opacity-50"
          style={{ background: `${COLORS.live}1f`, color: COLORS.live, border: `1px solid ${COLORS.live}40` }}
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <RadarIcon size={12} />}
          {running ? "Escaneando…" : "Iniciar escaneo"}
        </button>
      </div>

      {demo && (
        <div className="flex items-center gap-1.5 mb-2 text-[10px] px-2 py-1 rounded" style={{ color: COLORS.media, background: `${COLORS.media}12`, border: `1px solid ${COLORS.media}30` }}>
          <ServerCrash size={11} /> Backend no conectado — mostrando una simulación del escaneo. Conecta Sentinel VMS backend para resultados reales.
        </div>
      )}

      <button onClick={() => setShowCreds((s) => !s)} className="text-[10px] font-mono mb-2 underline" style={{ color: COLORS.textFaint }}>
        {showCreds ? "Ocultar" : "Usar"} credenciales para autenticar durante el escaneo (opcional)
      </button>
      {showCreds && (
        <div className="flex gap-1.5 mb-2">
          <input value={scanUser} onChange={(e) => setScanUser(e.target.value)} placeholder="Usuario de las cámaras" className="flex-1 min-w-0 bg-transparent outline-none text-[11px] py-1 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          <input value={scanPass} onChange={(e) => setScanPass(e.target.value)} type="password" placeholder="Contraseña" className="flex-1 min-w-0 bg-transparent outline-none text-[11px] py-1 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
        </div>
      )}

      <p className="text-[10px] mb-2" style={{ color: COLORS.textFaint }}>
        Orden de escaneo: red más alejada primero → red local del servidor al final. Las URL se validan contra el dispositivo real, no se adivinan a ciegas.
      </p>

      <div className="flex flex-col gap-2">
        {DEMO_NETWORKS.map((net) => {
          const p = progress[net.id];
          const pct = p && p.total ? Math.min(100, Math.round((p.scanned / p.total) * 100)) : 0;
          return (
            <div key={net.id}>
              <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                <span style={{ color: p ? COLORS.text : COLORS.textFaint }}>{net.name} · {net.cidr}</span>
                {p?.done ? <CheckCircle2 size={12} style={{ color: COLORS.live }} /> : p ? <span style={{ color: COLORS.textDim }}>{pct}%</span> : null}
              </div>
              <div className="h-1 rounded-full" style={{ background: COLORS.border }}>
                <div className="h-1 rounded-full transition-all" style={{ width: `${pct}%`, background: p?.done ? COLORS.live : COLORS.baja }} />
              </div>
            </div>
          );
        })}
      </div>

      {devices.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 max-h-56 overflow-y-auto">
          {devices.map((d, i) => (
            <button
              key={i}
              onClick={() => onPick(d)}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left hover:bg-white/5"
              style={{ border: `1px solid ${COLORS.border}` }}
            >
              <div className="min-w-0">
                <div className="text-[11px] font-mono truncate" style={{ color: COLORS.text }}>{d.host} <span style={{ color: COLORS.textFaint }}>· {d.networkName}</span></div>
                <div className="text-[10px] truncate" style={{ color: COLORS.textFaint }}>{d.manufacturer}{d.model ? ` ${d.model}` : ""} {d.ptz ? "· PTZ" : ""}</div>
                {d.rtspUrl && (
                  <div className="flex items-center gap-1 mt-0.5">
                    {d.verified ? <CheckCircle2 size={10} style={{ color: COLORS.live }} /> : <AlertTriangle size={10} style={{ color: COLORS.media }} />}
                    <span className="text-[9px] font-mono truncate" style={{ color: d.verified ? COLORS.live : COLORS.media }}>
                      {d.verified ? "URL verificada" : d.requiresAuth ? "requiere usuario/contraseña" : "sin confirmar"}
                    </span>
                  </div>
                )}
              </div>
              <span
                className="text-[9px] font-mono px-1.5 py-[1px] rounded flex-shrink-0"
                style={{ color: d.isNew ? COLORS.live : COLORS.textFaint, border: `1px solid ${d.isNew ? COLORS.live + "50" : COLORS.border}` }}
              >
                {d.isNew ? "NUEVA" : "YA AGREGADA"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add camera modal (con escáner integrado)
// ---------------------------------------------------------------------------
function AddCameraModal({ onClose, onSave, api, existingHosts }) {
  const [form, setForm] = useState({ name: "", zone: "", rtsp: "", priority: "media", ptz: false, manufacturer: "", onvifHost: "" });

  const applyDiscovered = (d) => {
    setForm((f) => ({
      ...f,
      name: f.name || `${d.manufacturer || "Cámara"} ${d.host.split(".").pop()}`,
      rtsp: d.rtspUrl || f.rtsp,
      ptz: d.ptz,
      manufacturer: d.manufacturer || "",
      onvifHost: d.host,
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6" style={{ background: "rgba(3,6,12,0.88)" }}>
      <div className="w-full max-w-lg max-h-full overflow-y-auto rounded-lg" style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between px-4 py-3 sticky top-0 z-10" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.panel }}>
          <h3 className="text-sm font-semibold" style={{ color: COLORS.text }}>Agregar cámara</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10"><X size={16} style={{ color: COLORS.textDim }} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <ScannerPanel api={api} existingHosts={existingHosts} onPick={applyDiscovered} />

          <div className="text-[10px] font-mono tracking-wide text-center py-1" style={{ color: COLORS.textFaint }}>— o completa manualmente —</div>

          <Field label="Nombre">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Entrada Principal"
              className="w-full bg-transparent outline-none text-[13px] py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="Zona">
            <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} placeholder="Ej. Perímetro"
              className="w-full bg-transparent outline-none text-[13px] py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="URL RTSP">
            <input value={form.rtsp} onChange={(e) => setForm({ ...form, rtsp: e.target.value })} placeholder="rtsp://usuario:contraseña@ip:554/stream"
              className="w-full bg-transparent outline-none text-[12px] font-mono py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="Prioridad">
            <div className="flex gap-1.5">
              {Object.entries(PRIORITY_META).map(([key, meta]) => (
                <button key={key} onClick={() => setForm({ ...form, priority: key })} className="flex-1 py-1.5 rounded text-[12px] font-medium"
                  style={{ border: `1px solid ${form.priority === key ? meta.color : COLORS.border}`, background: form.priority === key ? `${meta.color}1f` : "transparent", color: form.priority === key ? meta.color : COLORS.textDim }}>
                  {meta.label}
                </button>
              ))}
            </div>
          </Field>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none" style={{ color: COLORS.textDim }}>
            <input type="checkbox" checked={form.ptz} onChange={(e) => setForm({ ...form, ptz: e.target.checked })} className="accent-current" />
            Esta cámara tiene motor PTZ (se puede mover)
          </label>

          <button disabled={!form.name || !form.rtsp} onClick={() => onSave(form)} className="mt-2 py-2 rounded text-[13px] font-semibold disabled:opacity-40" style={{ background: COLORS.live, color: "#06231C" }}>
            Guardar cámara
          </button>
        </div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return (<div><div className="text-[10px] font-mono tracking-wide mb-1" style={{ color: COLORS.textFaint }}>{label.toUpperCase()}</div>{children}</div>);
}

// ---------------------------------------------------------------------------
// Edit camera modal
// ---------------------------------------------------------------------------
function EditCameraModal({ camera, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    name: camera.name || "",
    zone: camera.zone || "",
    rtsp: camera.rtsp || "",
    priority: camera.priority || "media",
    ptz: Boolean(camera.ptz),
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6" style={{ background: "rgba(3,6,12,0.88)" }}>
      <div className="w-full max-w-lg max-h-full overflow-y-auto rounded-lg" style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between px-4 py-3 sticky top-0 z-10" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.panel }}>
          <h3 className="text-sm font-semibold" style={{ color: COLORS.text }}>Editar cámara</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10"><X size={16} style={{ color: COLORS.textDim }} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <Field label="Nombre">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-transparent outline-none text-[13px] py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="Zona">
            <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}
              className="w-full bg-transparent outline-none text-[13px] py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="URL RTSP">
            <input value={form.rtsp} onChange={(e) => setForm({ ...form, rtsp: e.target.value })}
              className="w-full bg-transparent outline-none text-[12px] font-mono py-1.5 px-2 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          </Field>
          <Field label="Prioridad">
            <div className="flex gap-1.5">
              {Object.entries(PRIORITY_META).map(([key, meta]) => (
                <button key={key} onClick={() => setForm({ ...form, priority: key })} className="flex-1 py-1.5 rounded text-[12px] font-medium"
                  style={{ border: `1px solid ${form.priority === key ? meta.color : COLORS.border}`, background: form.priority === key ? `${meta.color}1f` : "transparent", color: form.priority === key ? meta.color : COLORS.textDim }}>
                  {meta.label}
                </button>
              ))}
            </div>
          </Field>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none" style={{ color: COLORS.textDim }}>
            <input type="checkbox" checked={form.ptz} onChange={(e) => setForm({ ...form, ptz: e.target.checked })} className="accent-current" />
            Esta cámara tiene motor PTZ (se puede mover)
          </label>

          <button disabled={!form.name || !form.rtsp} onClick={() => onSave(camera.id, form)} className="mt-1 py-2 rounded text-[13px] font-semibold disabled:opacity-40" style={{ background: COLORS.live, color: "#06231C" }}>
            Guardar cambios
          </button>

          <div className="pt-3 mt-1" style={{ borderTop: `1px solid ${COLORS.border}` }}>
            {!confirmingDelete ? (
              <button onClick={() => setConfirmingDelete(true)} className="w-full flex items-center justify-center gap-2 py-2 rounded text-[12px] font-medium" style={{ border: `1px solid ${COLORS.alta}40`, color: COLORS.alta }}>
                <Trash2 size={13} /> Eliminar cámara
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-center" style={{ color: COLORS.alta }}>¿Seguro? Esto elimina la cámara y su grabación asociada.</p>
                <div className="flex gap-2">
                  <button onClick={() => setConfirmingDelete(false)} className="flex-1 py-1.5 rounded text-[12px]" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textDim }}>Cancelar</button>
                  <button onClick={() => onDelete(camera.id)} className="flex-1 py-1.5 rounded text-[12px] font-semibold" style={{ background: COLORS.alta, color: "#2a0e08" }}>Sí, eliminar</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar (drawer on mobile/tablet)
// ---------------------------------------------------------------------------
function Sidebar({ cameras, query, setQuery, onSelect, onOpenAdd, onEdit, isDrawer, open, onCloseDrawer }) {
  const order = { alta: 0, media: 1, baja: 2 };
  const filtered = cameras
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || (c.zone || "").toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => order[a.priority] - order[b.priority]);

  const content = (
    <div className="w-64 flex flex-col h-full" style={{ background: COLORS.panel, borderRight: `1px solid ${COLORS.border}` }}>
      <div className="p-3 flex items-center gap-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
        <div className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded" style={{ border: `1px solid ${COLORS.border}` }}>
          <Search size={12} style={{ color: COLORS.textFaint }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cámara o zona" className="bg-transparent outline-none text-[12px] w-full" style={{ color: COLORS.text }} />
        </div>
        {isDrawer && (
          <button onClick={onCloseDrawer} className="p-1.5 rounded hover:bg-white/10 flex-shrink-0"><X size={14} style={{ color: COLORS.textDim }} /></button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.map((c) => {
          const meta = PRIORITY_META[c.priority] || PRIORITY_META.media;
          return (
            <div key={c.id} className="w-full flex items-center gap-1 px-3 py-2 hover:bg-white/[0.04] group/row">
              <button onClick={() => { onSelect(c); onCloseDrawer?.(); }} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: c.online ? meta.color : COLORS.textFaint }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] truncate" style={{ color: COLORS.text }}>{c.name}</div>
                  <div className="text-[10px] font-mono truncate" style={{ color: COLORS.textFaint }}>{c.zone}</div>
                </div>
                {c.ptz && <Move size={11} style={{ color: COLORS.textFaint }} className="flex-shrink-0" />}
                {!c.online && <AlertTriangle size={11} style={{ color: COLORS.alta }} className="flex-shrink-0" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(c); }}
                className="p-1 rounded hover:bg-white/10 flex-shrink-0 opacity-60 hover:opacity-100"
                title="Editar cámara"
              >
                <Pencil size={12} style={{ color: COLORS.textDim }} />
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="px-3 py-6 text-center text-[11px]" style={{ color: COLORS.textFaint }}>Sin resultados</div>}
      </div>
      <button onClick={onOpenAdd} className="m-3 flex items-center justify-center gap-1.5 py-2 rounded text-[12px] font-medium" style={{ border: `1px dashed ${COLORS.borderLight}`, color: COLORS.textDim }}>
        <Plus size={13} /> Agregar cámara
      </button>
    </div>
  );

  if (!isDrawer) return content;

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}>
      <div onClick={onCloseDrawer} className="absolute inset-0 transition-opacity" style={{ background: "rgba(3,6,12,0.6)", opacity: open ? 1 : 0 }} />
      <div className="absolute left-0 top-0 bottom-0 transition-transform" style={{ transform: open ? "translateX(0)" : "translateX(-100%)" }}>
        {content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar (responsive)
// ---------------------------------------------------------------------------
function TopBar({ layoutKey, setLayoutKey, onlineCount, total, onOpenSettings, onMenu, bp }) {
  const now = useClock();
  return (
    <div className="h-14 flex items-center justify-between px-3 sm:px-4 flex-shrink-0" style={{ background: COLORS.panel, borderBottom: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {bp !== "lg" && (
          <button onClick={onMenu} className="p-1.5 rounded hover:bg-white/10 flex-shrink-0"><Menu size={18} style={{ color: COLORS.text }} /></button>
        )}
        <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0" style={{ background: `${COLORS.live}18` }}>
          <Video size={15} style={{ color: COLORS.live }} />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-none truncate" style={{ color: COLORS.text }}>SENTINEL VMS</div>
          <div className="text-[10px] font-mono mt-0.5 hidden sm:block" style={{ color: COLORS.textFaint }}>Panel de operaciones</div>
        </div>
      </div>

      {bp === "lg" ? (
        <div className="flex items-center gap-1 p-0.5 rounded-md" style={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.border}` }}>
          {Object.entries(LAYOUTS).map(([key, l]) => {
            const Icon = l.icon; const active = layoutKey === key;
            return (
              <button key={key} onClick={() => setLayoutKey(key)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium"
                style={{ background: active ? COLORS.panel : "transparent", color: active ? COLORS.text : COLORS.textFaint, border: active ? `1px solid ${COLORS.borderLight}` : "1px solid transparent" }}>
                <Icon size={13} /> {l.label}
              </button>
            );
          })}
        </div>
      ) : (
        <select value={layoutKey} onChange={(e) => setLayoutKey(e.target.value)} className="text-[11px] font-mono rounded px-2 py-1.5" style={{ background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}` }}>
          {Object.entries(LAYOUTS).map(([key, l]) => <option key={key} value={key}>{l.label}</option>)}
        </select>
      )}

      <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
        <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <Wifi size={12} style={{ color: COLORS.live }} /> {onlineCount}/{total} en línea
        </div>
        <div className="text-[11px] sm:text-[12px] font-mono" style={{ color: COLORS.textDim }}>{pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}</div>
        <button onClick={onOpenSettings} className="p-1.5 rounded hover:bg-white/10"><Settings size={15} style={{ color: COLORS.textDim }} /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login overlay (solo aparece si el backend está conectado pero no hay sesión)
// ---------------------------------------------------------------------------
function LoginOverlay({ api }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: COLORS.bg }}>
      <div className="w-full max-w-sm rounded-lg p-5" style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center gap-2 mb-4">
          <Video size={18} style={{ color: COLORS.live }} />
          <span className="text-sm font-semibold" style={{ color: COLORS.text }}>Sentinel VMS — Iniciar sesión</span>
        </div>
        <div className="flex flex-col gap-3">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario" className="w-full bg-transparent outline-none text-[13px] py-2 px-2.5 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Contraseña" className="w-full bg-transparent outline-none text-[13px] py-2 px-2.5 rounded" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }} />
          {api.authError && <div className="text-[11px]" style={{ color: COLORS.alta }}>{api.authError}</div>}
          <button
            onClick={async () => { setLoading(true); await api.login(username, password); setLoading(false); }}
            className="flex items-center justify-center gap-2 py-2 rounded text-[13px] font-semibold"
            style={{ background: COLORS.live, color: "#06231C" }}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />} Entrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
function MediamtxDiagnostics({ api }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);

  const run = async () => {
    setChecking(true);
    setResult(null);
    try {
      const res = await api.authedFetch("/api/cameras/diagnostics/mediamtx");
      const data = await res.json();
      setResult({ ok: res.ok, ...data });
    } catch (err) {
      setResult({ ok: false, detail: "No se pudo contactar al backend" });
    }
    setChecking(false);
  };

  if (!(api.connected && api.token)) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>CONEXIÓN BACKEND ↔ MEDIAMTX</div>
        <button onClick={run} disabled={checking} className="flex items-center gap-1 px-2 py-1 rounded text-[10px]" style={{ border: `1px solid ${COLORS.border}`, color: COLORS.textDim }}>
          {checking ? <Loader2 size={11} className="animate-spin" /> : <RadarIcon size={11} />} Probar
        </button>
      </div>
      {result && (
        <div className="text-[10px] font-mono px-2 py-1.5 rounded" style={{ color: result.ok ? COLORS.live : COLORS.alta, background: result.ok ? `${COLORS.live}12` : `${COLORS.alta}12`, border: `1px solid ${result.ok ? COLORS.live + "30" : COLORS.alta + "30"}` }}>
          {result.ok ? `✓ Conectado (${result.pathCount ?? 0} cámaras registradas en MediaMTX)` : `✗ ${result.detail || "Sin conexión"} (${result.apiUrl || ""})`}
        </div>
      )}
    </div>
  );
}

function NetworksPanel({ api }) {
  const [networks, setNetworks] = useState(DEMO_NETWORKS.map((n) => ({ ...n, scan_order: 0 })));
  const [saving, setSaving] = useState(null);
  const [savedFlash, setSavedFlash] = useState(null);
  const [newCidr, setNewCidr] = useState("");
  const [newName, setNewName] = useState("");
  const demo = !(api.connected && api.token);

  useEffect(() => {
    if (api.connected && api.token) {
      api.authedFetch("/api/networks").then((r) => r.json()).then(setNetworks).catch(() => {});
    }
  }, [api.connected, api.token]);

  const updateCidr = (id, cidr) => {
    setNetworks((ns) => ns.map((n) => (n.id === id ? { ...n, cidr } : n)));
  };

  const save = async (net) => {
    setSaving(net.id);
    if (api.connected && api.token) {
      await api.authedFetch(`/api/networks/${net.id}`, { method: "PUT", body: JSON.stringify({ name: net.name, cidr: net.cidr, scanOrder: net.scan_order, isLocal: net.is_local }) }).catch(() => {});
    }
    setSaving(null);
    setSavedFlash(net.id);
    setTimeout(() => setSavedFlash(null), 1500);
  };

  const addNetwork = async () => {
    if (!newCidr || !newName) return;
    const scanOrder = (Math.max(0, ...networks.map((n) => n.scan_order || 0)) || 0) + 1;
    if (api.connected && api.token) {
      const res = await api.authedFetch("/api/networks", { method: "POST", body: JSON.stringify({ name: newName, cidr: newCidr, scanOrder }) });
      const created = await res.json();
      setNetworks((ns) => [...ns, created]);
    } else {
      setNetworks((ns) => [...ns, { id: `demo-net-${Date.now()}`, name: newName, cidr: newCidr, scan_order: scanOrder }]);
    }
    setNewCidr(""); setNewName("");
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Router size={12} style={{ color: COLORS.textFaint }} />
        <div className="text-[10px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>REDES A ESCANEAR</div>
      </div>
      {demo && (
        <div className="text-[10px] mb-2 px-2 py-1 rounded" style={{ color: COLORS.media, background: `${COLORS.media}12`, border: `1px solid ${COLORS.media}30` }}>
          Conecta el backend para guardar cambios reales. Aquí solo estás editando la vista de ejemplo.
        </div>
      )}
      <p className="text-[10px] mb-2 leading-relaxed" style={{ color: COLORS.textFaint }}>
        Pon aquí el rango real de cada red (revisa tu IP con <code>ipconfig</code> en Windows: si tu IP es 192.168.2.34, el CIDR es 192.168.2.0/24).
      </p>
      <div className="flex flex-col gap-2">
        {networks.map((net) => (
          <div key={net.id} className="flex items-center gap-1.5">
            <span className="text-[11px] w-12 flex-shrink-0" style={{ color: COLORS.text }}>{net.name}</span>
            <input
              value={net.cidr}
              onChange={(e) => updateCidr(net.id, e.target.value)}
              placeholder="192.168.2.0/24"
              className="flex-1 min-w-0 bg-transparent outline-none text-[11px] font-mono py-1 px-2 rounded"
              style={{ border: `1px solid ${COLORS.border}`, color: COLORS.text }}
            />
            <button onClick={() => save(net)} className="p-1.5 rounded flex-shrink-0" style={{ border: `1px solid ${COLORS.border}` }} title="Guardar">
              {saving === net.id ? <Loader2 size={12} className="animate-spin" style={{ color: COLORS.textDim }} /> : savedFlash === net.id ? <CheckCircle2 size={12} style={{ color: COLORS.live }} /> : <Save size={12} style={{ color: COLORS.textDim }} />}
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 mt-2 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre (Red 4)" className="w-20 flex-shrink-0 bg-transparent outline-none text-[11px] py-1 px-2 rounded" style={{ border: `1px dashed ${COLORS.borderLight}`, color: COLORS.text }} />
        <input value={newCidr} onChange={(e) => setNewCidr(e.target.value)} placeholder="10.0.0.0/24" className="flex-1 min-w-0 bg-transparent outline-none text-[11px] font-mono py-1 px-2 rounded" style={{ border: `1px dashed ${COLORS.borderLight}`, color: COLORS.text }} />
        <button onClick={addNetwork} className="p-1.5 rounded flex-shrink-0" style={{ border: `1px dashed ${COLORS.borderLight}` }} title="Agregar red">
          <Plus size={12} style={{ color: COLORS.textDim }} />
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({ onClose, api }) {
  const [quality, setQuality] = useState("Alta (1080p)");
  const [record, setRecord] = useState(true);
  const [retention, setRetention] = useState(30);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: "rgba(3,6,12,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-xs sm:w-80 h-full p-4 flex flex-col gap-5 overflow-y-auto" style={{ background: COLORS.panel, borderLeft: `1px solid ${COLORS.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: COLORS.text }}>Configuración</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10"><X size={16} style={{ color: COLORS.textDim }} /></button>
        </div>
        <div>
          <div className="text-[10px] font-mono tracking-wide mb-1.5" style={{ color: COLORS.textFaint }}>CALIDAD DE STREAM</div>
          <div className="flex flex-col gap-1.5">
            {["Alta (1080p)", "Media (720p)", "Baja (480p) — ahorro de ancho de banda"].map((q) => (
              <button key={q} onClick={() => setQuality(q)} className="text-left px-2.5 py-1.5 rounded text-[12px]" style={{ border: `1px solid ${quality === q ? COLORS.live : COLORS.border}`, color: quality === q ? COLORS.live : COLORS.textDim, background: quality === q ? `${COLORS.live}10` : "transparent" }}>{q}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12px]" style={{ color: COLORS.text }}>Grabación continua</div>
            <div className="text-[10px]" style={{ color: COLORS.textFaint }}>Graba todos los canales en línea</div>
          </div>
          <button onClick={() => setRecord((r) => !r)} className="w-9 h-5 rounded-full relative flex-shrink-0" style={{ background: record ? COLORS.live : COLORS.border }}>
            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: record ? 18 : 2 }} />
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] font-mono tracking-wide" style={{ color: COLORS.textFaint }}>RETENCIÓN DE GRABACIONES</div>
            <div className="text-[11px] font-mono" style={{ color: COLORS.text }}>{retention} días</div>
          </div>
          <input type="range" min="7" max="90" value={retention} onChange={(e) => setRetention(+e.target.value)} className="w-full accent-current" style={{ color: COLORS.live }} />
        </div>
        <div className="pt-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <MediamtxDiagnostics api={api} />
        </div>
        <div className="pt-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <NetworksPanel api={api} />
        </div>
        <div className="pt-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <div className="text-[10px] font-mono tracking-wide mb-1.5" style={{ color: COLORS.textFaint }}>ALERTAS</div>
          <label className="flex items-center gap-2 text-[12px] mb-2" style={{ color: COLORS.textDim }}><input type="checkbox" defaultChecked className="accent-current" /> Notificar pérdida de señal</label>
          <label className="flex items-center gap-2 text-[12px]" style={{ color: COLORS.textDim }}><input type="checkbox" defaultChecked className="accent-current" /> Notificar cámaras de prioridad alta offline</label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------
export default function CameraOpsDashboard() {
  const api = useSentinelApi();
  const bp = useBreakpoint();

  const [cameras, setCameras] = useState(DEMO_CAMERAS);
  const [layoutKey, setLayoutKey] = useState(bp === "sm" ? "2x2" : "3x3");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusCam, setFocusCam] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editCam, setEditCam] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const demoMode = api.connected === false || (api.connected === true && !api.token);

  // Cargar cámaras reales cuando hay sesión
  useEffect(() => {
    if (api.connected && api.token) {
      api.authedFetch("/api/cameras").then((r) => r.json()).then(setCameras).catch(() => {});
    }
  }, [api.connected, api.token]);

  // Estado en vivo vía WebSocket cuando hay backend real
  useEffect(() => {
    if (!(api.connected && api.token)) return;
    const wsUrl = API_BASE.replace(/^http/, "ws") + "/ws/status";
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "camera_status") {
        setCameras((cs) => cs.map((c) => (c.id === msg.cameraId ? { ...c, online: msg.online } : c)));
      }
    };
    return () => ws.close();
  }, [api.connected, api.token]);

  const layout = LAYOUTS[layoutKey];
  const effectiveCols = bp === "sm" ? 1 : bp === "md" ? Math.min(2, layout.cols) : layout.cols;
  const order = { alta: 0, media: 1, baja: 2 };

  const visible = useMemo(() => {
    const sorted = [...cameras].sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));
    return sorted.slice(0, layout.count);
  }, [cameras, layoutKey]);

  const onlineCount = cameras.filter((c) => c.online).length;
  const existingHosts = useMemo(() => new Set(cameras.map((c) => c.onvifHost).filter(Boolean)), [cameras]);

  const handleSave = async (form) => {
    if (api.connected && api.token) {
      const res = await api.authedFetch("/api/cameras", { method: "POST", body: JSON.stringify(form) });
      const cam = await res.json();
      setCameras((cs) => [...cs, cam]);
      if (cam.mediamtxWarning) {
        setToast({ type: "error", text: `Cámara guardada, pero MediaMTX la rechazó: ${cam.mediamtxWarning}` });
      }
    } else {
      setCameras((cs) => [...cs, { ...form, id: `demo-${Date.now()}`, online: true }]);
    }
    setShowAdd(false);
  };

  const handleUpdate = async (id, form) => {
    if (api.connected && api.token) {
      const res = await api.authedFetch(`/api/cameras/${id}`, { method: "PUT", body: JSON.stringify(form) });
      const updated = await res.json();
      setCameras((cs) => cs.map((c) => (c.id === id ? updated : c)));
    } else {
      setCameras((cs) => cs.map((c) => (c.id === id ? { ...c, ...form } : c)));
    }
    if (focusCam?.id === id) setFocusCam((f) => ({ ...f, ...form }));
    setEditCam(null);
  };

  const handleDelete = async (id) => {
    if (api.connected && api.token) {
      await api.authedFetch(`/api/cameras/${id}`, { method: "DELETE" }).catch(() => {});
    }
    setCameras((cs) => cs.filter((c) => c.id !== id));
    if (focusCam?.id === id) setFocusCam(null);
    setEditCam(null);
  };

  if (api.connected && !api.token) {
    return <LoginOverlay api={api} />;
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ background: COLORS.bg, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        @keyframes scan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
        .scanline { background: linear-gradient(to bottom, transparent, rgba(255,255,255,0.05) 45%, rgba(255,255,255,0.05) 55%, transparent); animation: scan 6s linear infinite; }
      `}</style>

      <TopBar layoutKey={layoutKey} setLayoutKey={setLayoutKey} onlineCount={onlineCount} total={cameras.length} onOpenSettings={() => setShowSettings(true)} onMenu={() => setDrawerOpen(true)} bp={bp} />

      {demoMode && (
        <div className="px-3 py-1.5 text-[11px] flex items-center gap-1.5" style={{ background: `${COLORS.media}12`, color: COLORS.media, borderBottom: `1px solid ${COLORS.media}30` }}>
          <ServerCrash size={12} /> Modo demo — backend no conectado. Los datos mostrados son de ejemplo.
        </div>
      )}

      {toast && (
        <div className="px-3 py-1.5 text-[11px] flex items-center justify-between gap-1.5" style={{ background: `${COLORS.alta}14`, color: COLORS.alta, borderBottom: `1px solid ${COLORS.alta}30` }}>
          <span className="flex items-center gap-1.5"><AlertTriangle size={12} /> {toast.text}</span>
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {bp === "lg" && (
          <Sidebar cameras={cameras} query={query} setQuery={setQuery} onSelect={setFocusCam} onOpenAdd={() => setShowAdd(true)} onEdit={setEditCam} isDrawer={false} />
        )}
        {bp !== "lg" && (
          <Sidebar cameras={cameras} query={query} setQuery={setQuery} onSelect={setFocusCam} onOpenAdd={() => { setDrawerOpen(false); setShowAdd(true); }} onEdit={(c) => { setDrawerOpen(false); setEditCam(c); }} isDrawer open={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />
        )}

        <div className="flex-1 p-2 sm:p-3 overflow-y-auto">
          <div className="grid gap-2 sm:gap-3" style={{ gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))` }}>
            {visible.map((cam) => <CameraTile key={cam.id} camera={cam} onExpand={setFocusCam} api={api} />)}
            {Array.from({ length: Math.max(0, layout.count - visible.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="aspect-video rounded-md flex items-center justify-center" style={{ border: `1px dashed ${COLORS.border}`, color: COLORS.textFaint }}>
                <span className="text-[11px] font-mono">Canal vacío</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {focusCam && <FocusView camera={focusCam} onClose={() => setFocusCam(null)} api={api} onEdit={() => { setEditCam(focusCam); setFocusCam(null); }} />}
      {showAdd && <AddCameraModal onClose={() => setShowAdd(false)} onSave={handleSave} api={api} existingHosts={existingHosts} />}
      {editCam && <EditCameraModal camera={editCam} onClose={() => setEditCam(null)} onSave={handleUpdate} onDelete={handleDelete} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} api={api} />}
    </div>
  );
}
