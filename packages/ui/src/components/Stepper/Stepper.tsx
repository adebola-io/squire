import { Stepper as InnateStepper } from "innate-ui";

type InnateStepperProps = Parameters<typeof InnateStepper>[0];

interface StepperProps extends InnateStepperProps {
  class?: InnateStepperProps["class"];
}

export function Stepper(props: StepperProps) {
  return <InnateStepper {...props} />;
}
export type { StepperProps };
