import { Button } from "innate-ui";
import { Cell, For, If } from "retend";
import { Icon } from "squire-ui";

import { modelName } from "@/components/views/Settings/modelStore";

import type { ModelPickerState, ProviderGroup } from "./ModelPicker";

import classes from "./Chat.module.css";

interface ModelPickerListProps {
  picker: ModelPickerState;
}

/** Scrollable model list grouped by provider. */
export function ModelPickerList(props: ModelPickerListProps) {
  const { picker } = props;
  return (
    <>
      <ul class={classes.modelPickerGroups} aria-label="Models">
        {For(
          picker.groups,
          (group) => (
            <ProviderSection picker={picker} group={group} />
          ),
          {
            key: "key",
          },
        )}
      </ul>
      {If(picker.hasMore, () => (
        <Button
          type="button"
          variant="ghost"
          class={classes.modelPickerMore}
          onClick={picker.showMore}
        >
          Show more models
        </Button>
      ))}
    </>
  );
}

interface ProviderSectionProps {
  picker: ModelPickerState;
  group: ProviderGroup;
}

function ProviderSection(props: ProviderSectionProps) {
  const { picker, group } = props;
  const { blocked, selectedModel } = picker;
  const headingId = `model-provider-${group.key.replace(/\W+/g, "-")}`;
  // Read live group data because keyed sections persist across updates.
  const live = Cell.derivedAsync(async (get) => {
    return (await get(picker.groups)).find((candidate) => candidate.key === group.key) ?? group;
  });
  const rows = Cell.derivedAsync(async (get) => (await get(live)).models);
  const error = Cell.derivedAsync(async (get) => (await get(live)).error);
  return (
    <li class={classes.modelPickerGroup}>
      <h3 id={headingId} class={classes.modelPickerGroupHeading} title={group.name}>
        {group.name}
      </h3>
      {If(error, (failure) => (
        <div class={classes.modelPickerError} role="alert">
          <p>{failure.message}</p>
          <Button type="button" variant="ghost" onClick={() => picker.retry(group.profileId)}>
            Retry discovery
          </Button>
        </div>
      ))}
      <ul class={classes.modelPickerList} aria-labelledby={headingId}>
        {For(
          rows,
          (model) => {
            const selected = Cell.derivedAsync(async (get) => {
              const current = await get(selectedModel);
              return current?.profileId === model.profileId && current.modelId === model.id;
            });
            const name = Cell.derivedAsync(async (get) => {
              const current = (await get(rows)).find((item) => item.key === model.key);
              return modelName(current ?? model);
            });
            const subtitle = Cell.derivedAsync(async (get) => {
              return (await get(name)) !== model.id ? model.id : null;
            });
            return (
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  class={classes.modelPickerRow}
                  disabled={blocked}
                  aria-pressed={selected}
                  title={model.id}
                  onClick={() => picker.chooseModel(model.profileId, model.id)}
                >
                  <Icon name={model.icon} aria-hidden="true" />
                  <span class={classes.modelPickerRowText}>
                    <span title={name}>{name}</span>
                    {If(subtitle, (id) => (
                      <small title={id}>{id}</small>
                    ))}
                  </span>
                  <Button.End>
                    {If(selected, () => (
                      <Icon name="checkmark" aria-hidden="true" />
                    ))}
                  </Button.End>
                </Button>
              </li>
            );
          },
          { key: "key" },
        )}
      </ul>
    </li>
  );
}
