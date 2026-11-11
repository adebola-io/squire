import { Button as InnateButton } from "innate-ui";
import { AsyncCell, Cell, If } from "retend";
import { useDerivedAsyncValue } from "retend-utils/hooks";
import type { JSX } from "retend/jsx-runtime";

import { SpinnerIcon } from "../../icons/SpinnerIcon";
import classes from "./Button.module.css";

type NativeButtonProps = JSX.IntrinsicElements["button"];
type InnateButtonProps = Parameters<typeof InnateButton>[0];
export type ButtonVariant = "default" | "outline" | "ghost" | "danger";

interface ButtonProps extends NativeButtonProps {
  variant?: JSX.ValueOrCellOrPromise<ButtonVariant | undefined>;
  /** Shows a spinner, marks the button busy and disables it while its work runs. */
  loading?: JSX.ValueOrCellOrPromise<boolean | undefined>;
}

function toBoolean(value: unknown) {
  return value === true || value === "true";
}

function useBooleanValue(value: unknown): Cell<boolean> {
  if (!(value instanceof AsyncCell) && !(value instanceof Promise)) {
    return Cell.derived(() => {
      return toBoolean(value instanceof Cell ? value.get() : value);
    });
  }

  // Innate reads `disabled` synchronously. Resolve async inputs here; derive synchronous inputs
  // directly.
  const resolved = Cell.source(false);
  const setResolved = (next: unknown) => {
    resolved.set(toBoolean(next));
  };
  if (value instanceof AsyncCell) {
    const update = () => {
      void value.get().then(setResolved);
    };
    value.pending.listen((pending) => {
      if (!pending) {
        update();
      }
    });
    update();
  } else {
    void value.then(setResolved);
  }
  return resolved;
}

export function Button(props: ButtonProps) {
  const {
    variant: variantProp,
    disabled: disabledProp = false,
    loading: loadingProp = false,
    type = "button",
    children,
    class: classProp,
    ...rest
  } = props;
  const variant = useDerivedAsyncValue(variantProp);
  const loading = useBooleanValue(loadingProp);
  const explicitlyDisabled = useBooleanValue(disabledProp);
  const disabled = Cell.derived(() => explicitlyDisabled.get() || loading.get());
  const variantClass = Cell.derivedAsync(async (get) => {
    return classes[(await get(variant)) ?? "default"];
  });
  const innateProps = rest as unknown as InnateButtonProps;

  return (
    <InnateButton
      {...innateProps}
      type={type}
      disabled={disabled}
      aria-busy={loading}
      variant="ghost"
      class={[classes.button, variantClass, classProp]}
    >
      {If(loading, () => (
        <SpinnerIcon class={classes.spinner} />
      ))}
      {children}
    </InnateButton>
  );
}
