import { test } from './harness.js';
import { resolveModule } from '../tools/modules.js';

// Amiga filesystems are case-insensitive, so real E/E-VO resolve
// MODULE 'afc/nodemaster' to the file afc/NodeMaster.m. ecomp runs on a
// case-sensitive host, so module resolution must fold case too — otherwise the
// 21 mixed-case bundled modules (EasyGUI, Vector, NodeMaster, …) are invisible
// when referenced with different casing (the Sort_Example.e regression).
test('module resolution is case-insensitive (afc/nodemaster -> NodeMaster.m)', a => {
  const m = resolveModule('afc/nodemaster');
  a.ok(m, 'afc/nodemaster must resolve despite the mixed-case filename');
  a.equal(m.isCodeModule, true);
  const cls = m.objects.get('nodemaster');
  a.ok(cls, 'nodemaster object present');
  a.ok(cls.methods.some(x => x.name === 'nodemaster'), 'constructor method exposed');
});

test('exact-case module names still resolve (tools/EasyGUI)', a => {
  const m = resolveModule('tools/EasyGUI');
  a.ok(m && m.isCodeModule, 'tools/EasyGUI still resolves');
});

test('a genuinely missing module still returns null', a => {
  a.equal(resolveModule('no/such/module'), null);
});
