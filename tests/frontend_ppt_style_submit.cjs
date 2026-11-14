const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync('frontend/workbench.js', 'utf8');
const templateCode = fs.readFileSync('frontend/ppt-templates.js', 'utf8');
function source(start, end) {
  const from = code.indexOf('function ' + start + '(');
  const to = code.indexOf('function ' + end + '(', from);
  assert.ok(from >= 0 && to > from);
  return code.slice(from, to);
}

for (const {caps, limit, existing, expectedImages, styleKey} of [
  {caps: ['generate'], limit: 0, existing: false, expectedImages: [], styleKey: undefined},
  {caps: ['generate', 'reference'], limit: 1, existing: false, expectedImages: [], styleKey: 'signal'},
  {caps: ['generate', 'reference'], limit: 1, existing: true, expectedImages: ['selected'], styleKey: undefined},
  {caps: ['generate', 'reference', 'multiReference'], limit: 2, existing: true, expectedImages: ['selected'], styleKey: 'signal'},
]) {
  const ppt = {stage: existing ? 2 : 1, outline: [['独立测试标题', '只保留已确认的内容；结论一']],
    style: '信号·技术分享', active: 0, boards: existing ? ['selected'] : [], pages: [], pageEdits: {}};
  const before = JSON.stringify(ppt);
  let captured;
  const context = vm.createContext({
    state: {ppt},
    live: {allJobs: []},
    pptLayouts: {cover: '封面'},
    pptResolutions: {'1920x1080': '1920 × 1080'},
    notify: message => { assert.fail(message); },
    visualExists: id => id === 'selected',
    modelFor: () => ({selected: {id: 'model', capabilities: caps, maxReferences: limit}}),
    confirmImages: (_, _model, requests) => { captured = requests[0]; },
  });
  vm.runInContext(templateCode + '\n' + source('pptPlan', 'compactSearchResult') + '\n' +
    source('buildPptPages', 'confirmImageTool').replace(/\basync\s*$/, ''), context);
  context.buildPptPages(existing ? 'board-redo' : 'board');
  assert.equal(JSON.stringify(ppt), before, 'template submission does not mutate outline, stage or images before confirmation');
  assert.deepEqual(Array.from(captured.imageIds), expectedImages);
  assert.equal(captured.context.pptStyleReference, styleKey);
  assert.match(captured.prompt, /独立测试标题.*[\s\S]*只保留已确认的内容/);
  assert.match(captured.prompt, /信号·技术分享/);
  if (styleKey) {
    assert.match(captured.prompt, new RegExp('第 ' + (existing ? '2' : '1') + ' 张输入是模板参考图'));
    assert.match(captured.prompt, /示例标题.*不要复现/);
  } else {
    assert.doesNotMatch(captured.prompt, /张输入是模板参考图/);
  }
}

console.log('PASS: reference attachment and selected-slide priority across four model configurations');
