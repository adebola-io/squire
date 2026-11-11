import type { AsyncCell } from "retend";
import { Icon, ModalHeading } from "squire-ui";

import { PluginSecretSetup } from "./PluginSecretSetup";
import type { PluginWithSecrets } from "./PluginSecretSetup";

import classes from "./Plugins.module.css";

interface PluginModalSecretsStepProps {
  plugins: AsyncCell<PluginWithSecrets[]>;
}

export function PluginModalSecretsStep(props: PluginModalSecretsStepProps) {
  const { plugins } = props;

  return (
    <>
      <ModalHeading title="Add Secrets" subtitle="Some Plugins require secret keys to be used." />
      <PluginSecretSetup plugins={plugins} />
      <p class={classes.pluginSecretNote}>
        <Icon name="padlock" aria-hidden="true" />
        Secrets are stored locally and can be updated later.
      </p>
    </>
  );
}
