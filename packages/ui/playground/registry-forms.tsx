// SPDX-License-Identifier: Apache-2.0
// Form pages: the field anatomy, text inputs, selection controls, select and combobox.
import { useState } from "react";
import {
  Checkbox,
  Combobox,
  FormField,
  PasswordInput,
  RadioGroup,
  SearchInput,
  Select,
  Switch,
  TextInput,
  Textarea,
} from "../src/index.js";
import type { Entry } from "./registry-entry.js";

function InputsDemo() {
  const [name, setName] = useState("pathrule web");
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState("");
  const invalid = touched && !/^[a-z0-9-]{3,40}$/.test(name);
  return (
    <div className="pg-form">
      <FormField
        label="Workspace name"
        required
        description="Lowercase, numbers and dashes. Becomes the URL slug."
        error={invalid ? "Use 3 to 40 lowercase letters, numbers or dashes." : undefined}
      >
        <TextInput
          mono
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormField>
      <FormField label="Ingest key" description="Shown once. Store it in your secret manager.">
        <PasswordInput defaultValue="pr_ing_example_only" readOnly />
      </FormField>
      <FormField label="Search knowledge" hideLabel>
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search memories, rules, skills"
          shortcut="⌘K"
        />
      </FormField>
      <FormField label="Notes" optional>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={140} />
      </FormField>
      <FormField label="Read only">
        <TextInput mono value="ws_example_01" readOnly />
      </FormField>
      <FormField label="Disabled">
        <TextInput value="Not editable" disabled />
      </FormField>
    </div>
  );
}

function SelectionDemo() {
  const [checks, setChecks] = useState([true, false, true]);
  const all = checks.every(Boolean) ? true : checks.some(Boolean) ? "indeterminate" : false;
  const [scope, setScope] = useState("project");
  const [learn, setLearn] = useState(true);
  return (
    <div className="pg-form">
      <div>
        <Checkbox
          checked={all}
          onCheckedChange={(on) => setChecks([on, on, on])}
          label="All knowledge"
        />
        {["Memories", "Rules", "Skills"].map((label, i) => (
          <div key={label} style={{ paddingLeft: 26 }}>
            <Checkbox
              checked={checks[i]!}
              onCheckedChange={(on) => setChecks((c) => c.map((v, j) => (j === i ? on : v)))}
              label={label}
            />
          </div>
        ))}
      </div>
      <RadioGroup
        label="Who receives it"
        value={scope}
        onValueChange={setScope}
        variant="card"
        options={[
          {
            value: "project",
            label: "Project",
            description: "Everyone working in this repository",
          },
          { value: "user", label: "Only me", description: "Delivered to your sessions only" },
        ]}
      />
      <div>
        <Switch
          checked={learn}
          onCheckedChange={setLearn}
          label="Learn from sessions"
          description="Pathrule proposes knowledge from your corrections"
        />
        <Switch
          checked={false}
          onCheckedChange={() => {}}
          label="Product telemetry"
          locked={{ reason: "Managed by organization policy" }}
        />
      </div>
    </div>
  );
}

function SelectDemo() {
  const [env, setEnv] = useState("production");
  const [path, setPath] = useState("/src/features");
  return (
    <div className="pg-form">
      <FormField label="Environment">
        <Select
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          options={["production", "staging", "preview"].map((v) => ({ value: v, label: v }))}
        />
      </FormField>
      <FormField label="Owner path" description="Type to filter; Enter accepts a new folder.">
        <Combobox
          value={path}
          onValueChange={setPath}
          creatable
          mono
          options={[
            "/",
            "/src",
            "/src/api",
            "/src/features",
            "/src/features/orders",
            "/src/lib/http",
          ].map((p) => ({
            value: p,
            label: p,
            hint: p === "/src/features" ? "41 items" : undefined,
          }))}
        />
      </FormField>
    </div>
  );
}

export const FORM_ENTRIES: Entry[] = [
  {
    id: "inputs",
    category: "forms",
    name: "Field and Text inputs",
    kind: "shared",
    imports: "FormField, TextInput, PasswordInput, SearchInput, Textarea",
    description:
      "One field anatomy: label, control, message. The message slot is reserved so validation never shifts layout. Validation is quiet until blur.",
    props: [
      { name: "FormField.label", type: "ReactNode" },
      {
        name: "FormField.description / error",
        type: "ReactNode",
        description: "The error replaces the description and is linked with aria-describedby.",
      },
      { name: "required / optional", type: "boolean" },
      { name: "TextInput.mono", type: "boolean", description: "For ids, slugs, paths and keys." },
      { name: "TextInput.prefix / suffix", type: "ReactNode" },
    ],
    dos: ["Prefer read-only plus copy over disabled for values people need."],
    donts: [
      "Don't use the placeholder as the label.",
      "Don't show errors before the person interacts.",
    ],
    a11y: "Real <label>; aria-invalid, aria-required and aria-describedby are set from the field.",
    render: () => <InputsDemo />,
  },
  {
    id: "selection",
    category: "forms",
    name: "Checkbox, Radio, Switch",
    kind: "shared",
    imports: "Checkbox, RadioGroup, Switch",
    description:
      "Checkbox for independent choices and bulk selection, radio for one of many, switch for settings that apply immediately.",
    props: [
      { name: "Checkbox.checked", type: 'boolean | "indeterminate"' },
      { name: "RadioGroup.variant", type: '"list" | "card"' },
      {
        name: "Switch.locked",
        type: "{ reason }",
        description: "Policy or plan lock: focusable, explains why, never toggles.",
      },
    ],
    donts: ["Don't use a switch inside a form with a Submit button."],
    a11y: "Native inputs for checkbox and radio; the switch is a button with role=switch and aria-checked.",
    render: () => <SelectionDemo />,
  },
  {
    id: "select",
    category: "forms",
    name: "Select and Combobox",
    kind: "shared",
    imports: "Select, Combobox",
    description:
      "A native select for short fixed lists; a combobox when the list is long or typed, such as paths.",
    props: [
      {
        name: "Combobox.creatable",
        type: "boolean",
        description: "Accept values not in the list.",
      },
      { name: "Combobox.options", type: "{ value, label, hint? }[]" },
    ],
    a11y: "WAI-ARIA combobox and listbox: arrows move aria-activedescendant, Enter selects, Escape closes the list first, then the dialog.",
    render: () => <SelectDemo />,
  },
];
