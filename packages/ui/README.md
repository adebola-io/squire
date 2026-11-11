# squire-ui

Shared Squire components, icons, styles, and fonts for Retend applications.

`squire-ui` is developed in the Squire workspace and can also be installed as a
versioned package. Published packages contain bundled JavaScript, TypeScript
declarations, component styles, client logo assets, and self-hosted fonts. Importing
the package requires a bundler that supports asset URLs (such as Vite).

```ts
import { Button, Icon } from "squire-ui";
import "squire-ui/styles.css";
```

The styles entry includes component styles and fonts; import `squire-ui/components.css`
or `squire-ui/fonts.css` separately when only one is needed.

## Build and distribution

```sh
pnpm --filter squire-ui build
cd packages/ui && pnpm pack
```

The package is distributed from `dist/` rather than importing TypeScript
source files from the checkout. The workspace still uses `workspace:*`, so
changes to this package require rebuilding it before launching the dependent
apps. The root `dev`, `dev:web`, `build-web`, and `typecheck`
scripts build it first. Development commands also watch the UI
source and rebuild when it changes.

Packaging does not publish remotely. Publishing requires an explicit release
decision. External consumers should pin a released version; local linking
remains an optional development override.

The package retains the project's existing commit-pinned Retend, Retend Web,
and Innate UI dependencies. Packaging does not change those dependency
versions or their source URLs.
