import { For, If, type Cell, type SourceCell } from "retend";
import { Button } from "squire-ui";

import type { DraftValues, SettingsPageDefinition } from "./SettingsDefinitions";
import { FieldInput } from "./SettingsField";

import classes from "./SettingsEditor.module.css";

interface SettingsGroupsProps {
  definition: SettingsPageDefinition;
  draft: SourceCell<DraftValues>;
  errors: SourceCell<Record<string, string>>;
  busy: Cell<boolean>;
}

export function SettingsGroups(props: SettingsGroupsProps) {
  const { definition, draft, errors, busy } = props;
  return (
    <>
      {For(
        [...definition.groups],
        (group) => (
          <section class={classes.group} aria-label={group.heading}>
            <h2 class={classes.groupHeading} title={group.heading}>
              {group.heading}
            </h2>
            <div class={classes.groupFields}>
              {For(
                [...group.fields],
                (field) => (
                  <FieldInput field={field} draft={draft} errors={errors} busy={busy} />
                ),
                { key: "key" },
              )}
            </div>
          </section>
        ),
        { key: "heading" },
      )}
    </>
  );
}

interface SettingsFooterProps {
  error: Cell<string | null>;
  showFooter: Cell<boolean>;
  showSuccess: Cell<boolean>;
  showSave: Cell<boolean>;
  disabled: Cell<boolean>;
  buttonLabel: Cell<string>;
}

export function SettingsFooter(props: SettingsFooterProps) {
  const { error, showFooter, showSuccess, showSave, disabled, buttonLabel } = props;
  return (
    <>
      {If(showFooter, () => (
        <div class={classes.footer}>
          <div class={classes.feedback}>
            {If(error, (message) => (
              <p class={classes.error} role="alert" title={message}>
                {message}
              </p>
            ))}
            {If(showSuccess, () => (
              <p class={classes.success} role="status">
                Changes saved.
              </p>
            ))}
          </div>
          {If(showSave, () => (
            <Button class={classes.saveButton} type="submit" disabled={disabled}>
              {buttonLabel}
            </Button>
          ))}
        </div>
      ))}
    </>
  );
}
