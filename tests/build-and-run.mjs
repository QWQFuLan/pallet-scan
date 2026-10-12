/**
 * 一键跑全部自检：
 *   1) 把 src / tests 转成 CommonJS（TypeScript 编译器，纯 JS，无子进程）
 *   2) 修正 `@/xxx` 与省略扩展名的导入路径
 *   3) 依次执行核心逻辑自检、Excel 往返自检、界面端到端自检
 *
 *   npm test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outRoot = join(root, '.tmp', 'lib');

execFileSync(process.execPath, [join(here, 'transpile-src.mjs')], { stdio: 'inherit', cwd: root });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

function resolveSpecifier(fromDir, spec) {
  const base = resolve(fromDir, spec);
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      let rel = relative(fromDir, candidate).split(sep).join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return rel;
    }
  }
  return null;
}

const unresolved = [];
const SPECIFIER = /(from\s+|require\()(["'])([^"']+)\2/g;

for (const file of walk(outRoot)) {
  const dir = dirname(file);
  const source = readFileSync(file, 'utf8');
  const rewritten = source.replace(SPECIFIER, (match, prefix, quote, spec) => {
    // 样式文件由下面的 Module._load 钩子处理
    if (spec.endsWith('.css') || spec.endsWith('.scss')) return match;
    if (spec.startsWith('.')) {
      const resolved = resolveSpecifier(dir, spec);
      if (resolved) return `${prefix}${quote}${resolved}${quote}`;
      unresolved.push(`${relative(root, file)} -> ${spec}`);
      return match;
    }
    if (spec.startsWith('@/')) {
      const target = join(outRoot, 'src', spec.slice(2));
      const rel = relative(dir, target).split(sep).join('/');
      const resolved = resolveSpecifier(dir, rel.startsWith('.') ? rel : `./${rel}`);
      if (resolved) return `${prefix}${quote}${resolved}${quote}`;
      unresolved.push(`${relative(root, file)} -> ${spec}`);
      return match;
    }
    return match;
  });
  if (rewritten !== source) writeFileSync(file, rewritten);
}

if (unresolved.length > 0) {
  console.error('[tests] 有无法解析的导入：');
  for (const item of unresolved.slice(0, 20)) console.error(`  - ${item}`);
  process.exit(1);
}

mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));

// 让 `import './styles.css'` 之类的样式导入在 Node 里变成空对象
const Module = (await import('node:module')).default;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('.css') || request.endsWith('.scss')) return {};
  return originalLoad.call(this, request, parent, isMain);
};

console.log('\n=== 1/4 核心逻辑自检 ===');
const { runAll } = await import(pathToFileURL(join(outRoot, 'tests', 'suite.js')).href);
const { runRoundTrip } = await import(pathToFileURL(join(outRoot, 'tests', 'roundtrip.js')).href);
console.log('=== 2/4 Excel 导出/解析往返 + 配板自检 ===');
const logic = runAll();
const roundTrip = runRoundTrip();

let passed = logic.passed + roundTrip.passed;
const failures = [...logic.failures, ...roundTrip.failures];

console.log('=== 3/4 条码识别引擎自检（ZXing 编码 -> 解码） ===');
try {
  const { runBarcodeTests } = await import(pathToFileURL(join(outRoot, 'tests', 'barcode.js')).href);
  const barcode = await runBarcodeTests();
  passed += barcode.passed;
  failures.push(...barcode.failures);
} catch (error) {
  failures.push(`条码自检无法运行：${error?.message ?? error}`);
  console.error(error);
}

console.log('=== 4/4 界面端到端自检（happy-dom + React） ===');
try {
  const { runUiTests } = await import(pathToFileURL(join(outRoot, 'tests', 'ui.js')).href);
  const ui = await runUiTests();
  passed += ui.passed;
  failures.push(...ui.failures);
  for (const note of ui.notes) console.log(`ℹ️  ${note}`);
} catch (error) {
  failures.push(`界面自检无法运行：${error?.message ?? error}`);
  console.error(error);
}

console.log(`\n通过 ${passed} 项检查`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部自检通过 ✅');
