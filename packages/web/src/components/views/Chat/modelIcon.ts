import { isIconName, type IconName } from "squire-ui";

/** Identify model families independently of their provider. */
const FAMILIES: readonly [RegExp, IconName][] = [
  [/^claude(?:[-._]|$)/, "claude"],
  [/^gemini(?:[-._]|$)/, "gemini"],
  [/^(?:gpt|chatgpt)(?:[-._]|$)|^o[134](?:[-._]|$)/, "openai"],
  [/^grok(?:[-._]|$)/, "xai"],
  [/^deepseek(?:[-._]|$)/, "deepseek"],
  [/^(?:llama|meta-llama)(?:[-._]|$)/, "meta"],
  [/^glm(?:[-._]|$)/, "zai"],
];

/** Prefer the model-family icon to its hosting provider's icon. */
export function modelIcon(modelId: string, providerIcon?: string): IconName {
  const name = (modelId.split("/").pop() ?? modelId).split(":")[0].toLowerCase();
  for (const [pattern, icon] of FAMILIES) {
    if (pattern.test(name)) {
      return icon;
    }
  }
  return providerIcon && isIconName(providerIcon) ? providerIcon : "brain";
}
