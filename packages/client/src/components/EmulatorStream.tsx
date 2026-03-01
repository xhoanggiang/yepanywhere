import { useCallback, useEffect, useRef } from "react";

interface EmulatorStreamProps {
  /** Remote MediaStream from WebRTC */
  stream: MediaStream | null;
  /** WebRTC DataChannel for sending touch/key events */
  dataChannel: RTCDataChannel | null;
}

/**
 * Compute the actual rendered video rect within the element,
 * accounting for `object-fit: contain` letterboxing.
 */
function getVideoRect(video: HTMLVideoElement): DOMRect {
  const elem = video.getBoundingClientRect();
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;

  // Before video metadata loads, fall back to element rect
  if (!videoW || !videoH) return elem;

  const scale = Math.min(elem.width / videoW, elem.height / videoH);
  const renderW = videoW * scale;
  const renderH = videoH * scale;

  return new DOMRect(
    elem.left + (elem.width - renderW) / 2,
    elem.top + (elem.height - renderH) / 2,
    renderW,
    renderH,
  );
}

/** Clamp a value to [0, 1]. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Video element for emulator stream with touch and mouse event capture.
 * Coordinates are normalized to 0.0-1.0, accounting for object-fit letterboxing.
 */
export function EmulatorStream({ stream, dataChannel }: EmulatorStreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach stream to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
  }, [stream]);

  const canSend = useCallback(() => {
    return dataChannel && dataChannel.readyState === "open";
  }, [dataChannel]);

  const sendTouches = useCallback(
    (
      touches: Array<{
        clientX: number;
        clientY: number;
        id: number;
        pressure: number;
      }>,
      video: HTMLVideoElement,
    ) => {
      if (!canSend() || !dataChannel) return;
      const rect = getVideoRect(video);
      const mapped = touches.map((t) => ({
        x: clamp01((t.clientX - rect.left) / rect.width),
        y: clamp01((t.clientY - rect.top) / rect.height),
        pressure: t.pressure,
        id: t.id,
      }));
      dataChannel.send(JSON.stringify({ type: "touch", touches: mapped }));
    },
    [canSend, dataChannel],
  );

  // --- Touch handlers ---

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLVideoElement>) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: (t as unknown as { force?: number }).force || 0.5,
        })),
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLVideoElement>) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: (t as unknown as { force?: number }).force || 0.5,
        })),
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLVideoElement>) => {
      e.preventDefault();
      // On touchend, event.touches is empty — use changedTouches with pressure 0 (release)
      sendTouches(
        Array.from(e.changedTouches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: 0,
        })),
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  // --- Mouse handlers (desktop fallback) ---

  const mouseDown = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      e.preventDefault();
      mouseDown.current = true;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  // Reset mouse state if pointer leaves the element
  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  return (
    <video
      ref={videoRef}
      className="emulator-video"
      autoPlay
      playsInline
      muted
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    />
  );
}
