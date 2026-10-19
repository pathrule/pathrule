# @pathrule/agent-ir

The Agent IR: the formats Pathrule's knowledge atoms take (constraints, checks, procedures,
rationale, remedies, context and selection) and their deterministic compile, render and delivery to
coding agents, including how an approved priority between atoms is applied.

## Install

```bash
npm install @pathrule/agent-ir
```

## What is in it

Modules are imported by path, for example `@pathrule/agent-ir/atoms/constraint.js`.

- `atoms/`: one module per atom kind (`constraint.js`, `check.js`, `procedure.js`, `rationale.js`,
  `remedy.js`, `context.js`, `selection.js`), their validation and fingerprints, the constraint
  compiler and `precedence.js`.
- `delivery/`: rendering atoms for an agent (`agent-ir.js`, `ir-delivery.js`,
  `compiled-delivery.js`), conflict detection between atoms and the completeness gate.
- `verification/`: shell-command tokenizing, script resolution and the evidence a verified check
  records.

The output is deterministic: the same atoms render to the same text, which is what makes compiled
knowledge reviewable and cacheable.

## Versions and stability

The open packages (`protocol`, `agent-ir`, `core`, `integrations`, `mcp`, `host` and
`cli`) are released together with the same version. They are 0.x: an API can change between minor
versions. The supported product is the CLI, [`@pathrule/cli`](https://www.npmjs.com/package/@pathrule/cli);
these packages are for building with Pathrule.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
