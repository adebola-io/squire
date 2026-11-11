import { Input } from "innate-ui";
import { Cell, If, type SourceCell } from "retend";
import type { JSX } from "retend/jsx-runtime";

import { Icon } from "../../icons";

import classes from "./SearchInput.module.css";

interface SearchInputProps {
  model: SourceCell<string>;
  placeholder: JSX.ValueOrCellOrPromise<string>;
  label: string;
  class?: JSX.ValueOrCellOrPromise<string | undefined>;
  onSearch?: () => void;
}

export function SearchInput(props: SearchInputProps) {
  const { model, placeholder, label, class: className, onSearch } = props;
  const input = Cell.source<HTMLInputElement | null>(null);
  const hasValue = Cell.derived(() => model.get() !== "");

  // The renderer binds the value attribute, which stops updating a dirty input. Copy
  // programmatic changes to the live value property.
  model.listen((value) => {
    const element = input.get();
    if (element !== null && element.value !== value) element.value = value;
  });

  const handleSubmit = () => {
    model.set(model.get().trim());
    onSearch?.();
  };

  const clear = () => {
    model.set("");
    input.get()?.focus();
  };

  return (
    <form class={[classes.searchForm, className]} role="search" onSubmit--prevent={handleSubmit}>
      <Icon class={classes.searchIcon} name="search" aria-hidden="true" />
      <Input
        ref={input}
        class={classes.searchInput}
        type="search"
        value={model}
        onChange={(value) => model.set(value)}
        placeholder={placeholder}
        ariaLabel={label}
      />
      {If(hasValue, () => (
        <button type="button" class={classes.clearButton} aria-label="Clear search" onClick={clear}>
          <Icon name="cancel" aria-hidden="true" />
        </button>
      ))}
    </form>
  );
}
