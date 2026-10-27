import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemdNetworkOverride } from "../bin/systemd";

const root = resolve(import.meta.dir, "..");

test("systemd override changes only network settings and escapes unit syntax", () => {
  const config = systemdNetworkOverride({ HOST: "127.0.0.1", OPENCHAT_ALLOWED_HOSTS: 'host%name,"quoted"\\name' });
  expect(config).toContain('Environment="HOST=127.0.0.1"');
  expect(config).toContain('host%%name,\\"quoted\\"\\\\name');
  expect(config).toContain('Environment="OPENBUILD_PUBLIC_HTTPS="');
  expect(config).not.toContain("ExecStart=");
  expect(config).not.toContain("KillMode=");
});

// Fake every external control command and isolate configuration as well as data.
// No real server, user unit, or Tailscale configuration is modified.
test.skipIf(process.platform !== "linux")("managed LAN/Tailscale modes persist, switch safely, and never spawn a detached server", () => {
  const temp = mkdtempSync(join(tmpdir(), "openbuild-systemd-network-"));
  try {
    const log = join(temp, "calls");
    const data = join(temp, "data");
    const override = join(temp, "config/systemd/user/openbuild.service.d/zz-openbuild-network.conf");
    for (const [name, script] of Object.entries({
      systemctl: `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$CALL_LOG"
if [ "$2" = show ]; then
  case "$*" in
    *--property=Environment*) echo 'PORT=3210 OPENBUILD_TAILSCALE_SOCKET=/fake/socket';;
    *) printf '%s\\n' 'LoadState=loaded' "ActiveState=$SERVICE_STATE" 'KillMode=process' 'ExecStart=/bin/bun ${root}/server/index.ts';;
  esac
  exit 0
fi
if [ "$2" = "$FAIL_ACTION" ]; then echo 'mock systemd failure' >&2; exit 1; fi
`,
      tailscale: `#!/bin/sh
printf 'tailscale %s\\n' "$*" >> "$CALL_LOG"
case "$1" in --socket=*) shift;; esac
case "$*" in
  'status --json') echo '{"BackendState":"Running","Self":{"DNSName":"test.example.ts.net.","TailscaleIPs":["100.100.100.100"]},"CertDomains":["test.example.ts.net"]}';;
  'serve status --json') echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"other.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}';;
  *) if [ "$FAIL_SERVE" = yes ]; then echo 'mock serve failure' >&2; exit 1; fi;;
esac
`,
    })) {
      writeFileSync(join(temp, name), script);
      chmodSync(join(temp, name), 0o755);
    }
    const cli = (args: string[], extra: Record<string, string> = {}) => {
      writeFileSync(log, "");
      const result = Bun.spawnSync([process.execPath, join(root, "bin/openbuild.ts"), ...args], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENCHAT_DATA_DIR: data, XDG_CONFIG_HOME: join(temp, "config"), CALL_LOG: log, SERVICE_STATE: "active", FAIL_ACTION: "", FAIL_SERVE: "no", ...extra },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
      });
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), calls: readFileSync(log, "utf8") };
    };
    expect(cli(["start", "lan"]).code).toBe(1);
    expect(existsSync(override)).toBe(false);
    expect(cli(["set", "pass", "test-password"]).code).toBe(0);
    const lan = cli(["start", "lan"]);
    expect(lan.code).toBe(0);
    expect(lan.calls).toContain("systemctl --user daemon-reload");
    expect(lan.calls).toContain("systemctl --user restart openbuild.service");
    expect(lan.output).toContain(":3210");
    const lanConfig = readFileSync(override, "utf8");
    expect(lanConfig).toContain('"HOST=0.0.0.0"');
    expect(existsSync(join(data, "server.json"))).toBe(false);
    expect(existsSync(join(data, "keeper.json"))).toBe(false);
    const again = cli(["start"]);
    expect(again.code).toBe(0);
    expect(again.calls).toContain("systemctl --user start openbuild.service");
    expect(again.calls).not.toContain("daemon-reload");
    expect(cli(["restart"]).calls).toContain("systemctl --user restart openbuild.service");

    const failed = cli(["start", "local"], { FAIL_ACTION: "restart" });
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("mock systemd failure");
    expect(readFileSync(override, "utf8")).toBe(lanConfig);
    expect(JSON.parse(readFileSync(join(data, "systemd-network.json"), "utf8")).mode).toBe("lan");
    expect(cli(["start", "local"], { FAIL_ACTION: "daemon-reload" }).code).toBe(1);
    expect(readFileSync(override, "utf8")).toBe(lanConfig);
    expect(cli(["start", "tailscale"], { FAIL_SERVE: "yes" }).code).toBe(1);
    expect(readFileSync(override, "utf8")).toBe(lanConfig);

    const tail = cli(["start", "tailscale"]);
    expect(tail.code).toBe(0);
    expect(tail.output).toContain("https://test.example.ts.net:8443");
    expect(tail.calls).toContain("tailscale --socket=/fake/socket serve --bg --https=8443 http://127.0.0.1:3210");
    expect(readFileSync(override, "utf8")).toContain('"OPENBUILD_PUBLIC_HTTPS=test.example.ts.net"');
    const stopped = cli(["stop"]);
    expect(stopped.code).toBe(0);
    expect(stopped.calls).toContain("serve --https=8443 off");
    const resumed = cli(["start"], { SERVICE_STATE: "inactive" });
    expect(resumed.code).toBe(0);
    expect(resumed.calls).toContain("systemctl --user start openbuild.service");
    expect(resumed.calls).toContain("serve --bg --https=8443");
    const local = cli(["restart", "local"]);
    expect(local.code).toBe(0);
    expect(local.calls).toContain("serve --https=8443 off");
    expect(local.calls).not.toContain("serve --https=443 off");
    expect(readFileSync(override, "utf8")).toContain('"HOST=127.0.0.1"');
    expect(readFileSync(override, "utf8")).toContain('"OPENBUILD_PUBLIC_HTTPS="');
    expect(readFileSync(override, "utf8")).toContain('"OPENCHAT_ALLOWED_HOSTS="');
    expect(existsSync(join(data, "server.json"))).toBe(false);
    rmSync(override);
    expect(cli(["start", "local"], { SERVICE_STATE: "inactive", FAIL_ACTION: "start" }).code).toBe(1);
    expect(existsSync(override)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
