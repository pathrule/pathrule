// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox } from "../src/components/forms.js";
import { ConfirmDialog, Dialog } from "../src/components/overlay.js";
import { byRole, cleanup, click, flush, key, render, type } from "./render.js";

afterEach(cleanup);

function Harness({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        title="Delete pathrule-web permanently?"
        description="312 knowledge items and all revisions will be erased. This can't be undone."
        confirmLabel="Delete permanently"
        confirmText="pathrule-web"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("is a labelled modal dialog that names the consequence", () => {
    render(<Harness onConfirm={async () => {}} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Delete pathrule-web permanently?",
    );
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("can't be undone");
  });

  it("requires typing the exact name before an irreversible action runs", async () => {
    const onConfirm = vi.fn(async () => {});
    render(<Harness onConfirm={onConfirm} />);
    const confirm = () => byRole(document.body, "button", "Delete permanently")[0]!;
    click(confirm());
    await flush();
    expect(onConfirm).not.toHaveBeenCalled();
    type(document.querySelector('[role="dialog"] input'), "pathrule-web");
    click(confirm());
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe("closed");
  });

  it("keeps the dialog open and shows the failure inline when the action fails", async () => {
    render(
      <Harness
        onConfirm={async () => {
          throw new Error("You need the Admin role to delete this workspace.");
        }}
      />,
    );
    type(document.querySelector('[role="dialog"] input'), "pathrule-web");
    click(byRole(document.body, "button", "Delete permanently")[0]!);
    await flush();
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe("open");
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "You need the Admin role to delete this workspace.",
    );
  });
});

describe("Escape inside a dialog", () => {
  it("closes an open combobox list first and keeps the dialog open", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState("/");
      return (
        <>
          <span data-testid="state">{open ? "open" : "closed"}</span>
          <Dialog open={open} onOpenChange={setOpen} title="New memory">
            <Combobox
              ariaLabel="Owner path"
              value={value}
              onValueChange={setValue}
              options={[
                { value: "/", label: "/" },
                { value: "/src", label: "/src" },
              ]}
              creatable
            />
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    type(input, "/sr");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe("open");
    key(input, "Escape");
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe("closed");
  });
});
