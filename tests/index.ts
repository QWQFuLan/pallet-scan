import { runAll } from './suite';
import { runRoundTrip } from './roundtrip';

const logic = runAll();
const roundTrip = runRoundTrip();

const passed = logic.passed + roundTrip.passed;
const failures = [...logic.failures, ...roundTrip.failures];

console.log(`\n通过 ${passed} 项检查`);
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部自检通过 ✅（含 Excel 导出/解析往返、模式二配板、备份恢复）');
