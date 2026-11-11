import { AppearanceSetting } from "./AppearanceSetting";

import classes from "./General.module.css";

export function General() {
  return (
    <section class={classes.page}>
      <div class={classes.content}>
        <h1 class={classes.title}>General</h1>
        <div class={classes.settingsList}>
          <AppearanceSetting />
        </div>
      </div>
    </section>
  );
}
