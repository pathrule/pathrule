// SPDX-License-Identifier: Apache-2.0
import {
  Card,
  CardHeader,
  Page,
  PageHeader,
  SegmentedControl,
  useTheme,
  type ThemePreference,
} from "@pathrule/ui";
import { ExternalLink } from "lucide-react";
import { useConsoleMessages } from "../messages.js";

/** Preferences of this browser only. Nothing here reaches an account or a server. */
export function SettingsPage() {
  const m = useConsoleMessages();
  const { theme, setTheme, density, setDensity } = useTheme();
  return (
    <Page width="md">
      <div className="pr-stack pr-stack--5">
        <PageHeader title={m.t("settings.title")} description={m.t("settings.description")} />
        <Card>
          <CardHeader title={m.t("settings.appearance")} />
          <div className="pr-card__body pr-stack pr-stack--4">
            <div className="lc-setting">
              <span className="lc-setting__text">
                <span className="lc-setting__label">{m.t("settings.theme")}</span>
                <span className="pr-note">{m.t("settings.themeHelp")}</span>
              </span>
              <SegmentedControl<ThemePreference>
                label={m.t("settings.theme")}
                value={theme}
                onValueChange={setTheme}
                options={[
                  { value: "system", label: m.t("settings.system") },
                  { value: "dark", label: m.t("settings.dark") },
                  { value: "light", label: m.t("settings.light") },
                ]}
              />
            </div>
            <div className="lc-setting">
              <span className="lc-setting__text">
                <span className="lc-setting__label">{m.t("settings.density")}</span>
                <span className="pr-note">{m.t("settings.densityHelp")}</span>
              </span>
              <SegmentedControl
                label={m.t("settings.density")}
                value={density}
                onValueChange={setDensity}
                options={[
                  { value: "comfortable", label: m.t("settings.comfortable") },
                  { value: "compact", label: m.t("settings.compact") },
                ]}
              />
            </div>
            <div className="lc-setting">
              <span className="lc-setting__text">
                <span className="lc-setting__label">{m.t("settings.language")}</span>
                <span className="pr-note">{m.t("settings.languageNote")}</span>
              </span>
              <span className="pr-mono">{m.locale}</span>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title={m.t("settings.cloud")} meta={m.t("settings.optional")} />
          <div className="pr-card__body pr-stack pr-stack--2">
            <p className="pr-note">{m.t("settings.cloudNote")}</p>
            <a
              className="lc-external"
              href="https://pathrule.io"
              target="_blank"
              rel="noopener noreferrer"
            >
              {m.t("settings.cloudLink")} <ExternalLink size={12} strokeWidth={1.5} aria-hidden />
            </a>
          </div>
        </Card>
      </div>
    </Page>
  );
}
