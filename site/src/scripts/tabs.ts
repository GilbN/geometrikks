// Minimal ARIA tabs: click or arrow keys switch panels. Panels render with
// the hidden attribute server-side, so without this script the stylesheet
// shows them all and hides the strip.
export function wireTabs(root: string) {
  const scope = document.querySelector(root);
  if (!scope) return;
  const tabs = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls")!);
      if (panel) panel.hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = tabs[(i + delta + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  });
}
