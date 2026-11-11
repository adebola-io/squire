import { Cell, If } from "retend";
import type { SourceCell } from "retend";
import { Field, Textarea } from "squire-ui";

import { AdvancedToggle } from "./PluginModalMcpAdvancedToggle";
import { parseMcpLaunchCommand } from "./PluginModalMcpCommand";
import { PairTextarea, usePairField } from "./PluginModalMcpPairField";

interface StdioFieldsProps {
  showAdvanced: SourceCell<boolean>;
  advancedLabel: Cell<string>;
  onToggle: () => void;
}

export function StdioFields(props: StdioFieldsProps) {
  const { showAdvanced, advancedLabel, onToggle } = props;
  const env = usePairField("mcp-env");
  const secretEnv = usePairField("mcp-secret-env");
  const commandError = Cell.source<string | null>(null);
  const commandInvalid = Cell.derived(() => commandError.get() !== null);
  const validateCommand = (event: Event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    try {
      parseMcpLaunchCommand(input.value);
      commandError.set(null);
      input.setCustomValidity("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid command.";
      commandError.set(message);
      input.setCustomValidity(message);
    }
  };
  const clearCommandError = (event: Event) => {
    (event.currentTarget as HTMLTextAreaElement).setCustomValidity("");
    commandError.set(null);
  };

  return (
    <>
      <Field id="mcp-launch-command" invalid={commandInvalid}>
        <Field.Label>Launch command</Field.Label>
        <Field.Description>Paste the full terminal command.</Field.Description>
        <Textarea
          name="mcp-launch-command"
          rows={2}
          placeholder="npx -y chrome-devtools-mcp@latest"
          required
          onBlur={validateCommand}
          onInput={clearCommandError}
        />
        {If(commandError, (message) => (
          <Field.ErrorMessage>{message}</Field.ErrorMessage>
        ))}
      </Field>
      <AdvancedToggle showAdvanced={showAdvanced} label={advancedLabel} onToggle={onToggle} />
      {If(showAdvanced, () => (
        <>
          <PairTextarea
            field={env}
            label="Environment"
            name="mcp-env"
            placeholder="MODE=production"
          />
          <PairTextarea
            field={secretEnv}
            label="Secret environment"
            name="mcp-secret-env"
            placeholder="API_KEY=..."
          />
        </>
      ))}
    </>
  );
}
