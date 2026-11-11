import { Cell, If } from "retend";

import { Markdown } from "@/components/views/Chat/Markdown";
import type { DesktopMarketplaceUpdate } from "@/platform/desktopClient";
import { usePluginState } from "@/scopes/PluginScope";

import classes from "./Plugins.module.css";

interface PluginOverviewProps {
  description: string;
  version?: string;
  categories?: string[];
  publishedAt?: string;
  update?: DesktopMarketplaceUpdate | null;
}

export function PluginOverview(props: PluginOverviewProps) {
  const { description, version, categories, publishedAt, update } = props;
  const { marketplace } = usePluginState();
  const categoryNames = Cell.derived(() => {
    const known = marketplace.get().catalog?.groups.flatMap((group) => group.categories) ?? [];
    return (
      categories
        ?.map((id) => known.find((category) => category.id === id)?.name ?? id)
        .join(", ") ?? ""
    );
  });
  return (
    <section class={classes.marketplaceOverview} aria-label="Overview">
      <article class={classes.marketplaceOverviewRich}>
        <Markdown text={description} />
      </article>
      <aside class={classes.marketplaceDetails} aria-label="Plugin information">
        <h2>Details</h2>
        <dl>
          {If(Boolean(version), () => (
            <div>
              <dt>Version</dt>
              <dd>{version}</dd>
            </div>
          ))}
          {If(Boolean(update), () => (
            <div>
              <dt>Available</dt>
              <dd>{update?.version}</dd>
            </div>
          ))}
          {If(Boolean(categories?.length), () => (
            <div>
              <dt>Categories</dt>
              <dd>{categoryNames}</dd>
            </div>
          ))}
          {If(Boolean(publishedAt), () => (
            <div>
              <dt>Published</dt>
              <dd>{publishedAt}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </section>
  );
}
