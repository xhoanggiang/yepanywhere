import type {
  ContextUsage,
  ProviderName,
  SessionSandboxPolicy,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useActivityBusState } from "../hooks/useActivityBusState";
import type { ProcessState } from "../hooks/useSession";
import type { SessionStatus } from "../types";
import { Modal } from "./ui/Modal";

interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sessionTitle: string | null;
  state: string;
  startedAt: string;
  queueDepth: number;
  idleSince?: string;
  holdSince?: string;
  terminationReason?: string;
  terminatedAt?: string;
  provider: string;
  thinking?: { type: string };
  effort?: string;
  model?: string;
  executor?: string;
}

interface ProcessInfoModalProps {
  sessionId: string;
  provider: ProviderName;
  model?: string;
  status: SessionStatus;
  processState: ProcessState;
  contextUsage?: ContextUsage;
  originator?: string;
  cliVersion?: string;
  sessionSource?: string;
  approvalPolicy?: string;
  sandboxPolicy?: SessionSandboxPolicy;
  createdAt?: string;
  /** Whether the session-specific SSE stream is connected */
  sessionStreamConnected: boolean;
  /** Timestamp of last SSE activity for this session */
  lastSessionEventAt?: string | null;
  onClose: () => void;
}

function formatThinkingConfig(
  thinking?: { type: string },
  effort?: string,
): string {
  if (!thinking || thinking.type === "disabled") return "Disabled";
  const mode = thinking.type === "adaptive" ? "Adaptive" : "Enabled";
  return effort ? `${mode} (${effort})` : mode;
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatSandboxPolicy(policy?: SessionSandboxPolicy): string | null {
  if (!policy) return null;

  const details: string[] = [];
  if (policy.networkAccess !== undefined) {
    details.push(`network ${policy.networkAccess ? "on" : "off"}`);
  }
  if (policy.excludeTmpdirEnvVar !== undefined) {
    details.push(
      `$TMPDIR ${policy.excludeTmpdirEnvVar ? "excluded" : "included"}`,
    );
  }
  if (policy.excludeSlashTmp !== undefined) {
    details.push(`/tmp ${policy.excludeSlashTmp ? "excluded" : "included"}`);
  }

  if (details.length === 0) return policy.type;
  return `${policy.type} (${details.join(", ")})`;
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number | undefined | null;
  mono?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <div className="process-info-row">
      <span className="process-info-label">{label}</span>
      <span className={`process-info-value ${mono ? "mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="process-info-section">
      <h3 className="process-info-section-title">{title}</h3>
      {children}
    </div>
  );
}

export function ProcessInfoModal({
  sessionId,
  provider,
  model,
  status,
  processState,
  contextUsage,
  originator,
  cliVersion,
  sessionSource,
  approvalPolicy,
  sandboxPolicy,
  createdAt,
  sessionStreamConnected,
  lastSessionEventAt,
  onClose,
}: ProcessInfoModalProps) {
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connected: streamConnected, connectionState } = useActivityBusState();

  // Fetch process info when modal opens (if session is owned)
  useEffect(() => {
    if (status.owner !== "self") return;

    setLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((res) => {
        setProcessInfo(res.process);
      })
      .catch((err) => {
        setError(err.message || "Failed to fetch process info");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sessionId, status.owner]);

  // Format kebab-case to Title Case (e.g., "in-turn" -> "In Turn")
  const formatKebab = (s: string) =>
    s
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const getProviderDisplay = (p: string) => {
    switch (p) {
      case "claude":
        return "Claude (Anthropic)";
      case "codex":
        return "Codex (OpenAI)";
      case "codex-oss":
        return "Codex OSS (Local)";
      case "gemini":
        return "Gemini (Google)";
      case "opencode":
        return "OpenCode";
      default:
        return p;
    }
  };

  return (
    <Modal title="Session Info" onClose={onClose}>
      <div className="process-info-content">
        {/* Session Info - always available */}
        <Section title="Session">
          <InfoRow label="Session ID" value={sessionId} mono />
          {createdAt && (
            <InfoRow label="Created" value={formatTime(createdAt)} />
          )}
          <InfoRow label="Provider" value={getProviderDisplay(provider)} />
          <InfoRow label="Model" value={model || "Default"} mono />
          <InfoRow label="Ownership" value={formatKebab(status.owner)} />
          <InfoRow label="Activity" value={formatKebab(processState)} />
          <InfoRow label="Originator" value={originator} />
          <InfoRow label="CLI version" value={cliVersion} mono />
          <InfoRow label="Session source" value={sessionSource} />
          <InfoRow label="Approval policy" value={approvalPolicy} mono />
          <InfoRow
            label="Sandbox policy"
            value={formatSandboxPolicy(sandboxPolicy)}
            mono
          />
        </Section>

        {/* Connection Info */}
        <Section title="Connection">
          <InfoRow
            label="Activity stream"
            value={streamConnected ? "Connected" : "Disconnected"}
          />
          <InfoRow label="Connection state" value={connectionState} />
          <InfoRow
            label={
              status.owner === "external" ? "Session watch" : "Session stream"
            }
            value={
              status.owner === "none"
                ? "Not subscribed"
                : sessionStreamConnected
                  ? "Connected"
                  : "Disconnected"
            }
          />
          {status.owner === "self" && lastSessionEventAt && (
            <InfoRow
              label="Last session event"
              value={formatTimeAgo(new Date(lastSessionEventAt).getTime())}
            />
          )}
          {status.owner === "external" && (
            <InfoRow label="Subscription mode" value="Focused file watch" />
          )}
        </Section>

        {/* Context Usage - if available */}
        {contextUsage && (
          <Section title="Token Usage">
            <InfoRow
              label="Input tokens"
              value={contextUsage.inputTokens.toLocaleString()}
            />
            {contextUsage.outputTokens !== undefined && (
              <InfoRow
                label="Output tokens"
                value={contextUsage.outputTokens.toLocaleString()}
              />
            )}
            <InfoRow
              label="Context used"
              value={`${contextUsage.percentage.toFixed(1)}%`}
            />
            {contextUsage.cacheReadTokens !== undefined && (
              <InfoRow
                label="Cache read"
                value={contextUsage.cacheReadTokens.toLocaleString()}
              />
            )}
            {contextUsage.cacheCreationTokens !== undefined && (
              <InfoRow
                label="Cache created"
                value={contextUsage.cacheCreationTokens.toLocaleString()}
              />
            )}
          </Section>
        )}

        {/* Process Info - always show, with state-dependent content */}
        <Section title="Process">
          {status.owner === "self" ? (
            <>
              {loading && (
                <div className="process-info-loading">Loading...</div>
              )}
              {error && <div className="process-info-error">{error}</div>}
              {processInfo && (
                <>
                  <InfoRow label="Process ID" value={processInfo.id} mono />
                  <InfoRow
                    label="Started"
                    value={formatTime(processInfo.startedAt)}
                  />
                  <InfoRow
                    label="Uptime"
                    value={formatDuration(processInfo.startedAt)}
                  />
                  <InfoRow label="Queue depth" value={processInfo.queueDepth} />
                  <InfoRow
                    label="Extended thinking"
                    value={formatThinkingConfig(
                      processInfo.thinking,
                      processInfo.effort,
                    )}
                  />
                  {processInfo.idleSince && (
                    <InfoRow
                      label="Idle since"
                      value={formatTime(processInfo.idleSince)}
                    />
                  )}
                  {processInfo.holdSince && (
                    <InfoRow
                      label="Hold since"
                      value={formatTime(processInfo.holdSince)}
                    />
                  )}
                </>
              )}
              {!loading && !processInfo && !error && (
                <div className="process-info-loading">No process data</div>
              )}
            </>
          ) : status.owner === "external" ? (
            <div className="process-info-muted">
              Session controlled by external process (VS Code, CLI)
            </div>
          ) : (
            <div className="process-info-muted">No active process</div>
          )}
        </Section>

        {/* Project Info - from process if available */}
        {processInfo && (
          <Section title="Project">
            <InfoRow label="Name" value={processInfo.projectName} />
            <InfoRow label="Path" value={processInfo.projectPath} mono />
            <InfoRow label="Remote host" value={processInfo.executor} mono />
          </Section>
        )}
      </div>
    </Modal>
  );
}
