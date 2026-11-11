import { If } from "retend";
import type { JSX } from "retend/jsx-runtime";

import ChatGPTIcon from "../../assets/clients/ChatGPT.svg";
import ClaudeIcon from "../../assets/clients/Claude.svg";
import GeminiIcon from "../../assets/clients/Gemini.svg";
import GrokIcon from "../../assets/clients/Grok.svg";
import LMStudioIcon from "../../assets/clients/LMStudio.svg";
import MistralIcon from "../../assets/clients/Mistral.svg";
import QwenIcon from "../../assets/clients/Qwen.svg";
import ZaiIcon from "../../assets/clients/Zai.svg";

interface ClientIconProps {
  name: string;
  class?: JSX.IntrinsicElements["img"]["class"];
}

/** Clients register with their own names, which can include product names or domains. */
export function knownClient(name: string): string | null {
  const value = name.toLowerCase();
  if (value.includes("chatgpt") || value.includes("openai")) return "ChatGPT";
  if (value.includes("claude") || value.includes("anthropic")) return "Claude";
  if (value.includes("gemini")) return "Gemini";
  if (value.includes("grok") || value.includes("xai") || value.includes("x.ai")) return "Grok";
  if (value.includes("lm studio") || value.includes("lmstudio")) return "LM Studio";
  if (value.includes("mistral")) return "Mistral";
  if (value.includes("qwen")) return "Qwen";
  if (value.includes("z.ai") || value === "zai") return "Zai";
  return null;
}

export function clientIconSrc(name: string): string {
  switch (knownClient(name)) {
    case "ChatGPT":
      return ChatGPTIcon;
    case "Claude":
      return ClaudeIcon;
    case "Grok":
      return GrokIcon;
    case "LM Studio":
      return LMStudioIcon;
    case "Zai":
      return ZaiIcon;
    case "Mistral":
      return MistralIcon;
    case "Qwen":
      return QwenIcon;
    case "Gemini":
      return GeminiIcon;
    default:
      return "";
  }
}

/** Brand icons shared by Squire's desktop and hosted authorization screens. */
export function ClientIcon(props: ClientIconProps) {
  const { name, class: className } = props;
  const monochrome = knownClient(name) === "ChatGPT" || knownClient(name) === "Grok";

  return If(clientIconSrc(name), {
    true: (src) => (
      <img src={src} data-monochrome={monochrome} alt="" aria-hidden="true" class={className} />
    ),
    false: () => <span aria-hidden="true" class={className} />,
  });
}
