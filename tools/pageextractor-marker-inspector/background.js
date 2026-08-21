"use strict";

// The DevTools panel page can't call browser.pageExtractorDebug directly:
// devtools panel/page contexts only get the devtools.* namespace plus the
// same subset of APIs a content script gets (messaging, storage, etc.) —
// custom experiment_apis modules are only reachable from "addon_parent"
// contexts like this background script. So the panel relays through here.
browser.runtime.onMessage.addListener(message => {
  switch (message?.type) {
    case "pageExtractorDebug:getText":
      return browser.pageExtractorDebug.getText(message.tabId, message.options);
    case "pageExtractorDebug:getPageMetadata":
      return browser.pageExtractorDebug.getPageMetadata(message.tabId);
    case "pageExtractorDebug:waitForPageReady":
      return browser.pageExtractorDebug.waitForPageReady(message.tabId);
    case "pageExtractorDebug:clearDebugOverlay":
      return browser.pageExtractorDebug.clearDebugOverlay(message.tabId);
    case "pageExtractorDebug:getHoveredDebugBlock":
      return browser.pageExtractorDebug.getHoveredDebugBlock(message.tabId);
    case "pageExtractorDebug:getHeadlessText":
      return browser.pageExtractorDebug.getHeadlessText(
        message.urlString,
        message.options,
        message.anonymousFetch
      );
  }
  return undefined;
});
