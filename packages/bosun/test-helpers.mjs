/**
 * Shared test harness for @noesis-ship/bosun tests.
 *
 * Provides test() and assert() with async support.
 * Pattern: Same as @noesis-ship/shared test harness.
 */

let passed = 0;
let failed = 0;

export function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { console.log(`  PASS  ${name}`); passed++; },
        (err) => { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
      );
    }
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

export function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

export function summary(suiteName) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${suiteName}: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);
  return failed;
}
