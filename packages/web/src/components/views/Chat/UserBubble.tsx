import { Collapsible } from "./Collapsible";
import { Markdown } from "./Markdown";

import classes from "./Chat.module.css";

interface UserBubbleProps {
  text: string;
}

/**
 * A message from the user in a bubble. The bubble sizes to its contents, so short messages hug
 * their text and long ones stop at the cap. Collapsible measures the rendered message before the
 * first paint, so "Show more" never appears late.
 */
export function UserBubble(props: UserBubbleProps) {
  const { text } = props;

  return (
    <div class={classes.userBubble}>
      <Collapsible>
        <div class={classes.messageText}>
          <Markdown text={text} class={classes.userMarkdown} />
        </div>
      </Collapsible>
    </div>
  );
}
