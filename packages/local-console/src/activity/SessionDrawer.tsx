// SPDX-License-Identifier: Apache-2.0
// One work session open: what the agent logged, the knowledge it had where it worked, a nudge
// where it had none, and the runtime issues open in those folders. All of it is what the agent
// reported; nothing is checked against the code.
import type { KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import { Drawer, RelativeTime, Swatch } from "@pathrule/ui";
import { Activity, TriangleAlert } from "lucide-react";
import type { MouseEvent } from "react";
import { useConsole } from "../app/context.js";
import { useLocal } from "../app/use-local.js";
import { useConsoleMessages } from "../messages.js";
import { KIND_COLORS } from "../overview/panel.js";
import { hrefFor } from "../router.js";
import { clientLabel, durationText, entryKind, personName } from "./ActivityParts.js";
import { entryFolder, type WorkSession } from "./model.js";

function under(path: string, folders: readonly string[]): boolean {
  return folders.some(
    (folder) => folder === "/" || path === folder || path.startsWith(`${folder}/`),
  );
}

export function SessionDrawer({
  session,
  knowledge,
  uncovered,
  onClose,
}: {
  session: WorkSession | null;
  knowledge: readonly KnowledgeListItem[] | null;
  /** The session's folders where agents had no knowledge. */
  uncovered: readonly string[];
  onClose: () => void;
}) {
  const m = useConsoleMessages();
  const { workspace, navigate } = useConsole();
  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(href);
  };
  const knowledgeHref = (path: string) =>
    hrefFor({
      name: "knowledge",
      workspaceId: workspace!.id,
      kind: "all",
      archived: false,
      open: null,
      path,
    });
  const name = session ? personName(m, session) : "";
  const there = session
    ? (knowledge ?? [])
        .filter((item) =>
          (item.paths?.length ? item.paths : item.path ? [item.path] : []).some(
            (path) =>
              path !== "/" &&
              session.folders.some((folder) => folder === path || folder.startsWith(`${path}/`)),
          ),
        )
        .sort((a, b) => (b.usageCount30d ?? 0) - (a.usageCount30d ?? 0))
        .slice(0, 5)
    : [];
  const missing = uncovered[0] ?? null;
  const landedThere =
    session && missing
      ? session.entries.filter((entry) => entryFolder(entry) === missing).length
      : 0;
  return (
    <Drawer
      open={session != null}
      onOpenChange={(next) => !next && onClose()}
      width="lg"
      eyebrow={
        session
          ? `${m.dateTime(session.start, { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${durationText(
              Date.parse(session.end) - Date.parse(session.start),
            )} · ${name} ${m.t("activity.with", { agent: clientLabel(m, session.client) })}`
          : undefined
      }
      title={session?.title ?? ""}
      description={m.t("activity.session.description")}
    >
      {session ? (
        <div className="pr-stack pr-stack--5">
          <section aria-labelledby="ac-entries" className="pr-stack pr-stack--2">
            <h3 id="ac-entries" className="lc-ac-drawer__title">
              {m.t("activity.session.entries")}
            </h3>
            <ol className="lc-ac-entries">
              {session.entries.map((entry) => (
                <li key={entry.id} className="lc-ac-entry">
                  <span className="lc-ac-entry__time pr-mono">
                    {m.dateTime(entry.createdAt, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="lc-ac-entry__body">
                    <span className="lc-ac-entry__kind">{entryKind(m, entry)}</span>
                    <span className="lc-ac-entry__summary">{entry.summary ?? ""}</span>
                    {entry.files?.length ? (
                      <span className="lc-ac-entry__files">
                        {entry.files.slice(0, 6).map((file) => (
                          <span key={file} className="pr-mono">
                            {file}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="ac-knowledge" className="pr-stack pr-stack--2">
            <h3 id="ac-knowledge" className="lc-ac-drawer__title">
              {m.t("activity.session.knowledge")}
            </h3>
            {there.length ? (
              <ul className="lc-ac-known">
                {there.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <Swatch color={KIND_COLORS[item.kind]} />
                    <a
                      className="lc-ac-known__title"
                      href={hrefFor({
                        name: "knowledge",
                        workspaceId: workspace!.id,
                        kind: item.kind,
                        archived: false,
                        open: item.id,
                      })}
                      onClick={follow(
                        hrefFor({
                          name: "knowledge",
                          workspaceId: workspace!.id,
                          kind: item.kind,
                          archived: false,
                          open: item.id,
                        }),
                      )}
                    >
                      {item.title}
                    </a>
                    <span className="lc-ac-known__path pr-mono">{item.path ?? ""}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {missing ? (
              <p className="lc-ac-missing">
                <TriangleAlert size={13} aria-hidden />
                <span>
                  {m.t("activity.session.noKnowledge", {
                    path: missing,
                    count: m.number(landedThere),
                  })}{" "}
                  <a href={knowledgeHref(missing)} onClick={follow(knowledgeHref(missing))}>
                    {m.t("activity.session.write")}
                  </a>
                </span>
              </p>
            ) : null}
          </section>

          <RuntimeHere folders={session.folders} />

          <p className="pr-note">{m.t("activity.session.note")}</p>
        </div>
      ) : null}
    </Drawer>
  );
}

/** Runtime issues open in the session's folders, when the backend reads them. */
function RuntimeHere({ folders }: { folders: readonly string[] }) {
  const { capabilities } = useConsole();
  return capabilities.runtimeEvents.available ? <RuntimeList folders={folders} /> : null;
}

function RuntimeList({ folders }: { folders: readonly string[] }) {
  const m = useConsoleMessages();
  const { workspace, navigate } = useConsole();
  const groups = useLocal("signals.groups", { workspaceId: workspace!.id });
  if (groups.state.status !== "success") return null;
  const open = groups.state.data.groups.filter(
    (group) =>
      group.status === "active" &&
      group.kind === "error" &&
      group.nodePath &&
      under(group.nodePath, folders),
  );
  return (
    <section aria-labelledby="ac-runtime" className="pr-stack pr-stack--2">
      <h3 id="ac-runtime" className="lc-ac-drawer__title">
        {m.t("activity.session.runtime")}
      </h3>
      {open.length === 0 ? (
        <p className="pr-note">
          {m.t("activity.session.runtimeNone", { folders: folders.join(", ") })}
        </p>
      ) : (
        <ul className="lc-ac-known">
          {open.slice(0, 5).map((group) => {
            const href = hrefFor({
              name: "signals",
              workspaceId: workspace!.id,
              view: "issues",
              group: group.id,
            });
            return (
              <li key={group.id}>
                <Activity size={13} aria-hidden className="lc-ac-known__icon" />
                <a
                  className="lc-ac-known__title pr-mono"
                  href={href}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    navigate(href);
                  }}
                >
                  {(group.message ?? group.label ?? group.fingerprint).split("\n")[0]}
                </a>
                <RelativeTime iso={group.lastSeen} className="lc-ac-known__path" />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
