import type { RuntimeToolKind } from "../../types.js";

function objectInput(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : undefined;
}

/** Conservative mapping: an unknown tool is never promoted into an allowlisted capability. */
export function classifyDshTool(name: string, input?: unknown): RuntimeToolKind {
  switch (name) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "str_replace_editor": {
      const command = objectInput(input)?.["command"];
      return command === "view" ? "read" : command === "create" || command === "str_replace" || command === "insert"
        ? "edit"
        : "other";
    }
    case "glob":
    case "grep":
    case "lsp":
    case "session_event_search":
    case "session_search":
    case "session_trace":
    case "session_event_trace":
      return "search";
    case "session_event_read":
    case "skill":
      return "read";
    case "bash":
    case "run_code":
    case "workflow":
    case "ralph":
    case "subagent":
    case "subagent_fork":
    case "send_message":
    case "list_agents":
    case "report":
    case "task_kill":
    case "task_list":
    case "task_output":
    case "terminal_open":
    case "terminal_close":
    case "terminal_list":
    case "terminal_read":
    case "terminal_send":
    case "terminal_signal":
    case "cordis_inspect":
    case "cordis_mount":
    case "cordis_unmount":
      return "execute";
    case "web_fetch":
    case "web_search":
      return "fetch";
    case "todo_write":
    case "create_goal":
    case "get_goal":
    case "update_goal":
      return "think";
    case "exit_plan_mode":
      return "switch_mode";
    default:
      return "other";
  }
}
