---
phase: 01
name: Scaffold electron-vite project
status: pending
priority: high
effort: S
---

# Phase 01 — Scaffold electron-vite Project

## Overview
Bootstrap `app-electron/` with electron-vite template, add TS + Tailwind + Zustand + serialport deps, get a blank window up. No features yet.

## Key Insights
- Use official template `@quick-start/electron@latest`, pick React + TypeScript
- Pin versions: `electron@30`, `electron-vite@3`, `serialport@12`
- `serialport` needs `electron-rebuild` post-install for native ABI
- Tailwind via `tailwindcss` + PostCSS config inside renderer-only

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/package.json`
- `drone-ctrl/app-electron/electron.vite.config.ts`
- `drone-ctrl/app-electron/tsconfig.json`
- `drone-ctrl/app-electron/tailwind.config.js`
- `drone-ctrl/app-electron/postcss.config.js`
- `drone-ctrl/app-electron/src/main/index.ts` — window creation
- `drone-ctrl/app-electron/src/preload/index.ts` — empty contextBridge
- `drone-ctrl/app-electron/src/renderer/index.html`
- `drone-ctrl/app-electron/src/renderer/src/main.tsx` — React entry
- `drone-ctrl/app-electron/src/renderer/src/App.tsx` — "Hello Drone" stub
- `drone-ctrl/app-electron/src/renderer/src/styles.css` — @tailwind directives
- `drone-ctrl/app-electron/README.md` — dev run instructions

## Implementation Steps
1. `cd drone-ctrl && npm create @quick-start/electron@latest app-electron -- --template react-ts`
2. `cd app-electron && npm install`
3. Install deps: `npm install serialport zustand` + `npm install -D tailwindcss postcss autoprefixer electron-rebuild`
4. `npx tailwindcss init -p` → configure `content` for renderer
5. Create `src/renderer/src/styles.css` with `@tailwind base/components/utilities`
6. Import styles in `main.tsx`
7. Add npm script `postinstall: electron-rebuild -f -w serialport` so native modules rebuild
8. Run `npm run dev` → verify window opens, hot reload works
9. Add .gitignore: `node_modules/`, `out/`, `dist/`

## Todo List
- [ ] Create app-electron scaffold via electron-vite template
- [ ] Install serialport + zustand + tailwind + electron-rebuild
- [ ] Configure Tailwind PostCSS
- [ ] Add electron-rebuild postinstall hook
- [ ] Verify `npm run dev` opens window with Tailwind styles applied
- [ ] Verify serialport imports without error in main process
- [ ] Commit .gitignore entries

## Success Criteria
- `npm run dev` opens Electron window within 5s
- Hot reload works (edit App.tsx → UI updates without restart)
- Tailwind class like `text-red-500` applies correctly
- `import { SerialPort } from 'serialport'` in main/index.ts does NOT throw
- Total new LOC < 100 (mostly config files)

## Risks
- **electron-rebuild fails**: ABI mismatch if user's node version differs from Electron's bundled. Mitigation: use prebuilt `@serialport/bindings-cpp` matching Electron's Node version.
- **Tailwind v4 breaking changes**: v4 has different config. Lock to v3.x.
- **npm create template drift**: template may change version defaults. Lock `electron-vite@3.x` explicitly.

## Next Steps
→ Phase 02: port drone-link-protocol to TypeScript for shared pack/unpack.
