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

  let now = 12020;
  let ticks = 0;
  const clock = {dataset: {jobSince: '10'}, dateTime: 'PT2S', textContent: '00:02', setAttribute() {}};
  let visible = [clock];
  const timer = {Date: {now: () => now}, live: {clock: null},
    document: {querySelectorAll: () => visible}, setTimeout: () => ++ticks,
    esc: String, jobLabels: {queued: '等待执行', running: '正在生成', failed: '失败'}};
  vm.createContext(timer);
  vm.runInContext(extract('frontend/workbench.js', 'function activeJob(', 'function generationActivity('), timer);
  assert.match(timer.jobProgress({status: 'queued', created: 10}), /aria-live="off".*PT2S.*00:02/);
  assert.match(timer.jobProgress({status: 'running', created: 10}), /00:02/);
  assert.equal(ticks, 1, 'all active clocks share one tick');
  now = 15000;
  timer.tickJobClocks();
  assert.equal(clock.textContent, '00:05', 'a late tick catches up against wall clock time');
  assert.equal(timer.jobClockText(3605), '01:00:05');
  assert.match(timer.jobProgress({status: 'failed', created: 10, updated: 13}), /耗时 3 秒/);
  assert.doesNotMatch(timer.jobProgress({status: 'failed', created: 10, updated: 13}), /data-job-since/);
  visible = [];
  timer.tickJobClocks();
  assert.equal(timer.live.clock, null, 'the clock stops when no active job is visible');
  console.log('PASS: shared elapsed timer catches up, freezes terminal duration, and stops when hidden');

  let saves = 0;
  const ppt = {stage: 3, maxStage: 3, outline: [['封面', '正文'], ['第二页', '内容']], boards: [], pages: [null, null]};
  const workflow = {state: {ppt}, ui: {}, content: {querySelector: () => null}, visualExists: id => ['cover-image', 'body-image'].includes(id),
    scopeInProgress: () => false, notify: () => {}, save: () => saves++, render: () => {},
    window: {scrollTo: () => {}}};
  vm.createContext(workflow);
  vm.runInContext(extract('frontend/workbench.js', 'function pptPlan(', 'function pptPagePrompt(')
    + extract('frontend/workbench.js', 'function adoptPptBoards(', 'function buildPptPages(')
    + extract('frontend/app.js', 'function normalizePptDraft(', 'function localDate('), workflow);
  workflow.normalizePptDraft(ppt);
  assert.equal(ppt.stage, 2, 'outline-only draft reopens in image storyboard');
  assert.equal(ppt.maxStage, 2);
  ppt.boards = ['cover-image', null];
  workflow.adoptPptBoards();
  assert.equal(saves, 0, 'a missing storyboard image blocks the final stage');
  ppt.boards[1] = 'body-image';
  workflow.adoptPptBoards();
  assert.equal(ppt.stage, 3);
  assert.deepEqual(Array.from(ppt.pages), ['cover-image', 'body-image']);
  assert.equal(saves, 1);
  console.log('PASS: outline-only draft recovery, missing storyboard guard, selected images carried into final');

  const existingOutline = [['汇报', '封面副标题', 'cover'], ['进展', '已完成', 'points']];
  const adjusted = {...ppt, stage: 1, outline: existingOutline, active: 1,
    boards: ['cover-image', 'body-image'], pages: ['cover-image', 'body-image'],
    generationId: 'before', boardHistory: {1: ['older-body']}, history: {},
    pageEdits: {1: {prompt: '保留配色'}}, textboxes: {1: [{text: '进展'}]}, tracked: [],
    refineProposal: {stamp: JSON.stringify(existingOutline), outline: [...existingOutline, ['谢谢聆听', '欢迎提问', 'closing']]}};
  workflow.state.ppt = adjusted;
  workflow.crypto = {randomUUID: () => 'after'};
  vm.runInContext(extract('frontend/workbench.js', 'function resetDeck(', 'const pptResolutions')
    + extract('frontend/workbench.js', 'function pptProposalRows(', 'async function refinePptOutline(')
    + extract('frontend/workbench.js', 'function focusPptRefinement(', 'async function revisePptPrompt('), workflow);
  workflow.applyPptProposal();
  assert.deepEqual(Array.from(adjusted.boards.slice(0, 2)), ['cover-image', 'body-image'],
    'appending a closing page via the adjustment flow retains the two existing images');
  assert.equal(adjusted.boards[2] ?? null, null);
  assert.equal(adjusted.pageEdits[1].prompt, '保留配色');
  assert.equal(adjusted.textboxes[1][0].text, '进展');
  vm.runInContext(extract('frontend/workbench.js', 'function pptOutlineProposal(', 'function pptProposalPreview('), workflow);
  adjusted.stage = 2;
  workflow.saveStoryboardPage(adjusted, 1, ['新增页', '新内容', 'points'], true);
  assert.deepEqual(Array.from(adjusted.boards), ['cover-image', null, 'body-image', null]);
  assert.equal(adjusted.pageEdits[2].prompt, '保留配色');
  assert.equal(adjusted.textboxes[2][0].text, '进展');
  workflow.saveStoryboardPage(adjusted, 2, ['进展', '修改后', 'points']);
  assert.deepEqual(Array.from(adjusted.boards), ['cover-image', null, null, null]);
  assert.deepEqual(Array.from(adjusted.boardHistory[2]), ['older-body', 'body-image']);
  workflow.saveStoryboardPage(adjusted, 3, null);
  workflow.normalizePptDraft(adjusted);
  assert.equal(workflow.pptPlan(adjusted).length, 3, 'deleted closing does not return after reopen');
  const revised = workflow.pptOutlineProposal(adjusted.outline, [
    {op: 'update', page: 2, slide: ['新增页', '仅改这个内容', 'points']},
    {op: 'move', page: 3, after: 1}, {op: 'insert', after: 3, slide: ['感谢聆听', '', 'closing']}
  ]);
  assert.deepEqual(Array.from(revised.origins), [0, 2, null, 1]);
  assert.equal(revised.outline[1], adjusted.outline[2], 'unrequested text stays verbatim');
  const legacy = workflow.pptOutlineProposal([['旧封面', '副标题']], [
    {op: 'insert', after: 0, slide: ['导读', '正文', 'points']}
  ]);
  assert.equal(legacy.outline[1][2], 'cover', 'an older cover keeps its inferred layout after its page number changes');
  const closing = ['感谢聆听', '欢迎交流', 'closing'];
  const workingOutline = Array.from({length:12}, (_, i) => [`页面 ${i + 1}`, '已确认的正文', i === 11 ? 'closing' : 'points']);
  const refine = {...adjusted, stage: 1, outline: workingOutline, refineDraft: '',
    refineTurns: [{question: '把第12页改成感谢聆听', reply: '建议第 12 页用「感谢聆听」'}]};
  const legacyOutline = workingOutline.map((row, i) => i === 11 ? closing : [row[0], '模型重新写的内容', row[2]]);
  workflow.state.ppt = refine;
  Object.assign(workflow, {identity: 1, ui: {}, content: {querySelector: () => null},
    live: {}, requireAccount: () => true, modelFor: () => ({selected: {name: '测试'}}),
    pptLanguageRequest: () => ({history: []}), tokenRateText: () => '', compactSearchResult: () => undefined,
    openModal: (...args) => { workflow.confirmRefinement = args.at(-1); },
    pptLanguageTask: async (_ppt, _path, payload, apply) => {
      workflow.sentRefinement = payload;
      apply({outline: legacyOutline});
    }
  });
  vm.runInContext(extract('frontend/workbench.js', 'function pptOutlineProposal(', 'async function revisePptPrompt('), workflow);
  await workflow.refinePptOutline(true);
  await workflow.confirmRefinement();
  assert.match(workflow.sentRefinement.message, /第12页/);
  assert.equal(refine.refineProposal.outline[0][1], '已确认的正文', 'the old server response cannot rewrite neighboring pages');
  assert.equal(refine.refineProposal.outline[11][0], '感谢聆听', 'the selected closing slide becomes available in the preview');
  assert.deepEqual(Array.from(workflow.pptProposalRows(refine).filter(row => row.change), row => row.index), [11]);
  workflow.applyPptProposal();
  assert.equal(refine.outline[0][1], '已确认的正文');
  assert.equal(refine.outline[11][0], '感谢聆听');
  assert.match(workflow.ui.pptRefineStatus.message, /已应用/);
  const newOutline = workflow.initialPptOutline([['技术分享', '简介'], ['行动建议', '推进试点', 'points']]);
  assert.deepEqual(Array.from(newOutline, row => row[2]), ['cover', 'points', 'closing']);
  const fullOutline = Array.from({length:24}, (_, index) => ['第 ' + (index + 1) + ' 页', '正文']);
  assert.equal(workflow.initialPptOutline(fullOutline).length, 24, 'automatic closing respects the initial page limit');
  const customClosing = workflow.initialPptOutline([['汇报','简介','cover'], ['让试点落地','共同行动','closing'], ['证据','正文','points']]);
  assert.deepEqual(Array.from(customClosing, row => row[0]), ['汇报', '证据', '让试点落地']);
  assert.deepEqual(Array.from(workflow.pptPlan({outline: newOutline, agenda: true}), page => page.layout),
    ['cover', 'agenda', 'points', 'closing']);
  const referenceOutline = workflow.initialPptOutline([newOutline[0], ['议程', '三个议题', 'agenda'], ...newOutline.slice(1)]);
  assert.equal(workflow.pptPlan({outline: referenceOutline, agenda: true}).filter(page => page.layout === 'agenda').length, 1);
  console.log('PASS: local page edits, preserved shifted assets and textboxes, closing defaults, optional or existing agenda');

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
