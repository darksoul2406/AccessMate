import { registerAdBlocker } from "../blocking/ad-blocker.js";
import { registerAutoApply } from "./auto-apply.js";

// Register synchronously whenever Chrome starts or wakes this worker.
registerAdBlocker();
registerAutoApply();

async function configureSidePanel() {
  try {
    // Use an explicit action listener below. The automatic panel toggle can
    // bypass the activeTab access grant needed to inspect/adapt the webpage.
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: false,
    });
  } catch (error) {
    console.error("[AccessMate] Could not configure the side panel.", error);
  }
}

// Register listeners immediately so Chrome can deliver lifecycle events.
// onInstalled runs for a new installation and for extension updates/reloads.
chrome.runtime.onInstalled.addListener(configureSidePanel);

// Reapply the same configuration when the browser profile starts.
chrome.runtime.onStartup.addListener(configureSidePanel);

chrome.action.onClicked.addListener((tab) => {
  // Invoke open directly during the toolbar gesture; do not await another API
  // first, because opening a side panel requires that user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    // The panel may already be open on a different site. Let it refresh its
    // tab details after this click grants access. A newly opening panel might
    // not have registered its listener yet; its startup query handles that case.
    void chrome.runtime.sendMessage({
      type: "ACCESSMATE_PAGE_ACCESS_GRANTED",
      windowId: tab.windowId,
      tabId: tab.id,
    }).catch(() => {});
  }).catch((error) => {
    console.error("[AccessMate] Could not open the side panel.", error);
  });
});
