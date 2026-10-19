// SPDX-License-Identifier: Apache-2.0
//
// The defect this pins: pathrule_relevant_work_episodes returns immediately when
// p_intent_subjects is empty, and nothing in the codebase ever filled that array.
// get-context.ts read it off the router decision through a cast, but no router type
// carried the field, so every call passed [] and the RPC scored nothing. The single
// most important assertion here is therefore "does not return empty for a real turn".

import { describe, expect, it } from "vitest";
import { deriveIntentSubjects } from "./intent-subjects.js";

describe("deriveIntentSubjects", () => {
  it("never returns empty for a real turn (the guard the RPC enforces)", () => {
    const subjects = deriveIntentSubjects(
      "packages/app/src/studio/sidebar/ActivityBar.tsx içinde i18n hatası var mı",
    );
    expect(subjects.length).toBeGreaterThan(0);
  });

  it("turns a PascalCase file name into the kebab-case subject agents actually log", () => {
    // Episode subjects come from pathrule_log_activity and look like `activity-bar`.
    // The SQL comparison is an exact-match INTERSECT, so `activitybar` would miss.
    const subjects = deriveIntentSubjects("ActivityBar.tsx içinde hardcoded string var mı");
    expect(subjects).toContain("activity-bar");
  });

  it("takes file names from router-identified primary files, not just the prompt text", () => {
    const subjects = deriveIntentSubjects("bu dosyada bir sorun var", {
      primaryFiles: ["packages/app/src/studio/design/DesignView.tsx"],
    });
    expect(subjects).toContain("design-view");
  });

  it("keeps domain terms that match logged subjects verbatim", () => {
    const subjects = deriveIntentSubjects("i18n ve chat tarafında bir regresyon var");
    expect(subjects).toContain("i18n");
    expect(subjects).toContain("chat");
  });

  it("drops Turkish and English filler instead of spending the budget on it", () => {
    const subjects = deriveIntentSubjects("bu dosyada neden bir hata var acaba nasıl olur");
    for (const filler of ["bir", "neden", "nasıl", "this", "the"]) {
      expect(subjects).not.toContain(filler);
    }
  });

  it("drops tokens shorter than three characters", () => {
    const subjects = deriveIntentSubjects("db ui io fix the queue drain");
    expect(subjects).not.toContain("db");
    expect(subjects).not.toContain("ui");
    expect(subjects).toContain("queue");
  });

  it("honours the limit and de-duplicates", () => {
    const subjects = deriveIntentSubjects(
      "queue queue drain drain episode episode telemetry telemetry render render layout layout",
      { limit: 4 },
    );
    expect(subjects).toHaveLength(4);
    expect(new Set(subjects).size).toBe(4);
  });

  it("returns empty only when there is genuinely nothing to say", () => {
    expect(deriveIntentSubjects("")).toEqual([]);
    expect(deriveIntentSubjects(undefined)).toEqual([]);
    expect(deriveIntentSubjects(null)).toEqual([]);
    // Punctuation and filler alone carry no signal.
    expect(deriveIntentSubjects("!!! ... the and for")).toEqual([]);
  });

  it("puts primary-file subjects before prompt chatter", () => {
    const subjects = deriveIntentSubjects("something is broken somewhere in here", {
      primaryFiles: ["packages/app/src/studio/chat/ChatColumn.tsx"],
      limit: 3,
    });
    expect(subjects[0]).toBe("chat-column");
  });
});
