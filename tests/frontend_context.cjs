const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function functionSource(path, name, next) {
  const text = fs.readFileSync(path, 'utf8');
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return text.slice(start, text.indexOf(`function ${next}(`, start));
}

const sandbox = {
  crypto: require('node:crypto').webcrypto,
  pptReplacementTopic: () => '',
  pptResearchRequest: () => ({researchId: 'fixture'}),
  workspacePptTemplates: {outlineGuide: () => '科技'},
  state: {}, ui: {file: {}}, pptSlots: [],
};
vm.createContext(sandbox);
vm.runInContext(functionSource('frontend/workbench.js', 'pptLanguageRequest', 'pptResearchRequest'), sandbox);
const ppt = {brief: 'RAG 和 SAG2', style: '科技', level: '标准', searchBrief: 'RAG 和 SAG2',
  discussion: Array.from({length: 80}, (_, i) => ({question: i === 0 ? 'https://github.com/Tencent/WeKnora' : `第 ${i} 轮`, reply: '已确认'.repeat(500)}))};
const request = sandbox.pptLanguageRequest(ppt, {id: 'fixture', tokenRates: {input: 1, output: 2}}, '继续比较');
assert.equal(request.history.length, 80);
assert.equal(request.history[0].question, ppt.discussion[0].question);
assert.equal(request.history[0].reply.length, 1500);
assert.equal(request.transcript, undefined);

const render = {escape: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), URL};
vm.createContext(render);
vm.runInContext(functionSource('frontend/commercial.js', 'searchSources', 'messageAttachments'), render);
const html = render.searchSources({query: 'WeKnora | SAG-Wiki v0.2.7', queries: ['WeKnora', 'SAG-Wiki v0.2.7'],
  missingTargets: ['SAG-Wiki'], sources: [
    {title: '官方 README', url: 'https://github.com/Tencent/WeKnora', pageExcerpt: true},
    {title: 'Release', url: 'https://github.com/Zleap-AI/SAG-Wiki/releases/tag/v0.2.7', readStatus: 'unread'},
    {title: '搜索摘要', url: 'https://example.com/doc', hasSnippet: true},
    {title: '<script>bad()</script>', url: 'javascript:alert(1)'},
  ]}, 'test', true);
assert.ok(html.includes('已读取正文'));
assert.ok(html.includes('链接暂未读到正文'));
assert.ok(html.includes('仅搜索摘要'));
assert.ok(html.includes('尚缺资料：SAG-Wiki'));
assert.ok(!html.includes('javascript:'));
console.log('PASS: 80-round frontend history and visible source states');

const posterSandbox = {crypto: require('node:crypto').webcrypto, pending: new Map(),
  workspaceProjects: {posterSwitching: () => false},
  state: {poster: {advisorSessionId: 'original-session', discussion: [{question:'已确认内容',reply:'已记录'}]}},
  save() {}, render() {}, content: {querySelector: () => ({focus() {}})}};
vm.createContext(posterSandbox);
vm.runInContext(functionSource('frontend/poster.js', 'switchPosterChat', 'activePosterFormats'), posterSandbox);
posterSandbox.switchPosterChat();
assert.notEqual(posterSandbox.state.poster.advisorSessionId, 'original-session');
assert.equal(posterSandbox.state.poster.advisorHistory[0].sessionId, 'original-session');
posterSandbox.switchPosterChat(0);
assert.equal(posterSandbox.state.poster.advisorSessionId, 'original-session');
assert.equal(posterSandbox.state.poster.discussion[0].question, '已确认内容');
console.log('PASS: poster new/restored sessions retain separate memory IDs');
