import { NAVIGATION_CATEGORIES } from "../shared/messages.js";
import { createHelpDetails } from "./settings-view.js";

export function createNavigationView({ load, jump }, page = document) {
  const group = page.createElement("fieldset"); group.id = "navigation-controls";
  const legend = page.createElement("legend"); legend.textContent = "Page navigation"; group.append(legend);
  const category = page.createElement("select"); category.id = "navigation-category";
  for (const value of NAVIGATION_CATEGORIES) category.add(new page.defaultView.Option(({ headings: "Headings", sections: "Page sections", links: "Links", controls: "Controls" })[value], value));
  const targets = page.createElement("select"); targets.id = "navigation-target";
  for (const [id, labelText, select] of [[category.id, "Navigate by", category], [targets.id, "Target", targets]]) {
    const label = page.createElement("label"); label.htmlFor = id; label.textContent = labelText; label.style.display = "block"; group.append(label, select);
  }
  const buttons = page.createElement("div"); buttons.className = "button-group";
  function button(id, title) { const node = page.createElement("button"); node.type = "button"; node.id = id; node.textContent = title; buttons.append(node); return node; }
  const refresh = button("refresh-navigation", "Refresh list"), previous = button("navigation-previous", "Previous"), next = button("navigation-next", "Next"), go = button("navigation-jump", "Jump to target");
  const status = page.createElement("p"); status.id = "navigation-status"; status.setAttribute("role", "status"); status.setAttribute("aria-atomic", "true");
  const note = page.createElement("p"); note.textContent = "Refresh to find supported visible headings, sections, links, or controls. Jump moves focus and scrolls without clicking, typing, or submitting. Previous/Next stop at the ends of the list. Close reading mode or website dialogs first. Frames and shadow content are excluded. Labels are summaries; this is not a complete accessibility-name calculation.";
  const help = createHelpDetails("Page navigation", [note.textContent], page);
  note.textContent = "Refresh, choose a target, then Jump."; note.className = "feature-note";
  group.append(buttons, status, note, help); page.getElementById("assistance").append(group);
  let available = false, busy = false, version = 0, listing = null;
  function render() {
    group.disabled = !available;
    category.disabled = busy; refresh.disabled = busy;
    const count = listing?.items.length ?? 0, index = targets.selectedIndex;
    targets.disabled = busy || !count; go.disabled = busy || !count;
    previous.disabled = busy || index <= 0; next.disabled = busy || !count || index >= count - 1;
  }
  function reset(message = "Choose a category and press Refresh list.") { version++; busy = false; listing = null; targets.replaceChildren(); status.textContent = message; render(); }
  async function reload() {
    if (!available || busy) return;
    const token = ++version; busy = true; listing = null; targets.replaceChildren(); status.textContent = "Finding navigation targets…"; render();
    try {
      const result = await load(category.value);
      if (token !== version) return;
      listing = result;
      result.items.forEach((item, index) => targets.add(new page.defaultView.Option(`${index + 1}. ${item.kind}: ${item.label}`, item.id)));
      status.textContent = `${result.items.length} supported target(s).${result.limited ? " Results limited; some content was skipped." : ""}`;
    } catch { if (token === version) status.textContent = "Could not list targets. Close dialogs or reading mode, click AccessMate on this website, then refresh."; }
    finally { if (token === version) { busy = false; render(); } }
  }
  async function navigate(index) {
    if (!available || busy || !listing || index < 0 || index >= listing.items.length) return;
    const token = ++version; busy = true; targets.selectedIndex = index; render();
    try {
      await jump(listing.listId, listing.items[index].id);
      if (token === version) status.textContent = `Focused ${index + 1} of ${listing.items.length}: ${listing.items[index].label}`;
    } catch { if (token === version) { listing = null; targets.replaceChildren(); status.textContent = "Target changed or could not receive focus. Refresh the list and try again."; } }
    finally { if (token === version) { busy = false; render(); } }
  }
  refresh.addEventListener("click", () => { void reload(); });
  category.addEventListener("change", () => { reset(); void reload(); });
  targets.addEventListener("change", render);
  go.addEventListener("click", () => { void navigate(targets.selectedIndex); });
  previous.addEventListener("click", () => { void navigate(targets.selectedIndex - 1); });
  next.addEventListener("click", () => { void navigate(targets.selectedIndex + 1); });
  reset();
  return Object.freeze({ setAvailable(value) { if (available === value) return; available = value; reset(value ? undefined : "Open a website and close reading mode or dialogs to navigate."); }, reset });
}
