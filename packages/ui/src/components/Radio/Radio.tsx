import { Radio as InnateRadio } from "innate-ui";

import classes from "./Radio.module.css";

type InnateRadioProps<T extends string> = Parameters<typeof InnateRadio<T>>[0];

interface RadioProps<T extends string> extends InnateRadioProps<T> {
  class?: InnateRadioProps<T>["class"];
}

function RadioRoot<T extends string>(props: RadioProps<T>) {
  const { class: className, ...rest } = props;
  return <InnateRadio {...(rest as InnateRadioProps<T>)} class={[classes.group, className]} />;
}

type RadioParts = {
  Legend: typeof InnateRadio.Legend;
  Item: typeof InnateRadio.Item;
};

export const Radio: typeof RadioRoot & RadioParts = Object.assign(RadioRoot, {
  Legend: InnateRadio.Legend,
  Item: InnateRadio.Item,
});
export type { RadioProps };
