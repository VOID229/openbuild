import { expect, test } from "bun:test";

// A pipe does not exercise readline's raw-mode Ctrl+C handling. Run the prompt
// in a local pseudo-terminal (also works on macOS without a terminal emulator).
const python = String.raw`
import json, os, pty, subprocess, sys, time
master, slave = pty.openpty()
os.set_blocking(master, False)
child = subprocess.Popen([sys.argv[1], '-e', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
sent = None
start = time.monotonic()
try:
    while time.monotonic() - start < 4:
        try:
            output += os.read(master, 8192)
        except OSError:
            pass
        if sent is None and b'[Y/n]' in output:
            sent = time.monotonic()
            os.write(master, bytes.fromhex(sys.argv[3]))
        if child.poll() is not None:
            break
        time.sleep(0.005)
    print(json.dumps({'code': child.poll(), 'output': output.decode(errors='replace'), 'elapsed': None if sent is None else time.monotonic() - sent}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
`;

const hasPython = process.platform !== "win32" && Bun.spawnSync(["which", "python3"]).exitCode === 0;
for (const [name, input, code, result] of [
  ["no returns promptly", "6e0a", 0, "answer:false"],
  ["Enter accepts the default", "0a", 0, "answer:true"],
  ["yes accepts", "790a", 0, "answer:true"],
  ["first Ctrl+C exits", "03", 130, null],
] as const) {
  test.skipIf(!hasPython)(`CLI confirmation: ${name}`, () => {
    const script = `import { confirm } from ${JSON.stringify(`${import.meta.dir}/../bin/prompt.ts`)}; console.log('answer:' + await confirm('Proceed?'));`;
    const child = Bun.spawnSync(["python3", "-c", python, process.execPath, script, input], { timeout: 6000 });
    expect(child.exitCode).toBe(0);
    const actual = JSON.parse(child.stdout.toString());
    expect(actual.code).toBe(code);
    expect(actual.elapsed).toBeLessThan(1);
    if (result) expect(actual.output).toContain(result);
    else expect(actual.output).not.toContain("answer:");
  });
}
