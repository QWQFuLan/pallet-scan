/**
 * 把 src 下的 .ts/.tsx 用 TypeScript 编译器（纯 JS，不启动子进程）转成 CommonJS，
 * 供 Node 侧端到端自检使用（happy-dom 里跑真实 React 组件）。
 *
 *   node tests/transpile-src.mjs
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');
const outRoot = join(root, '.tmp', 'lib');

rmSync(outRoot, { recursive: true, force: true });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  skipLibCheck: true,
  inlineSourceMap: false,
};

const files = [...walk(srcDir), ...walk(here)];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: options,
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    console.error(`[transpile] ${relative(root, file)} 有语法错误：`);
    for (const error of errors) console.error(`  ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    process.exit(1);
  }
  const rel = relative(file.startsWith(here) ? here : srcDir, file).replace(/\.tsx?$/, '.js');
  const target = join(outRoot, file.startsWith(here) ? 'tests' : 'src', rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output.outputText);
}

console.log(`[transpile] 已转换 ${files.length} 个文件到 .tmp/lib`);
