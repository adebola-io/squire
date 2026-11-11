import { parse } from "shell-quote";

interface McpLaunchCommand {
  command: string;
  args: string[];
}

// Validate quotes first because shell-quote accepts unfinished quotes and may change argument
// values.
function hasUnclosedQuote(value: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      if (quote !== "'") escaped = true;
    } else if (character === quote) {
      quote = null;
    } else if (quote === null && (character === "'" || character === '"')) {
      quote = character;
    }
  }
  return quote !== null || escaped;
}

/** Parse a launch command into executable and arguments without invoking a shell. */
export function parseMcpLaunchCommand(value: string): McpLaunchCommand {
  if (hasUnclosedQuote(value))
    throw new Error("Close the quote or finish the escape in the command.");
  let parts: ReturnType<typeof parse>;
  try {
    // Preserve variable references literally; Squire launches processes without a shell.
    parts = parse(value, (name) => `$${name}`);
  } catch {
    throw new Error("Check the command's quotes and try again.");
  }
  if (!parts.length) throw new Error("Enter the command used to start the MCP server.");
  if (parts.some((part) => typeof part !== "string")) {
    throw new Error(
      "Enter one command only. Pipes, redirects and shell comments are not supported.",
    );
  }
  const [command, ...args] = parts as string[];
  if (!command) throw new Error("Enter the command used to start the MCP server.");
  return { command, args };
}
