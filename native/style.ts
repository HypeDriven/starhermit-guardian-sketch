// The look of the menus, HUD and panels: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start, plus the built-in widgets' looks (dialogs as the paper panels,
// checkboxes, selects, the ink gauge, scroll bars) in the same colours.
// High contrast and larger text are the runtime's (it forces the UI's
// colours and scales its text).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const COLORS = {
  bg: "#14161c", fg: "#e8eaef", muted: "#aab0bf", paper: "#f4efe3", paperEdge: "#d9cdbb", paperFg: "#2a2d38",
  accent: "#ffd34d", danger: "#d05545", star: "#f0b429", inkTrack: "#3a3f4c", inkFill: "#7fb0ff", focus: "#8fd0ff",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 14,
    text: COLORS.paperFg, muted: "#5c5f69", panel: COLORS.paper, control: "#eef1f6", hovered: "#ffffff",
    pressed: "#dde2ea", field: "#ffffff", accent: COLORS.accent, focus: COLORS.focus, outline: COLORS.paperEdge,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$paper-fg" } },
    paragraph: { text: { color: "$paper-fg" } },
    heading: { text: { color: "$paper-fg" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$paper-fg" }, minHeight: 44,
      parts: { box: { background: "#ffffff", border: { width: 1, color: "#8a8d97" }, radius: 4 }, mark: { background: "#b3512f" } },
    },
    select: { text: { color: "$paper-fg" }, background: "#ffffff", border: { width: 1, color: "$paper-edge" }, radius: 8, minHeight: 44 },
    dialog: {
      background: [{ image: "assets/paper-grain.webp", size: [256, 256], repeat: true }, "$paper"],
      radius: 14, padding: 22, border: { width: 3, color: "$paper-edge" }, shadow: { y: 18, blur: 60, color: "#0000008c" },
      parts: { backdrop: { background: "#0a0c108c" } },
    },
    progress: { minHeight: 14, radius: 14, parts: { track: { background: "$ink-track", radius: 14 }, fill: { background: "$ink-fill", radius: 14 } } },
    scrollArea: { parts: { bar: { background: "#8a8d97", radius: 4 } } },
    tooltip: { background: "$paper-fg", text: { color: "$paper" }, radius: 6, padding: 6 },
  });
}
