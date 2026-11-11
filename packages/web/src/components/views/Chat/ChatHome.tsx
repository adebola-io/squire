import { Cell, For } from "retend";
import { Icon } from "squire-ui";

import { useAccountProfile } from "@/scopes/AccountScope";
import { useChat } from "@/scopes/ChatScope";

import { greeting } from "./chatModel";

import classes from "./Chat.module.css";

/** New-chat introduction; the persistent chat layout owns the composer. */
export function ChatHome() {
  const { clock } = useChat();
  const profile = useAccountProfile();
  const greetingText = Cell.derivedAsync(async (get) => {
    const account = await get(profile);
    return greeting(get(clock), account?.givenName || account?.name);
  });
  const words = Cell.derivedAsync(async (get) => (await get(greetingText)).split(" "));

  return (
    <div id="home" class={classes.homeIntro}>
      <Icon name="squire" class={classes.homeMark} aria-hidden="true" />
      <h1 class={classes.greeting} title={greetingText} aria-label={greetingText}>
        {For(words, (word) => (
          <span class={classes.greetingWord} aria-hidden="true">
            {word}{" "}
          </span>
        ))}
      </h1>
    </div>
  );
}
