/**
 * Keeps Ica awake while your PC is off.
 *
 * GitHub runs scheduled workflows in free repositories on a best-effort basis: a
 * "every 5 minutes" schedule can run only every few hours. A run that is *requested*
 * (workflow_dispatch) starts within seconds, so this Google Apps Script requests one
 * every 5 minutes. It runs on Google's servers under your own Google account, for free.
 *
 * Setup (once), at https://script.google.com:
 *   1. New project, paste this file, save.
 *   2. Project Settings → Script properties → add GITHUB_TOKEN: a fine-grained GitHub
 *      token for the voracity-watcher repository only, with "Actions: Read and write"
 *      and nothing else. (Optionally WATCHER_REPO, if your fork has another name.)
 *   3. Choose install in the toolbar, Run, and allow the requests it asks for.
 *
 * The token can only start or cancel this repository's workflows: it can't read its
 * secrets or change its code. Delete it on GitHub, or run uninstall, to stop.
 */
const DEFAULT_REPO = 'kevanwee/voracity-watcher';
const WORKFLOW = 'watch.yml';

/** Request a run every 5 minutes, starting now. Safe to run again. */
function install() {
  uninstall();
  ScriptApp.newTrigger('wake').timeBased().everyMinutes(5).create();
  wake();
  console.log('Installed: Ica is woken every 5 minutes.');
}

/** Stop requesting runs. */
function uninstall() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'wake') ScriptApp.deleteTrigger(trigger);
  }
}

/** Ask GitHub to run the watcher once. */
function wake() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings → Script properties.');
  const repo = properties.getProperty('WATCHER_REPO') || DEFAULT_REPO;
  const response = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: 'main' }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  // 204 means the run was requested. A run already in progress just queues the next one.
  if (status !== 204) throw new Error(`GitHub answered ${status}. ${status === 401 || status === 403 || status === 404 ? 'Check that the token is for this repository with Actions: Read and write.' : 'It will try again in 5 minutes.'}`);
}
