import type { Subprocess } from "bun";
import { TEST_DATABASE_URL } from "./db";

export interface Instance {
  port: number;
  url: string;
  proc: Subprocess;
}

/** Starts a real copy of the service as a separate process (its own pool, its own workers). */
export async function startInstance(port: number, env: Record<string, string> = {}): Promise<Instance> {
  const proc = Bun.spawn(["bun", "src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      INSTANCE_ID: `test-${port}`,
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: "silent",
      DB_POOL_MAX: "10",
      SQS_WAIT_SECONDS: "1",
      OUTBOX_POLL_MS: "100",
      PENDING_REFERENCE_POLL_MS: "200",
      PENDING_REFERENCE_BASE_DELAY_MS: "200",
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) return { port, url, proc };
    } catch {}
    await Bun.sleep(200);
  }
  proc.kill();
  throw new Error(`instance on ${port} did not become ready`);
}

export async function stopInstance(instance: Instance, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  instance.proc.kill(signal);
  await instance.proc.exited;
}

export async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}