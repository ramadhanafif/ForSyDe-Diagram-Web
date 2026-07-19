import { parse } from './src/core/parser.ts';
import { elaborate } from './src/core/elaborate.ts';

// Test 1: Block comment spanning multiple lines
const test1 = `
{- This is a
   multiline comment
   spanning several lines -}
actor1 = actor11SDF 1 1 f
system = out
`;

const r1 = parse(test1);
console.log('Test 1 - multiline block comment:', r1.diagnostics.filter(d => d.severity === 'error').length === 0 ? 'PASS' : 'FAIL');

// Test 2: Multiple block comments
const test2 = `
{- Comment 1 -}
actor1 = actor11SDF 1 1 f
{- Comment 2 -}
system = out
`;

const r2 = parse(test2);
console.log('Test 2 - multiple block comments:', r2.diagnostics.filter(d => d.severity === 'error').length === 0 ? 'PASS' : 'FAIL');

// Test 3: Tuple with single element (should fail)
const test3 = `
actor1 = actor11SDF 1 1 f
system = (out)
`;

const r3 = parse(test3);
const hasError = r3.diagnostics.filter(d => d.severity === 'error').length > 0;
console.log('Test 3 - single element tuple (should fail):', hasError ? 'PASS' : 'FAIL');

// Test 4: nested where block (should fail)
const test4 = `
actor1 = actor11SDF 1 1 f
system out = x where
  where_inner = actor1 y
`;

const r4 = parse(test4);
const hasError4 = r4.diagnostics.filter(d => d.severity === 'error').length > 0;
console.log('Test 4 - nested where:', hasError4 ? 'Expected error' : 'No error');
