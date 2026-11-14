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
};
for (const [name, colors] of Object.entries(palettes)) {
  const native = library.nativeTemplate(name);
  assert.deepEqual(Array.from(native.colors), colors, name + ' has export palette');
  assert.equal(native.layout, 'points');
  assert.match(library.summary(name), /ppt-native-preview/);
  assert.ok(library.visualGuide(name).includes(colors[2]));
  native.colors[0] = '#000000';
  assert.equal(library.nativeTemplate(name).colors[0], colors[0], 'callers cannot mutate library');
}
assert.equal(library.nativeTemplate('unknown').name, '基础·商务蓝');
assert.equal(library.nativeTemplate('实施路线图').layout, 'process', 'historic style remains usable');
assert.equal(library.nativeTemplate('极简').layout, 'comparison');
assert.match(library.summary('商务深蓝'), /场景风格参考/, 'historic AI visual reference does not claim exact exported template');
const slides = library.nativeSamples();
assert.deepEqual(Array.from(slides, slide => slide.layout), ['cover', 'section', 'points', 'comparison', 'process', 'closing']);
assert.ok(slides.every(slide => slide.title && slide.detail && slide.title.length <= 120 && slide.detail.length <= 2000));
slides[0].title = 'changed';
assert.notEqual(library.nativeSamples()[0].title, 'changed');
console.log('PASS: 4 native palettes, immutable export contract, legacy styles, 6 complete sample layouts');
