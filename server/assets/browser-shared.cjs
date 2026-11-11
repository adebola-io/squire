"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BrowserViewer } = require("./browser-viewer.cjs");
const { TabRegistry } = require("./browser-tabs.cjs");
const { NO_WINDOW_MESSAGE } = require("./browser-window.cjs");

// Translation only. The existing host/supervisor still owns filesystem policy,
// process identities, bounded storage, operation watchdogs and Playwright actions.
class SharedBrowser {
  constructor(api) {
    this.api = api;
    this.sessions = new Map();
    this.starting = new Map();
    this.active = new Set();
    this.barrier = Promise.resolve();
    this.cleanup = new Set();
    this.installed = undefined;
    this.tabs = new TabRegistry({
      onEvent: (event) => {
        if (event.event === "tab_invalidated") this.viewer?.closed(event.tab);
        api.event({
          ...event,
          context: undefined,
          owner: "browser",
          profile: event.context?.profile,
        });
      },
      hasViewer: (tab) => this.viewer?.isViewing(tab) ?? false,
      onEmpty: (context) => {
        const task = this.dispose(context);
        this.cleanup.add(task);
        task.catch(() => {}).finally(() => this.cleanup.delete(task));
        return task;
      },
    });
    this.viewer = new BrowserViewer(this.tabs, api.event);
    this.timer = setInterval(() => this.tabs.expire().catch(() => {}), 60000);
    this.timer.unref();
  }
  /**
   * Installed browsers. Detection spawns processes synchronously, stalling
   * every browser operation while it runs, so it runs once per supervisor
   * (warmed at startup) and again only when Settings asks to refresh.
   */
  browsers(refresh = false) {
    if (refresh || this.installed === undefined) this.installed = this.api.browsers();
    return this.installed;
  }
  /**
   * The browser Browser sessions use: the one chosen in Settings, else the one the saved-login
   * profile was created with, else the first installed (Chrome when it is). A profile keeps the
   * browser it was created with, so once it exists, Settings must show that browser rather than
   * whichever is now first installed.
   */
  selectedExecutable(ownerDir) {
    const chosen = this.api.read(path.join(ownerDir, "settings.json"), {}).executable;
    if (chosen) return chosen;
    const profile = this.api.read(
      path.join(ownerDir, "profiles", "authenticated", "profile.json"),
      null,
    );
    return profile?.browser?.executablePath ?? this.browsers()[0]?.executablePath;
  }
  invoke(request) {
    const mutation = request.kind === "settings" && request.action !== "read";
    const dependencies = mutation ? [this.barrier, ...this.active] : [this.barrier];
    const task = Promise.allSettled(dependencies)
      .then(() => {
        this.api.admit(request);
        return this.execute(request);
      })
      .catch((error) => {
        throw this.normalize(error);
      });
    if (mutation) this.barrier = task.catch(() => {});
    else this.active.add(task);
    task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  normalize(error) {
    const codes = {
      page_capacity_exceeded: "browser_capacity_reached",
      profile_capacity_exceeded: "browser_capacity_reached",
      owner_running_limit_exceeded: "browser_capacity_reached",
      daemon_busy: "browser_capacity_reached",
      profile_not_running: "runtime_lost",
      browser_launch_failed: "browser_unavailable",
      browser_not_found: "browser_unavailable",
      browser_install_required: "browser_install_required",
      screenshot_not_found: "artifact_not_found",
      download_not_found: "artifact_not_found",
    };
    const code = codes[error.code] ?? error.code ?? "browser_unavailable";
    // Keep page diagnostics, never profile directories or raw launch stderr.
    // The cause still goes to the supervisor's stderr, logs/browser-supervisor.log,
    // because a launch failure cannot be diagnosed from anywhere else.
    if (code === "browser_unavailable") {
      console.error(
        `${new Date().toISOString()} browser_unavailable (${error.code ?? error.name ?? "Error"}): ${error.stack ?? error.message}`,
      );
    }
    const message =
      code === "browser_install_required"
        ? "No compatible browser is installed."
        : code === "browser_unavailable"
          ? "Browser unavailable; Squire logged the cause in logs/browser-supervisor.log. List tabs or create a new tab explicitly."
          : code === "runtime_lost"
            ? "Browser unavailable; list tabs or create a new tab explicitly."
            : error.message;
    return this.api.error(code, message);
  }
  async session(request, privateSession, headless) {
    const profile = privateSession
      ? `private-${crypto.randomBytes(16).toString("hex")}`
      : "authenticated";
    const key = path.join(
      request.ownerDir,
      privateSession ? "private-artifacts" : "profiles",
      profile,
    );
    const current = this.sessions.get(key);
    if (current?.runtime.isOpen()) return current;
    if (this.starting.has(key)) return this.starting.get(key);
    const context = {
      profile,
      root: key,
      private: privateSession,
      headless,
      request,
      ready: false,
      keepOpen: false,
      executable: this.selectedExecutable(request.ownerDir),
    };
    context.observe = (page, opener, origin) => {
      if (!context.ready || page.isClosed()) return;
      try {
        this.tabs.register(page, { context, private: privateSession, opener, origin });
      } catch (error) {
        if (error.code !== "browser_capacity_reached") throw error;
      }
    };
    context.source = (page) => this.tabs.pages.get(page)?.tab;
    context.download = (page, run) => {
      const tab = context.source(page);
      return tab ? this.tabs.protect(tab, run) : run();
    };
    context.closed = () => {
      this.tabs.invalidateContext(context);
      this.sessions.delete(key);
    };
    const task = (async () => {
      context.runtime = await this.api.open(request, context);
      context.ready = true;
      this.sessions.set(key, context);
      return context;
    })();
    this.starting.set(key, task);
    try {
      return await task;
    } catch (error) {
      if (privateSession) fs.rmSync(key, { recursive: true, force: true });
      throw error;
    } finally {
      this.starting.delete(key);
    }
  }
  async dispose(context) {
    if (!context.private) return;
    await context.runtime.close();
    fs.rmSync(context.root, { recursive: true, force: true });
    this.sessions.delete(context.root);
  }
  // Profile-based plugins share the viewer, but never the Browser action API.
  profileView(request, runtime) {
    const context = {
      profile: request.profile,
      root: request.profileDir,
      headless: false,
      private: false,
      viewOnly: true,
      runtime,
    };
    context.observe = (page, opener, origin, scope) => {
      if (page.isClosed()) return;
      const tab = this.tabs.register(page, {
        context,
        opener,
        origin,
        viewOnly: true,
      });
      // An explicit invoking scope is required for top-level tabs. Popups
      // inherit only their registered opener's audience.
      if (!opener && scope) this.tabs.attachScope(this.tabs.resolve(tab), scope);
    };
    context.source = (page) => this.tabs.pages.get(page)?.tab;
    context.refresh = async (page) => {
      const record = this.tabs.pages.get(page);
      if (!record) return;
      this.tabs.refreshMetadata(record);
      await this.viewer.resume(record).catch(() => {});
    };
    context.download = (page, run) => {
      const tab = context.source(page);
      return tab ? this.tabs.protect(tab, run) : run();
    };
    context.closed = () => this.tabs.invalidateContext(context);
    return context;
  }
  async execute(request) {
    const { action, args } = request;
    if (request.kind === "settings") return this.settings(request);
    if (
      [
        "create_profile",
        "start_profile",
        "stop_profile",
        "delete_profile",
        "list_profiles",
        "export_cookies",
      ].includes(action) ||
      ["owner", "profile", "page"].some((key) => key in args)
    ) {
      throw this.api.error("invalid_argument", "Use tab handles for Browser actions.");
    }
    if (action === "list_tabs") {
      const tabs = await Promise.all(
        this.tabs.listForAgent().map(async (record) => ({
          tab: record.tab,
          title: await record.page.title().catch(() => ""),
          url: record.page.url(),
          origin: record.origin,
          private: record.private,
          ...(record.opener ? { opener: record.opener } : {}),
        })),
      );
      return this.output(this.api.collection("tabs", tabs, args));
    }
    if (action === "new_tab") return this.newTab(request);
    if (
      [
        "list_downloads",
        "list_screenshots",
        "move_download",
        "export_screenshot",
        "delete_screenshot",
      ].includes(action)
    ) {
      return this.artifacts(request);
    }
    return this.tabs.runForAgent(args.tab, async (record) => {
      this.tabs.attachScope(record, request.scope);
      const context = record.context;
      const screenshot = action.startsWith("screenshot_");
      let result;
      try {
        result = await context.runtime.execute(
          request,
          action,
          { ...args, tab: undefined },
          record.page,
        );
      } finally {
        // Screenshots can suspend screencast updates, and agent-side resize
        // changes the compositor geometry independently of the human viewer.
        if (screenshot || action === "resize") await this.viewer.resume(record).catch(() => {});
        if (action === "resize" && result) this.tabs.refreshMetadata(record);
      }
      // Low-level serialization includes attachment staging. Keep the tab's
      // operation lease until that completes, even if the page closes itself.
      if (screenshot) this.attribute(context, "screenshots", result.screenshotId, record.tab);
      return {
        ...this.api.canonical(action, result, args),
        ...(action === "resize"
          ? { structuredContent: { tab: record.tab, width: result.width, height: result.height } }
          : {}),
      };
    });
  }
  async newTab(request) {
    const args = request.args;
    if (
      ("private" in args && typeof args.private !== "boolean") ||
      ("headless" in args && typeof args.headless !== "boolean") ||
      ("from_tab" in args &&
        (typeof args.from_tab !== "string" ||
          !args.from_tab.length ||
          "private" in args ||
          "headless" in args))
    ) {
      throw this.api.error(
        "invalid_argument",
        "from_tab cannot be combined with private or headless.",
      );
    }
    const create = (context) =>
      this.tabs.protectContext(context, async () => {
        this.api.admit(request);
        const page = await context.runtime.newTab(request, args);
        const record = this.tabs.pages.get(page);
        this.tabs.attachScope(record, request.scope);
        return this.output({ tab: record.tab, url: page.url(), title: await page.title() });
      });
    if ("from_tab" in args)
      return this.tabs.runForAgent(args.from_tab, (record) => {
        this.tabs.attachScope(record, request.scope);
        return create(record.context);
      });
    const privateSession = args.private === true;
    const graphical = this.api.graphical();
    const headless = privateSession ? (args.headless ?? true) : (args.headless ?? !graphical);
    if (!headless && !graphical) throw this.api.error("window_unavailable", NO_WINDOW_MESSAGE);
    const context = await this.session(request, privateSession, headless);
    // Display mode is fixed for the lifetime of the shared browser. Resolve
    // the actual session first, including a concurrent launch, before deciding.
    if (!privateSession && args.headless === true && !context.headless) {
      const result = await create(await this.session(request, true, true));
      result.structuredContent.private = true;
      result.structuredContent.notice =
        "The shared authenticated browser is already running headed, so this tab was created in an isolated private headless session. Saved website logins and site state are unavailable. If you need the shared authentication, create a tab without headless:true to use the existing browser; otherwise you can continue with this private tab.";
      return result;
    }
    return create(context);
  }
  output(structuredContent) {
    return { structuredContent };
  }
  attribute(context, kind, id, tab) {
    const file = path.join(context.root, `${kind}.json`);
    const records = this.api.read(file, []);
    const record = records.find((record) => record.id === id);
    if (record) {
      record.tab = tab;
      record.context = context.profile;
      this.api.write(file, records);
    }
  }
  artifactContexts(request) {
    const root = path.join(request.ownerDir, "profiles");
    const authenticated = this.sessions.get(path.join(root, "authenticated")) ?? {
      profile: "authenticated",
      root: path.join(root, "authenticated"),
    };
    return [authenticated, ...[...this.sessions.values()].filter((context) => context.private)];
  }

  async artifacts(request) {
    const { action, args } = request;
    const kind = action.includes("download") ? "downloads" : "screenshots";
    const filter = args.tab === undefined ? undefined : this.tabs.resolveForAgent(args.tab);
    if (action.startsWith("list_")) {
      const records = this.artifactContexts(request).flatMap((context) =>
        this.api.read(path.join(context.root, `${kind}.json`), []),
      );
      return this.output(
        this.api.collection(
          kind,
          records.filter((record) => !filter || record.tab === filter.tab),
          args,
        ),
      );
    }
    const context = this.artifactContexts(request).find((context) =>
      this.api
        .read(path.join(context.root, `${kind}.json`), [])
        .some((record) => record.id === args.id),
    );
    if (!context)
      throw this.api.error("artifact_not_found", "The managed artifact is unavailable.");
    const record = this.tabs.listForAgent().find((record) => record.context === context);
    const run = async () => {
      await this.api.artifact(request, context, action, args);
      return this.output({});
    };
    return record ? this.tabs.runForAgent(record.tab, run) : run();
  }
  async settings(request) {
    const { action, args } = request;
    const configFile = path.join(request.ownerDir, "settings.json");
    const profileRoot = path.join(request.ownerDir, "profiles", "authenticated");
    const initialized = fs.existsSync(path.join(profileRoot, "profile.json"));
    const browsers = this.browsers(action === "read" && args.refresh === true);
    if (action === "read") {
      return this.output({
        browsers: browsers.map((browser) => ({
          executable: browser.executablePath,
          label: this.api.label(browser),
          family: browser.family,
        })),
        selected: this.selectedExecutable(request.ownerDir) ?? "",
        initialized,
        graphical: this.api.graphical(),
      });
    }
    if (action === "open") {
      if (!this.api.graphical()) throw this.api.error("window_unavailable", NO_WINDOW_MESSAGE);
      const context = await this.session(request, false, false);
      context.keepOpen = true;
      let page = context.runtime.firstPage();
      if (!page) page = await context.runtime.newTab(request, {}, "manual");
      context.observe(page, undefined, "manual");
      const tab = this.tabs.pages.get(page).tab;
      return this.tabs.run(tab, async (record) => {
        await record.page.bringToFront();
        return this.output({ opened: true });
      });
    }
    if (!["select", "reset"].includes(action))
      throw this.api.error("invalid_argument", "Unknown Browser setting.");
    if (action === "select") {
      if (!browsers.some((browser) => browser.executablePath === args.executable))
        throw this.api.error("invalid_argument", "Choose an installed compatible browser.");
      // Choosing the browser already in use keeps the profile, but saves the choice: until
      // then it only follows the profile, and resetting the profile would lose it.
      if (args.executable === this.selectedExecutable(request.ownerDir)) {
        if (this.api.read(configFile, {}).executable !== args.executable)
          this.api.write(configFile, { executable: args.executable });
        return this.output({ saved: true });
      }
    }
    if ((initialized || action === "reset") && args.confirm !== true)
      throw this.api.error(
        "confirmation_required",
        "Confirm clearing saved website logins and site state, and closing all normal tabs.",
      );
    const context = this.sessions.get(profileRoot);
    if (context) await context.runtime.close();
    this.api.admit(request);
    fs.rmSync(profileRoot, { recursive: true, force: true });
    if (action === "select") this.api.write(configFile, { executable: args.executable });
    return this.output({ saved: true });
  }
  async shutdown() {
    clearInterval(this.timer);
    await this.viewer.shutdown();
    await Promise.allSettled([...this.active, this.barrier, ...this.starting.values()]);
    await Promise.allSettled(this.cleanup);
  }
}
module.exports = { SharedBrowser };
