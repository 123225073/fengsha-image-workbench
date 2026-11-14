const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({esc: value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))});
vm.runInContext(fs.readFileSync('frontend/ppt-templates.js', 'utf8') + '\nglobalThis.templates = workspacePptTemplates;', context);
const library = context.templates;
const palettes = {
  '基础·商务蓝': ['#ffffff', '#172b4d', '#2255a4'],
  '基础·极简灰': ['#ffffff', '#202124', '#58606b'],
  '基础·教育绿': ['#f8fbf8', '#183e32', '#26775b'],
  '基础·暖白橙': ['#fffcf7', '#49362d', '#b35e22'],
  '海湾·商务提案': ['#f3f7fa', '#102b45', '#136789'],
  '信号·技术分享': ['#132337', '#f0f6fe', '#70d9c0'],
  '纸本·研究纪要': ['#f7f2e8', '#362820', '#9a4938'],
};
for (const [name, colors] of Object.entries(palettes)) {
  const native = library.nativeTemplate(name);
  assert.deepEqual(Array.from(native.colors), colors, name + ' has export palette');
  assert.equal(native.layout, 'points');
  assert.ok(library.visualGuide(name).includes(colors[2]));
  native.colors[0] = '#000000';
  assert.equal(library.nativeTemplate(name).colors[0], colors[0], 'callers cannot mutate library');
}
assert.equal(library.nativeTemplate('unknown').name, '基础·商务蓝');
assert.equal(library.nativeTemplate('实施路线图').layout, 'process', 'historic style remains usable');
assert.equal(library.nativeTemplate('极简').layout, 'comparison');
assert.match(library.summary('商务深蓝'), /已停用的旧样式/, 'historic preset stays readable');
const references = [
  ['海湾·商务提案', 'bay'], ['信号·技术分享', 'signal'], ['纸本·研究纪要', 'paper'],
  ['向上·年度经营', 'orbit'], ['赤焰·新品发布', 'launch'], ['浅岛·企业培训', 'classroom'],
  ['远山·融资路演', 'pitch'], ['山野·可持续行动', 'impact'], ['莓红·品牌营销', 'market'],
  ['霓光·未来科技', 'prism'], ['电蓝·创意演讲', 'pulse'], ['长夜·故事分享', 'ember'],
];
assert.deepEqual(Array.from(library.availableNames()).sort(), references.map(([name]) => name).sort());
for (const [name, key] of references) {
  assert.equal(library.referenceKey(name), key);
  const path = 'frontend/ppt-style-references/' + key + '.jpg';
  assert.ok(fs.statSync(path).size > 60000, 'raster reference packaged');
  const summary = library.summary(name);
  assert.equal((summary.match(/<img /g) || []).length, 1);
  assert.ok(summary.includes('/' + path));
}
assert.equal(library.referenceKey('商务深蓝'), '');
assert.match(library.visualGuide('信号·技术分享', 'process'), /等宽字.*技术模块.*连接/);
assert.match(library.visualGuide('海湾·商务提案', 'cover'), /副标题.*斜切/);
assert.match(library.visualGuide('纸本·研究纪要', 'comparison'), /宋体.*细竖线/);
assert.notEqual(library.visualGuide('海湾·商务提案', 'cover'), library.visualGuide('海湾·商务提案', 'agenda'));
const installed = {
  key: 'festival-shore', name: '试验演讲', category: '舞台演讲', title: '海岸舞台',
  colors: ['#F7F3E5', '#233D31', '#A97537'], inner: ['#233D31', '#F7F3E5', '#A97537'],
  summary: '外接模板说明', type: '中文无衬线标题。', pages: {cover: '全幅封面。', points: '内容以两栏对照。'},
  keywords: ['试验'],
};
const enhanced = vm.createContext({esc: context.esc, workspacePptReferenceCatalog: [installed]});
vm.runInContext(fs.readFileSync('frontend/ppt-templates.js', 'utf8') + '\nglobalThis.templates = workspacePptTemplates;', enhanced);
const catalog = enhanced.templates;
assert.equal(catalog.availableNames().length, references.length + 1);
assert.equal(catalog.referenceKey(installed.name), installed.key);
assert.deepEqual(Array.from(catalog.nativeTemplate(installed.name).colors), installed.colors);
assert.match(catalog.visualGuide(installed.name, 'points'), /底色 #233D31.*内容以两栏对照/);
assert.match(catalog.visualGuide(installed.name, 'cover'), /底色 #F7F3E5.*全幅封面/);
assert.match(catalog.summary(installed.name), /festival-shore\.jpg/);
assert.equal(catalog.referenceKey('商务深蓝'), '');
console.log('PASS: built-in and installed image templates, legacy styles excluded from picker, native palettes retained');
