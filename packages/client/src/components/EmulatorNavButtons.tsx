interface EmulatorNavButtonsProps {
  /** WebRTC DataChannel for sending key events */
  dataChannel: RTCDataChannel | null;
}

/**
 * Android navigation buttons (Back, Home, Recents).
 * Key events are sent via WebRTC DataChannel.
 */
export function EmulatorNavButtons({ dataChannel }: EmulatorNavButtonsProps) {
  const sendKey = (key: string) => {
    if (!dataChannel || dataChannel.readyState !== "open") return;
    dataChannel.send(JSON.stringify({ type: "key", key }));
  };

  const disabled = !dataChannel || dataChannel.readyState !== "open";

  return (
    <div className="emulator-nav-buttons">
      <button
        type="button"
        className="emulator-nav-btn"
        onClick={() => sendKey("GoBack")}
        disabled={disabled}
        title="Back"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <button
        type="button"
        className="emulator-nav-btn"
        onClick={() => sendKey("GoHome")}
        disabled={disabled}
        title="Home"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
        </svg>
      </button>
      <button
        type="button"
        className="emulator-nav-btn"
        onClick={() => sendKey("AppSwitch")}
        disabled={disabled}
        title="Recents"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      </button>
    </div>
  );
}
