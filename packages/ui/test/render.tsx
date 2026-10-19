// SPDX-License-Identifier: Apache-2.0
// A minimal render helper over react-dom/client, so tests need no extra library.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface Rendered {
  container: HTMLElement;
  rerender(ui: ReactElement): void;
  unmount(): void;
}

const mounted = new Set<{ root: Root; container: HTMLElement }>();

export function render(ui: ReactElement): Rendered {
  const container = document.createElement("div");
  container.className = "pr-root";
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = { root, container };
  mounted.add(entry);
  act(() => root.render(ui));
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
      mounted.delete(entry);
    },
  };
}

export function cleanup(): void {
  for (const entry of mounted) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  mounted.clear();
  document.body.innerHTML = "";
}

export function click(element: Element | null): void {
  if (!element) throw new Error("click: element not found");
  act(() => {
    (element as HTMLElement).click();
  });
}

export function key(element: Element | null, keyName: string, init: KeyboardEventInit = {}): void {
  if (!element) throw new Error("key: element not found");
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Sets an input's value the way React observes it, then fires input. */
export function type(element: Element | null, value: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement))
    throw new Error("type: not an input");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(`[role="${role}"]`));
  const implicit: Record<string, string> = {
    button: "button",
    link: "a[href]",
    checkbox: 'input[type="checkbox"]',
    radio: 'input[type="radio"]',
    table: "table",
    heading: "h1,h2,h3,h4",
    textbox: 'input:not([type]),input[type="text"],input[type="search"],textarea',
  };
  if (implicit[role])
    all.push(
      ...Array.from(root.querySelectorAll<HTMLElement>(implicit[role])).filter(
        (el) => !el.hasAttribute("role") || el.getAttribute("role") === role,
      ),
    );
  const unique = Array.from(new Set(all));
  if (name == null) return unique;
  return unique.filter((el) => {
    const label = accessibleName(el);
    return typeof name === "string" ? label === name : name.test(label);
  });
}

export function accessibleName(el: HTMLElement): string {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled)
    return labelled
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return (label.textContent ?? "").trim();
  }
  return (el.textContent ?? "").trim();
}
