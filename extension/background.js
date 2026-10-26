// Forwards keyboard shortcuts to the SnapDust hook in the active Meet tab.
chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!target?.id) return;
    await chrome.tabs.sendMessage(target.id, { type: 'snapdust:command', command });
  } catch {
    // Not a Meet tab (no content script listening); nothing to do.
  }
});
