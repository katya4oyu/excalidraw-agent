Please provide all answers in Japanese.

# apps/web Agent Instructions

This app is a simple Vite + React SPA that embeds Excalidraw as the primary full-viewport experience.

## Stack

- Vite
- React 18
- React Router
- `@excalidraw/excalidraw`
- Hocuspocus/Yjs collaboration client
- Workspace packages from `@excalidraw-agent/*`

## Design System

Read `apps/web/DESIGN.md` before creating or changing UI.

Treat `DESIGN.md` as the source of truth for:

- colors
- typography
- spacing
- radii
- component intent
- Excalidraw Agent-specific UI behavior
- Tailwind-friendly token naming for custom components

Existing Excalidraw UI should be customized according to the official Excalidraw style customization guide:

https://docs.excalidraw.com/docs/@excalidraw/excalidraw/customizing-styles

Prefer documented Excalidraw CSS variables scoped under `.excalidraw` / `.excalidraw.theme--dark`. Do not broadly override brittle Excalidraw internals or rely on private DOM structure unless there is no documented alternative.

Custom application UI around Excalidraw should follow `DESIGN.md` and should be implementable with Tailwind tokens. If Tailwind is added later, map the `DESIGN.md` tokens directly instead of inventing parallel names.

## UI Principles

- Keep Excalidraw full-bleed and canvas-first.
- Put custom controls in Excalidraw extension points such as `Footer` when possible.
- Keep agent UI compact: small floating islands, icon buttons, short labels, and stable dimensions.
- Preserve Excalidraw's hand-drawn whiteboard feel.
- Do not introduce dashboard shells, marketing hero sections, decorative gradients, or heavy card layouts.
- Use dashed/low-opacity ghost styling for agent proposals and clear semantic colors for run status.

## Verification

For code changes, run the narrowest relevant checks:

```bash
pnpm --filter @excalidraw-agent/web typecheck
```

For `apps/web/DESIGN.md` changes, validate when network/package access allows:

```bash
npx @google/design.md lint apps/web/DESIGN.md
```

