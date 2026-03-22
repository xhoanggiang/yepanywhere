import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContentProvider } from "../../contexts/AgentContentContext";
import { SchemaValidationProvider } from "../../contexts/SchemaValidationContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { ToastProvider } from "../../contexts/ToastContext";
import type { AgentContentMap } from "../../hooks/useSession";
import { preprocessMessages } from "../../lib/preprocessMessages";
import type { Message } from "../../types";
import { RenderItemComponent } from "../RenderItemComponent";

// Sample agent messages for testing
const sampleAgentMessages: Message[] = [
  {
    id: "msg-1",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Searching for tree files..." }],
  },
  {
    id: "msg-2",
    type: "assistant",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Grep",
        input: { pattern: "tree" },
      },
    ],
  },
  {
    id: "msg-3",
    type: "user",
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "Found 5 matches",
      },
    ],
  },
];

// Wrapper component with AgentContentProvider and SessionMetadataProvider
function TestWrapper({
  children,
  agentContent = {},
  toolUseToAgent = new Map(),
}: {
  children: React.ReactNode;
  agentContent?: AgentContentMap;
  toolUseToAgent?: Map<string, string>;
}) {
  return (
    <SessionMetadataProvider
      projectId="proj-1"
      projectPath="/test/project"
      sessionId="session-1"
    >
      <ToastProvider>
        <SchemaValidationProvider>
          <AgentContentProvider
            agentContent={agentContent}
            setAgentContent={() => {}}
            toolUseToAgent={toolUseToAgent}
            projectId="proj-1"
            sessionId="session-1"
          >
            {children}
          </AgentContentProvider>
        </SchemaValidationProvider>
      </ToastProvider>
    </SessionMetadataProvider>
  );
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  });
});

describe("AgentContentProvider", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders children correctly", () => {
    render(
      <TestWrapper>
        <div data-testid="test-child">Hello</div>
      </TestWrapper>,
    );

    expect(screen.getByTestId("test-child")).toBeDefined();
  });

  it("provides agent content through context", () => {
    const agentContent: AgentContentMap = {
      "agent-abc123": {
        messages: sampleAgentMessages,
        status: "completed",
      },
    };

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error
    expect(screen.getByText("Test")).toBeDefined();
  });

  it("provides empty content for unknown agent", () => {
    const agentContent: AgentContentMap = {};

    render(
      <TestWrapper agentContent={agentContent}>
        <div>Test</div>
      </TestWrapper>,
    );

    // Provider renders without error even with empty content
    expect(screen.getByText("Test")).toBeDefined();
  });
});

describe("AgentContent data structures", () => {
  it("tracks agent messages correctly", () => {
    const agentContent: AgentContentMap = {
      "agent-1": {
        messages: [
          { id: "m1", type: "assistant", content: "Hello" },
          { id: "m2", type: "assistant", content: "World" },
        ],
        status: "running",
      },
      "agent-2": {
        messages: [{ id: "m3", type: "assistant", content: "Done" }],
        status: "completed",
      },
    };

    expect(agentContent["agent-1"]?.messages.length).toBe(2);
    expect(agentContent["agent-2"]?.status).toBe("completed");
    expect(agentContent["agent-3"]).toBeUndefined();
  });

  it("supports different agent statuses", () => {
    const statuses = ["pending", "running", "completed", "failed"] as const;

    for (const status of statuses) {
      const content: AgentContentMap = {
        agent: { messages: [], status },
      };
      expect(content.agent?.status).toBe(status);
    }
  });
});

describe("Task rendering", () => {
  it("renders persisted Agent summaries when expanded without lazy-loaded subagent content", () => {
    const messages: Message[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Agent",
            input: {
              description: "Explore codebase for refactoring",
              prompt: "Find cleanup opportunities",
              subagent_type: "Explore",
            },
          },
        ],
      },
      {
        id: "msg-2",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              {
                type: "text",
                text: "## Comprehensive Cleanup and Refactoring Opportunities Report",
              },
              {
                type: "text",
                text: "agentId: summary123\n<usage>total_tokens: 200\ntool_uses: 3\nduration_ms: 1000</usage>",
              },
            ],
          },
        ],
      },
    ];
    const [item] = preprocessMessages(messages);

    expect(item?.type).toBe("tool_call");
    if (!item || item.type !== "tool_call") {
      throw new Error("Expected a tool_call render item");
    }
    const itemWithoutAgentLookup = {
      ...item,
      toolResult: item.toolResult
        ? {
            ...item.toolResult,
            structured:
              item.toolResult.structured &&
              typeof item.toolResult.structured === "object"
                ? {
                    ...(item.toolResult.structured as Record<string, unknown>),
                    agentId: undefined,
                  }
                : item.toolResult.structured,
          }
        : item.toolResult,
    };

    render(
      <TestWrapper>
        <RenderItemComponent
          item={itemWithoutAgentLookup}
          isStreaming={false}
          thinkingExpanded={false}
          toggleThinkingExpanded={() => {}}
        />
      </TestWrapper>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Explore codebase for refactoring/i }),
    );

    expect(
      screen.getByText(/Comprehensive Cleanup and Refactoring Opportunities/i),
    ).toBeDefined();
    expect(screen.queryByText(/agentId:\s*summary123/i)).toBeNull();
  });
});
