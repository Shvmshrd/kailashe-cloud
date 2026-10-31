import { describe, it, expect } from "vitest";
import {
  KailasheComAuthError,
  KailasheComError,
  checkPlatformCliLogin,
  ensurePlatformCliLogin,
  platformCliAllowlist,
  platformCliBinaryName,
  publishWithPlatformCli,
  type PlatformCliRunOptions,
  type PlatformCliRunner,
} from "../src/platform-cli.js";

// ---------------------------------------------------------------------------
// Fake runner — scripts the platform CLI's --json answers. No subprocess.
// ---------------------------------------------------------------------------

interface RecordedCall {
  binary: string;
  args: readonly string[];
  stdio?: string;
  skipApproval?: boolean;
  env?: Record<string, string>;
}

const SIGNED_IN = JSON.stringify({
  baseUrl: "https://www.kailashe.com",
  user: { id: "usr_test1", email: null, displayName: "test@email.com" },
  email: null,
  operator: false,
  tokenStatus: "ok",
});

const SIGNED_OUT = JSON.stringify({
  baseUrl: "https://www.kailashe.com",
  user: null,
  email: null,
  operator: false,
  tokenStatus: "none",
});

const PUBLISHED = JSON.stringify({
  slug: "bcard",
  kind: "folder",
  title: "bcard",
  siteUrl: "https://www.kailashe.com/s/bcard",
  readerUrl: "https://www.kailashe.com/v/sharetoken",
  share: { url: "https://www.kailashe.com/v/sharetoken" },
  claimUrl: null,
  expiresAt: null,
});

function fakeRunner(script: {
  whoami: string[];
  publishExit?: number;
  publishStdout?: string;
  publishStderr?: string;
}): { runner: PlatformCliRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let whoamiCount = 0;
  const runner: PlatformCliRunner = {
    async run(opts: PlatformCliRunOptions) {
      calls.push({
        binary: opts.binary,
        args: opts.args,
        stdio: opts.stdio,
        skipApproval: opts.skipApproval,
        env: opts.env,
      });
      if (opts.args.includes("whoami")) {
        const stdout = script.whoami[Math.min(whoamiCount, script.whoami.length - 1)] ?? SIGNED_OUT;
        whoamiCount++;
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (opts.args.includes("login")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (opts.args.includes("publish")) {
        return {
          exitCode: script.publishExit ?? 0,
          stdout: script.publishStdout ?? PUBLISHED,
          stderr: script.publishStderr ?? "",
        };
      }
      throw new Error(`unexpected args: ${opts.args.join(" ")}`);
    },
  };
  return { runner, calls };
}

const BASE = { baseUrl: "https://www.kailashe.com", cwd: "/site", binary: "kailashe" };

describe("platformCliAllowlist", () => {
  it("mirrors the kailashe-com provider patterns under the shim name", () => {
    const allowlist = platformCliAllowlist("kailashe.cmd");
    expect(allowlist.every((e) => e.binary === "kailashe.cmd")).toBe(true);
    const publish = allowlist.find((e) => e.prefix.join(" ") === "--json publish");
    expect(publish?.riskClass).toBe("create");
    const login = allowlist.find((e) => e.prefix.join(" ") === "login");
    expect(login?.riskClass).toBe("iam-billing-network");
    const whoami = allowlist.find((e) => e.prefix.join(" ") === "--json whoami");
    expect(whoami?.riskClass).toBe("read");
  });

  it("uses the .cmd shim on Windows (the bare name is an unspawnable sh shim)", () => {
    expect(platformCliBinaryName("win32")).toBe("kailashe.cmd");
    expect(platformCliBinaryName("linux")).toBe("kailashe");
  });
});

describe("checkPlatformCliLogin", () => {
  it("reads the signed-in account from whoami --json", async () => {
    const { runner, calls } = fakeRunner({ whoami: [SIGNED_IN] });
    const state = await checkPlatformCliLogin({ ...BASE, runner });
    expect(state.signedIn).toBe(true);
    expect(state.account).toBe("test@email.com");
    expect(calls[0]?.args).toEqual(["--json", "whoami"]);
    expect(calls[0]?.env).toEqual({ KAILASHE_URL: "https://www.kailashe.com" });
  });

  it("reports signed-out with the platform tokenStatus", async () => {
    const { runner } = fakeRunner({ whoami: [SIGNED_OUT] });
    const state = await checkPlatformCliLogin({ ...BASE, runner });
    expect(state.signedIn).toBe(false);
    expect(state.tokenStatus).toBe("none");
  });

  it("maps a missing CLI binary to an auth error with install guidance", async () => {
    const runner: PlatformCliRunner = {
      async run() {
        throw new Error("Binary not found on sanitized PATH: kailashe.cmd");
      },
    };
    await expect(checkPlatformCliLogin({ ...BASE, runner })).rejects.toThrow(KailasheComAuthError);
    await expect(checkPlatformCliLogin({ ...BASE, runner })).rejects.toThrow(/npm install -g @kailashe\/cli/);
  });
});

describe("ensurePlatformCliLogin", () => {
  it("does not run login when already signed in", async () => {
    const { runner, calls } = fakeRunner({ whoami: [SIGNED_IN] });
    const state = await ensurePlatformCliLogin({ ...BASE, runner });
    expect(state.signedIn).toBe(true);
    expect(calls.some((c) => c.args.includes("login"))).toBe(false);
  });

  it("runs login with inherited stdio when signed out, then re-checks", async () => {
    const { runner, calls } = fakeRunner({ whoami: [SIGNED_OUT, SIGNED_IN] });
    const state = await ensurePlatformCliLogin({ ...BASE, runner });
    expect(state.signedIn).toBe(true);
    const login = calls.find((c) => c.args.includes("login"));
    expect(login?.args).toEqual(["login"]);
    expect(login?.stdio).toBe("inherit");
    expect(login?.skipApproval).toBe(true);
  });

  it("fails closed when login does not result in a signed-in CLI", async () => {
    const { runner } = fakeRunner({ whoami: [SIGNED_OUT, SIGNED_OUT] });
    await expect(ensurePlatformCliLogin({ ...BASE, runner })).rejects.toThrow(KailasheComAuthError);
  });
});

describe("publishWithPlatformCli", () => {
  it("publishes the folder under the slug and returns the subdomain URL", async () => {
    const { runner, calls } = fakeRunner({ whoami: [SIGNED_IN] });
    const result = await publishWithPlatformCli({
      ...BASE,
      runner,
      dir: "/site",
      slug: "bcard",
      title: "bcard",
      share: "public",
      operationKey: "deploy-bcard-0123456789abcdef",
    });
    expect(result.liveUrl).toBe("https://bcard.kailashe.com");
    expect(result.siteUrl).toBe("https://www.kailashe.com/s/bcard");
    expect(result.shareUrl).toBe("https://www.kailashe.com/v/sharetoken");
    expect(result.claimUrl).toBeNull();
    const publish = calls.find((c) => c.args.includes("publish"));
    expect(publish?.args).toEqual([
      "--json", "publish", "/site",
      "--slug", "bcard",
      "--title", "bcard",
      "--share", "public",
      "--operation-key", "deploy-bcard-0123456789abcdef",
    ]);
  });

  it("surfaces a failed publish with the CLI's stderr", async () => {
    const { runner } = fakeRunner({
      whoami: [SIGNED_IN],
      publishExit: 1,
      publishStdout: "",
      publishStderr: "slug is taken",
    });
    await expect(
      publishWithPlatformCli({
        ...BASE,
        runner,
        dir: "/site",
        slug: "bcard",
        title: "bcard",
        share: "public",
        operationKey: "deploy-bcard-0123456789abcdef",
      }),
    ).rejects.toThrow(KailasheComError);
    await expect(
      publishWithPlatformCli({
        ...BASE,
        runner,
        dir: "/site",
        slug: "bcard",
        title: "bcard",
        share: "public",
        operationKey: "deploy-bcard-0123456789abcdef",
      }),
    ).rejects.toThrow(/slug is taken/);
  });
});
