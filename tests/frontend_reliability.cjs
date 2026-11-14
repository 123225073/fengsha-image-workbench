const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function extract(file, start, end) {
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

(async () => {
  let calls = 0;
  const s = {saveDirty: true, savePending: 0, saveTimer: null, account: {id: 1}, identity: 1,
    revision: 1, writes: Promise.resolve(), latestWorkspaceSave: Promise.resolve(),
    clearTimeout, notify: () => {}, document: {querySelector: () => null}, serializeWorkspace: () => ({ppt: {brief: '不能丢失'}}),
    workspaceProjects: {sync: async () => {}},
    api: async () => { calls++; if (calls === 1) throw new Error('连接中断'); return {revision: 2}; }};
  vm.createContext(s);
  vm.runInContext(extract('frontend/app.js', 'function queueWrite(', 'function save()'), s);
  await s.flushSave();
  assert.equal(s.saveDirty, true, 'failed save remains dirty');
  assert.equal(s.savePending, 0);
  await s.flushSave(true);
  assert.equal(calls, 2, 'retry really sends the preserved draft');
  assert.equal(s.saveDirty, false);
  assert.equal(s.revision, 2);
  s.saveDirty = true;
  s.api = async () => { throw Object.assign(new Error('revision conflict'), {status: 409}); };
  await assert.rejects(s.flushSave(true), /revision conflict/);
  assert.equal(s.saveDirty, true, 'conflict cannot silently discard content');
  let loggedOut = false;
  s.api = async path => { if (path === 'auth/logout') loggedOut = true; else throw new Error('offline'); };
  s.location = {replace: () => {}};
  vm.runInContext('var logout = ' + extract('frontend/app.js', 'logout: async () => {', '  "retry-workspace-save":').replace(/^logout: /, '').trim().replace(/,$/, ''), s);
  await s.logout();
  assert.equal(loggedOut, false, 'logout stops when saving failed');
  console.log('PASS: failed saves retry, conflict preserves draft, logout requires successful save');

  const p = {};
  vm.createContext(p);
  vm.runInContext(extract('frontend/workbench.js', 'function parsePptOutline(', 'function openManualPptOutline('), p);
  const pages = p.parsePptOutline('# 真实标题\r\n第一条\r\n第二条\r\n\r\n# 结论\n确认行动');
  assert.equal(pages.length, 2);
  assert.equal(pages[0][1], '第一条\n第二条');
  assert.throws(() => p.parsePptOutline('没有标题'), /页标题/);
  assert.throws(() => p.parsePptOutline('# 标题'), /正文/);
  assert.throws(() => p.parsePptOutline('#   \n正文'), /标题/);
  assert.throws(() => p.parsePptOutline(Array.from({length:25}, (_,i)=>`# ${i}\n正文`).join('\n')), /24/);
  assert.throws(() => p.parsePptOutline('# 标题\n'+'字'.repeat(2001)), /过长/);
  console.log('PASS: manual outline preserves text and rejects incomplete/oversized content');

  let projectWrites = 0;
  const binding = {project: {id: 'project', revision: 1}, snapshot: 'old'};
  const current = {current: binding};
  const projectSandbox = {state: {activeProjectId: 'project'}, data: current, syncOwner: () => current,
    workspaceDraft: () => ({document: {brief: '保留冲突草稿'}}), snapshot: JSON.stringify,
    api: async () => { projectWrites++; throw new Error('项目已在其他页面更新'); }};
  vm.createContext(projectSandbox);
  vm.runInContext(extract('frontend/projects.js', 'async function sync()', '  function view()'), projectSandbox);
  await assert.rejects(projectSandbox.sync(), error => error.projectConflict === true);
  await assert.rejects(projectSandbox.sync(), error => error.projectConflict === true);
  assert.equal(projectWrites, 1, 'blocked conflict must not overwrite or claim success');
  console.log('PASS: project conflict remains unresolved on retry until the draft is copied');
})().catch(error => { console.error(error); process.exitCode = 1; });
