import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, evidenceReady } from '../electric-plugin/engineering.mjs';
import { compileForm, pilot } from '../electric-plugin/workflow.mjs';
import { makeZip } from '../electric-plugin/zip.mjs';

test('candidate preserves untouched UTF-16LE rows, line endings and BOM', () => {
  const bom = Buffer.from([255, 254]);
  const original = Buffer.concat([bom, Buffer.from('n\ti\top\r\n0\tOUT\tY0\r\n1\tEND\t\r\n', 'utf16le')]);
  const edits = [{ line: 2, before: '0\tOUT\tY0', after: '0\tOUT\tY1' }];
  const { data } = applyEdits(original, edits);
  assert.deepEqual(data, Buffer.concat([bom, Buffer.from('n\ti\top\r\n0\tOUT\tY1\r\n1\tEND\t\r\n', 'utf16le')]));
  assert.throws(() => applyEdits(original, [{ ...edits[0], before: '0\tOUT\tY2' }]), /不一致/);
  assert.throws(() => applyEdits(original, [{ ...edits[0], after: '0\tOUT\tY1\t extra' }]), /列数/);
});

test('engineering template rejects cycles and bypassed approval', () => {
  const template = compileForm(pilot);
  assert.equal(template.spec.policies.maxConcurrentNodes, 3);
  assert.equal(template.spec.nodes.find(node => node.id === 'proposal').inputs['plan-review'].output.nodeId, 'plan-review');
  const cyclic = structuredClone(pilot);
  cyclic.steps[0].depends.push('plan');
  assert.throws(() => compileForm(cyclic), /环路/);
  const bypass = structuredClone(pilot);
  bypass.steps.find(step => step.id === 'candidate').depends = ['proposal'];
  assert.throws(() => compileForm(bypass), /必需依赖/);
});

test('only the most recent current-version evidence counts for release', () => {
  const both = [{ kind: 'compile', digest: 'b', verdict: 'pass' }, { kind: 'simulation', digest: 'b', verdict: 'pass' }];
  assert.equal(evidenceReady(both, 'b'), true);
  assert.equal(evidenceReady(both, 'c'), false);
  assert.equal(evidenceReady([...both, { kind: 'compile', digest: 'b', verdict: 'fail' }], 'b'), false);
  const rehearsed = both.map(log => ({ ...log, source: 'test' }));
  assert.equal(evidenceReady(rehearsed, 'b'), false);
  assert.equal(evidenceReady(rehearsed, 'b', 'test'), true);
});

test('rehearsal edits only replace the final annotation field', () => {
  const header = '步号\t行间声明\t指令\tI/O(软元件)\t空白栏\tPI声明\t注解\r\n';
  const row = '"9253"\t""\t"SET"\t"M22079"\t""\t""\t""';
  const edit = { line: 2, before: row, after: row.slice(0, -1) + '测试"' };
  const original = Buffer.from(header + row);
  assert.equal(applyEdits(original, [edit], true).data.toString(), header + edit.after);
  assert.throws(() => applyEdits(original, [{ ...edit, after: edit.after.replace('M22079', 'M22080') }], true), /注释/);
  assert.throws(() => applyEdits(Buffer.from('0,OUT,Y0'), [{ line: 1, before: '0,OUT,Y0', after: '0,OUT,Y1' }], true), /注释列/);
});

test('handoff archive records UTF-8 names and valid headers', () => {
  const archive = makeZip([['候选/a.csv', 'test'], ['工程记录.json', '{}']]);
  assert.equal(archive.readUInt32LE(), 0x04034b50);
  assert.equal(archive.readUInt16LE(6), 0x0800);
  assert.equal(archive.readUInt16LE(archive.length - 12), 2);
  const centralOffset = archive.readUInt32LE(archive.length - 6);
  assert.equal(archive.readUInt32LE(centralOffset), 0x02014b50);
});
