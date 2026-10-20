import { setBasePath } from "@shoelace-style/shoelace/dist/utilities/base-path.js";
import { registerIconLibrary } from "@shoelace-style/shoelace/dist/utilities/icon-library.js";

setBasePath("/shoelace");

const SYSTEM_ICON_FILES = {
  caret: "caret-down",
  indeterminate: "dash-lg",
  radio: "circle-fill",
};

export function registerSystemIconsFromSelf() {
  registerIconLibrary("system", {
    resolver: (name) => `/shoelace/assets/icons/${SYSTEM_ICON_FILES[name] || name}.svg`,
    mutator: (svg) => svg.setAttribute("fill", "currentColor"),
  });
}
