const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fn(path, start, end) {
  const text = fs.readFileSync(path, 'utf8');
  const at = text.indexOf(`function ${start}(`);
  assert.ok(at >= 0, start);
  return text.slice(at, text.indexOf(`function ${end}(`, at));
}
const formats = ['main', 'square', 'wide'].map(id => ({id, name: id, width: 100, height: 100}));
const jobs = [2, 1].flatMap(batch => formats.map(format => ({id: `job-${batch}-${format.id}`, scope: 'poster',
  status: 'succeeded', assetId: `image-${batch}-${format.id}`, created: batch,
  context: {documentId: 'project-a', formatId: format.id}})));
const box = {crypto: require('node:crypto').webcrypto, pending: new Map(),
  workspaceProjects: {posterSwitching: () => false},
  state: {poster: {documentId: 'project-a', projectId: 'saved-project-a', advisorSessionId: 'first-chat',
    discussion: [{question: 'first', reply: 'recorded'}], visuals: Object.fromEntries(formats.map(f => [f.id, `image-2-${f.id}`]))}},
  live: {jobs, allJobs: jobs}, ui: {files: jobs.map(j => ({id: j.assetId})), file: {}}, posterFormats: formats,
  posterArtwork: (format, asset) => `<img data-image="${asset?.id || box.state.poster.visuals[format.id]}">`,
  posterFormatJob: (format, asset) => jobs.find(j => j.assetId === asset),
  assetGenerationJob: id => jobs.find(j => j.assetId === id),
  activeJob: job => ['queued','running','unknown'].includes(job.status),
  outputJobStatus: () => '', jobErrorLink: () => '', esc: String, button: (text, action, value) => `<button data-action="${action}" data-value="${value}">${text}</button>`,
  save() {}, render() {}, content: {querySelector: () => ({focus() {}})}};
vm.createContext(box);
vm.runInContext(fn('frontend/poster.js', 'posterVisual', 'posterReferences'), box);
vm.runInContext(fn('frontend/poster.js', 'posterGallery', 'posterStageJobStatus'), box);
vm.runInContext(fn('frontend/poster.js', 'switchPosterChat', 'activePosterFormats'), box);

const failures = [];
function check(name, test) {
  try { test(); console.log('PASS: ' + name); }
  catch (error) { failures.push(name); console.error('FAIL: ' + name + ': ' + error.message); }
}
check('same project keeps both batches in one gallery', () => {
  const html = box.posterGallery(formats);
  assert.equal((html.match(/class="poster-result"/g) || []).length, 6);
  for (const job of jobs) assert.ok(html.includes(job.assetId), job.assetId);
});
check('refresh, hidden task records and other projects do not lose or mix images', () => {
  box.state.poster = JSON.parse(JSON.stringify(box.state.poster));
  box.live.allJobs = [{...jobs[0], id: 'other', context: {documentId: 'project-b', formatId: 'main'}},
    ...jobs.map(j => ({...j, hidden: true}))];
  assert.equal(box.posterResults().length, 6);
  assert.equal(box.posterResults().filter(r => r.job.id === 'other').length, 0);
  box.live.allJobs = jobs;
});
check('a new pending result retains all delivered versions and their original job', () => {
  box.live.allJobs = [{id: 'pending', scope: 'poster', status: 'running', context: {documentId: 'project-a', formatId: 'main'}}, ...jobs];
  assert.equal(box.posterResults().length, 7);
  assert.equal(box.posterResults().filter(r => r.asset).length, 6);
  assert.equal(box.posterResult('main:image-1-main').job.id, 'job-1-main');
  assert.equal(box.posterResult('main:image-2-main').job.id, 'job-2-main');
  box.live.allJobs = jobs;
});
check('conversations cannot switch during a project switch', () => {
  const before = JSON.stringify(box.state.poster);
  box.workspaceProjects.posterSwitching = () => true;
  box.switchPosterChat();
  assert.equal(JSON.stringify(box.state.poster), before);
  box.workspaceProjects.posterSwitching = () => false;
});
check('opening conversations never drops older conversations or changes project', () => {
  for (let i = 0; i < 11; i++) {
    box.state.poster.discussion = [{question: `dialogue-${i}`, reply: 'recorded'}];
    box.switchPosterChat();
  }
  assert.equal(box.state.poster.advisorHistory.length, 11);
  assert.equal(box.state.poster.documentId, 'project-a');
  assert.equal(box.state.poster.projectId, 'saved-project-a');
  const first = box.state.poster.advisorHistory.at(-1);
  box.switchPosterChat(10);
  assert.equal(box.state.poster.advisorSessionId, first.sessionId);
  assert.equal(box.state.poster.discussion[0].question, 'dialogue-0');
  assert.equal(box.posterResults().length, 6);
});
Object.assign(box, {uploadDescriptor: asset => ({id: asset.id, url: '/api/assets/' + asset.id}), posterPresetFor: () => 'auto',
  workspaceRaster: {poster: options => options, zip: entries => entries}, identity: 'fixture',
  notify() {}, posterFilename: () => 'poster'});
vm.runInContext(fn('frontend/poster.js', 'posterRenderOptions', 'posterFilename'), box);
vm.runInContext(fn('frontend/poster.js', 'posterOutput', 'posterArtwork'), box);
check('each download or edit renders the selected original asset and copy', () => {
  for (const job of jobs) job.context.posterPromptOnly = true;
  const app = fs.readFileSync('frontend/app.js', 'utf8');
  const start = app.indexOf('"poster-download": value =>');
  vm.runInContext('handlers = {' + app.slice(start, app.indexOf('"use-poster-product":', start)) + '}', box);
  box.workspaceMedia = {download: descriptor => descriptor.render()};
  box.sendToEditor = descriptor => descriptor.render();
  for (const action of ['poster-download', 'poster-edit']) {
    const rendered = box.handlers[action]('main:image-1-main');
    assert.equal(rendered.photo.id, 'image-1-main');
    assert.equal(rendered.promptOnly, true);
  }
  const oldJob = jobs.find(j => j.assetId === 'image-1-main');
  oldJob.context.posterPromptOnly = false;
  oldJob.context.posterCopy = {title: 'original title', subtitle: '', date: '', logoId: 'old-logo'};
  box.ui.files.push({id: 'old-logo'});
  box.state.poster.title = 'changed title';
  const result = box.posterResult('main:image-1-main');
  assert.equal(box.posterOutput(result.format, result.asset).render().title, 'original title');
  assert.equal(box.posterOutput(result.format, result.asset).render().logo, '/api/assets/old-logo');
});
vm.runInContext('async ' + fn('frontend/poster.js', 'outputPosters', 'posterAdvisor').replace(/async\s*$/, ''), box);
(async () => {
  try {
    box.workspaceMedia = {getBlob: descriptor => descriptor.render(), download: descriptor => {
      const entries = descriptor.render();
      assert.equal(entries.length, 6);
      assert.equal(new Set(entries.map(e => e.name)).size, 6);
      assert.deepEqual(new Set(entries.map(e => e.blob.photo.id)), new Set(jobs.map(j => j.assetId)));
    }};
    await box.outputPosters(false);
    console.log('PASS: ZIP includes all six original images with unique filenames');
  } catch (error) { failures.push('ZIP'); console.error(error); }
  if (failures.length) process.exitCode = 1;
})();
