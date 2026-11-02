// Browser globals, module mocks and captured storage backends must not leak between files.
// Use processes so this also works on Bun 1.3.8, which has no --isolate flag.
const files = [...new Bun.Glob("tests/**/*.test.ts").scanSync()].sort();
const filters = process.argv.slice(2);
let failed = 0;
for (const file of files.filter(file => !filters.length || filters.some(filter => file.includes(filter)))) {
  const child = Bun.spawn([process.execPath, "test", `./${file}`], {
    env: { ...process.env, NODE_ENV: "test" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) failed++;
}
console.log(`\n${failed} test files failed.`);
process.exit(failed ? 1 : 0);
