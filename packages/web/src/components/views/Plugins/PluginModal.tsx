import { Cell, If, Switch } from "retend";

import { connectMcpServer, importPlugins, installMcpCandidate } from "@/platform/desktopClient";
import type {
  DesktopMcpAuthorization,
  DesktopMcpConnectRequest,
  DesktopMcpConnectValue,
  DesktopPluginCredentials,
} from "@/platform/desktopClient";
import { previewPluginPackage } from "@/platform/pluginPackage";

import { useMcpCandidateFlow } from "./PluginMcpCandidateFlow";
import { PluginModalActions } from "./PluginModalActions";
import { PluginModalFileStep } from "./PluginModalFileStep";
import { PluginModalMcpAuthorizeStep } from "./PluginModalMcpAuthorizeStep";
import { parseMcpLaunchCommand } from "./PluginModalMcpCommand";
import { McpForm } from "./PluginModalMcpForm";
import { PluginModalMcpReviewStep } from "./PluginModalMcpReviewStep";
import { PluginModalSecretsStep } from "./PluginModalSecretsStep";

import classes from "./Plugins.module.css";

export type PluginModalStep = "files" | "secrets" | "mcp-authorize" | "mcp-review";
export type PluginModalMode = "package" | "mcp";

interface PluginModalProps {
  mode: PluginModalMode;
  onCancel: () => void;
  onInstalled: () => void;
}

function formString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseValues(value: string, sensitive: boolean): DesktopMcpConnectValue[] {
  return parseLines(value).map((line, index) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Line ${index + 1} must use NAME=value.`);
    const name = line.slice(0, separator).trim();
    const itemValue = line.slice(separator + 1).trim();
    if (!name || !itemValue) throw new Error(`Line ${index + 1} must use NAME=value.`);
    return { name, value: itemValue, sensitive };
  });
}

function mcpConnectRequest(formData: FormData): DesktopMcpConnectRequest {
  const transport = formString(formData, "mcp-transport");
  if (transport === "stdio") {
    const { command, args } = parseMcpLaunchCommand(formString(formData, "mcp-launch-command"));
    return {
      transport: "stdio",
      command,
      args,
      env: [
        ...parseValues(formString(formData, "mcp-env"), false),
        ...parseValues(formString(formData, "mcp-secret-env"), true),
      ],
    };
  }
  if (transport === "streamable_http") {
    return {
      transport: "streamable_http",
      url: formString(formData, "mcp-url"),
      headers: [
        ...parseValues(formString(formData, "mcp-headers"), false),
        ...parseValues(formString(formData, "mcp-secret-headers"), true),
      ],
      oauth: {
        authorize: formData.has("mcp-oauth-authorize"),
        clientId: formString(formData, "mcp-oauth-client-id"),
        clientSecret: formString(formData, "mcp-oauth-client-secret"),
        scopes: formString(formData, "mcp-oauth-scopes").split(/\s+/).filter(Boolean),
      },
    };
  }
  throw new Error(`Unknown MCP transport: ${transport || "(missing)"}`);
}

function usePluginModal(props: PluginModalProps) {
  const { mode, onCancel, onInstalled } = props;
  const files = Cell.source<File[]>([]);
  const step = Cell.source<PluginModalStep>("files");
  const installMessage = Cell.source<string | null>(null);
  const mcp = useMcpCandidateFlow();
  const { candidate, authorization } = mcp;

  const previews = Cell.derivedAsync(async (get) => {
    const pluginFiles = get(files);
    if (pluginFiles.length === 0) return [];
    // Preview the archive locally; upload it only during installation.
    return Promise.all(pluginFiles.map(previewPluginPackage));
  });
  const secretPlugins = Cell.derivedAsync(async (get) =>
    (await get(previews)).flatMap((preview) =>
      preview.plugin?.secrets.length
        ? [{ iconDataUrls: preview.iconDataUrls, plugin: preview.plugin }]
        : [],
    ),
  );

  const close = () => {
    mcp.clear(true);
    onCancel();
  };

  async function installArchives(formData: FormData): Promise<void> {
    const credentials: DesktopPluginCredentials = {};
    for (const preview of await previews.get()) {
      const plugin = preview.plugin;
      if (!plugin) continue;
      const values: Record<string, string> = {};
      for (const secret of plugin.secrets) {
        const value = formData.get(`${plugin.id}.${secret.name}`);
        if (typeof value === "string" && value !== "") values[secret.name] = value;
      }
      if (Object.keys(values).length) credentials[preview.fileName] = values;
    }
    const response = await importPlugins(files.get(), credentials);
    if (response.results.some((result) => result.status === "installed")) {
      onInstalled();
      close();
      return;
    }
    installMessage.set(
      response.results.find((result) => result.status === "error")?.error ??
        "No Plugins installed.",
    );
  }

  async function awaitAuthorization(current: DesktopMcpAuthorization): Promise<void> {
    if (await mcp.wait(current)) step.set("mcp-review");
  }

  async function connectMcp(formData: FormData): Promise<void> {
    const token = mcp.attempt.get();
    const response = await connectMcpServer(mcpConnectRequest(formData));
    if (await mcp.accept(response, token, () => step.set("mcp-authorize"))) {
      step.set("mcp-review");
    }
  }

  const task = Cell.task(async (formData: FormData) => {
    installMessage.set(null);
    switch (step.get()) {
      case "files":
        if (mode === "mcp") {
          await connectMcp(formData);
          return;
        }
        if ((await secretPlugins.get()).length > 0) {
          step.set("secrets");
          return;
        }
        await installArchives(formData);
        return;
      case "secrets":
        await installArchives(formData);
        return;
      case "mcp-authorize": {
        // After timeout or failure, resume polling the existing candidate when submit reopens
        // sign-in.
        const current = authorization.get();
        if (!current) return;
        await awaitAuthorization(current);
        return;
      }
      case "mcp-review": {
        const current = candidate.get();
        if (!current) throw new Error("MCP connection candidate is missing.");
        const version = formString(formData, "mcp-plugin-version");
        await installMcpCandidate(current.candidateId, {
          name: formString(formData, "mcp-plugin-name"),
          version: version || null,
          description: formString(formData, "mcp-plugin-description"),
          themeColor: formString(formData, "mcp-plugin-theme-color"),
          iconSrc: formString(formData, "mcp-plugin-icon") || null,
        });
        onInstalled();
        close();
        return;
      }
    }
  });

  const submit = (event: SubmitEvent | undefined) => {
    if (!event) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    // Open the authorization popup during submit to avoid popup blocking.
    const authorizationUrl =
      step.get() === "mcp-authorize" && authorization.get()?.authorizationUrl;
    if (authorizationUrl) window.open(authorizationUrl, "_blank", "noopener");
    void task.runWith(formData);
  };

  return {
    task,
    authorization,
    candidate,
    close,
    files,
    installMessage,
    previews,
    secretPlugins,
    step,
    submit,
  };
}

export function PluginModal(props: PluginModalProps) {
  const { mode, onCancel, onInstalled } = props;
  const modal = usePluginModal({ mode, onCancel, onInstalled });
  const error = Cell.derived(
    () => modal.installMessage.get() ?? modal.task.error.get()?.message ?? null,
  );

  return (
    <form class={classes.addPluginModal} onSubmit--prevent={modal.submit}>
      <div class={classes.modalBody}>
        {Switch(modal.step, {
          files: () =>
            mode === "mcp" ? (
              <McpForm />
            ) : (
              <PluginModalFileStep files={modal.files} previews={modal.previews} />
            ),
          secrets: () => <PluginModalSecretsStep plugins={modal.secretPlugins} />,
          "mcp-authorize": () =>
            If(modal.authorization, (authorization) => (
              <PluginModalMcpAuthorizeStep authorization={authorization} />
            )),
          "mcp-review": () =>
            If(modal.candidate, (candidate) => <PluginModalMcpReviewStep candidate={candidate} />),
        })}
      </div>
      <footer class={classes.modalFooter}>
        {If(error, (message) => (
          <p class={classes.modalError} role="alert" title={message}>
            {message}
          </p>
        ))}
        <PluginModalActions
          isBusy={modal.task.pending}
          onCancel={modal.close}
          step={modal.step}
          mode={mode}
        />
      </footer>
    </form>
  );
}
