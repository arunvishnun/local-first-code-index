import test from 'node:test';
import assert from 'node:assert/strict';
import { TypeScriptSyntaxProvider } from '../dist/parser/typescript-provider.js';

function symbolsFor(content) {
  const provider = new TypeScriptSyntaxProvider();
  return provider.parse({
    filePath: '/fixture.ts',
    relativePath: 'fixture.ts',
    language: 'typescript',
    content,
  }).symbols;
}

test('marks variable declarations and local export lists as exported', () => {
  const symbols = symbolsFor(`
export const arrow = () => 1;
export const expression = function () { return 1; };
export let value = 1;
const local = () => 1;
const listed = () => 1;
const aliased = () => 1;
const defaulted = () => 1;
function container() {
  const listed = () => 2;
  return listed();
}
export { listed };
export { aliased as renamed };
export default defaulted;
export function declared() {}
export default class Named {
  load() {}
}
`);
  const exported = new Map(symbols.map((symbol) => [symbol.name, symbol.exported]));

  assert.equal(exported.get('arrow'), true);
  assert.equal(exported.get('expression'), true);
  assert.equal(exported.get('value'), true);
  assert.equal(exported.get('local'), false);
  assert.equal(exported.get('aliased'), true);
  assert.equal(exported.get('defaulted'), true);
  assert.equal(exported.get('declared'), true);
  assert.equal(exported.get('Named'), true);
  assert.equal(exported.get('load'), true);
  assert.equal(symbols.filter((symbol) => symbol.name === 'listed' && symbol.exported === true).length, 1);
  assert.equal(symbols.filter((symbol) => symbol.name === 'listed' && symbol.exported === false).length, 1);
});

test('does not treat a sourced re-export as a local exported declaration', () => {
  const symbols = symbolsFor(`
const remote = () => 1;
export { remote as publicRemote } from './other.js';
`);
  assert.equal(symbols.find((symbol) => symbol.name === 'remote')?.exported, false);
});
