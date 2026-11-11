"use strict";

// Browser processes are shared by executable and display mode; website state
// belongs exclusively to each non-persistent context.
class PrivateBrowsers {
  constructor(launch) {
    this.launch = launch;
    this.hosts = new Map();
  }

  async acquire(metadata) {
    const key = `${metadata.browser.canonicalPath}:${metadata.headless}`;
    let host = this.hosts.get(key);
    if (!host) {
      host = { ready: this.launch(metadata), references: 0 };
      this.hosts.set(key, host);
    }
    host.references++;
    let launched;
    try {
      launched = await host.ready;
      const context = await launched.browser.newContext({
        acceptDownloads: true,
        viewport: metadata.headless ? metadata.viewport : null,
        deviceScaleFactor: 1,
      });
      let closing;
      return {
        context,
        processes: launched.processes,
        release: () =>
          (closing ??= (async () => {
            await context.close().catch(() => {});
            if (--host.references === 0) {
              if (this.hosts.get(key) === host) this.hosts.delete(key);
              await launched.close();
            }
          })()),
      };
    } catch (error) {
      if (--host.references === 0) {
        if (this.hosts.get(key) === host) this.hosts.delete(key);
        await launched?.close();
      }
      throw error;
    }
  }
}

module.exports = { PrivateBrowsers };
