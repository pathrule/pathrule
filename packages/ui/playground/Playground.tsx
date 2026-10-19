// SPDX-License-Identifier: Apache-2.0
import { Monitor, Moon, Smartphone, Sun, Tablet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AppShell,
  Badge,
  Brand,
  Breadcrumbs,
  CommandChip,
  IconButton,
  SearchInput,
  SegmentedControl,
  useTheme,
  type NavItemProps,
} from "../src/index.js";
import { CATEGORIES, ENTRIES, type Entry, type Kind } from "./registry.js";

const KIND_TONE: Record<Kind, "accent" | "info" | "warning" | "neutral"> = {
  shared: "accent",
  domain: "info",
  pattern: "warning",
  foundation: "neutral",
};

function pageFromHash(): string {
  const id = window.location.hash.replace(/^#\/?/, "");
  return ENTRIES.some((e) => e.id === id) ? id : "button";
}

export function Playground() {
  const [page, setPage] = useState(pageFromHash);
  const [filter, setFilter] = useState("");
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const { resolvedTheme, setTheme, density, setDensity } = useTheme();

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const entry = ENTRIES.find((e) => e.id === page) ?? ENTRIES[0]!;
  const q = filter.trim().toLowerCase();
  const sections = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        heading: `${category}/`,
        items: ENTRIES.filter(
          (e) =>
            e.category === category && (!q || e.name.toLowerCase().includes(q) || e.id.includes(q)),
        ).map(
          (e): NavItemProps => ({
            label: e.name,
            icon: () => null,
            href: `#/${e.id}`,
            active: e.id === page,
            onNavigate: (href) => (window.location.hash = href.slice(1)),
          }),
        ),
      })).filter((s) => s.items.length > 0),
    [q, page],
  );

  return (
    <AppShell
      navigationKey={page}
      sidebar={{
        label: "Components",
        brand: <Brand product="pathrule-ui" edition="0.1" />,
        switchers: (
          <SearchInput
            value={filter}
            onValueChange={setFilter}
            placeholder="Filter components"
            aria-label="Filter components"
            size="sm"
          />
        ),
        sections,
      }}
      topbar={{
        leading: (
          <Breadcrumbs
            items={[{ label: "pathrule-ui" }, { label: entry.category }, { label: entry.id }]}
          />
        ),
        actions: (
          <>
            <SegmentedControl
              className="pg-hide-narrow"
              label="Preview width"
              size="sm"
              value={viewport}
              onValueChange={setViewport}
              options={[
                { value: "desktop", label: "", icon: Monitor, ariaLabel: "Desktop" },
                { value: "tablet", label: "", icon: Tablet, ariaLabel: "Tablet, 768" },
                { value: "mobile", label: "", icon: Smartphone, ariaLabel: "Mobile, 375" },
              ]}
            />
            <SegmentedControl
              className="pg-hide-narrow"
              label="Density"
              size="sm"
              value={density}
              onValueChange={setDensity}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
              ]}
            />
            <IconButton
              icon={resolvedTheme === "dark" ? Sun : Moon}
              label="Toggle theme"
              variant="secondary"
              size="sm"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            />
          </>
        ),
      }}
    >
      <EntryPage entry={entry} viewport={viewport} />
    </AppShell>
  );
}

function EntryPage({
  entry,
  viewport,
}: {
  entry: Entry;
  viewport: "desktop" | "tablet" | "mobile";
}) {
  const width = viewport === "desktop" ? "100%" : viewport === "tablet" ? "768px" : "375px";
  const importLine = entry.imports
    ? `import { ${entry.imports} } from "${entry.from ?? "@pathrule/ui"}";`
    : null;
  return (
    <div className="pg-page">
      <div className="pg-meta">
        <span className="pr-text-caption-mono">{entry.category}/</span>
        <Badge size="sm" variant="outline" tone={KIND_TONE[entry.kind]}>
          {entry.kind}
        </Badge>
      </div>
      <h1 className="pg-title">{entry.name}</h1>
      <p className="pg-description">{entry.description}</p>
      {importLine ? <CommandChip command={importLine} prompt=">" className="pg-import" /> : null}
      <section className="pg-stage" aria-label={`${entry.name} examples`}>
        <div className="pg-stage__frame" style={{ maxWidth: width }}>
          {entry.render()}
        </div>
      </section>
      {entry.props?.length ? (
        <section className="pr-stack pr-stack--2">
          <h2 className="pg-h2">Props</h2>
          <div className="pg-table-scroll">
            <table className="pg-token-table">
              <thead>
                <tr>
                  <th>prop</th>
                  <th>type</th>
                  <th>default</th>
                  <th>notes</th>
                </tr>
              </thead>
              <tbody>
                {entry.props.map((p) => (
                  <tr key={p.name}>
                    <td className="pr-mono">{p.name}</td>
                    <td className="pr-mono pr-meta">{p.type}</td>
                    <td className="pr-mono">{p.default ?? "none"}</td>
                    <td>{p.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {entry.dos?.length || entry.donts?.length ? (
        <section className="pg-guidance">
          {entry.dos?.length ? (
            <div className="pg-guidance__col">
              <h2 className="pg-h2">Do</h2>
              <ul>
                {entry.dos.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {entry.donts?.length ? (
            <div className="pg-guidance__col">
              <h2 className="pg-h2">Don't</h2>
              <ul>
                {entry.donts.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      {entry.a11y ? (
        <section className="pr-stack pr-stack--2">
          <h2 className="pg-h2">Accessibility</h2>
          <p className="pg-description">{entry.a11y}</p>
        </section>
      ) : null}
    </div>
  );
}
