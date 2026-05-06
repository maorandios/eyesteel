import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No IFC file provided" }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".ifc")) {
      return NextResponse.json({ error: "Only IFC files are supported" }, { status: 400 });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eyesteel-ifc-"));
    const ifcPath = path.join(tempDir, file.name);
    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(ifcPath, bytes);

    const result = await runAnalyzer(ifcPath, process.cwd());
    await fs.rm(tempDir, { recursive: true, force: true });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analyzer error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function runAnalyzer(ifcPath: string, cwd: string): Promise<unknown> {
  const scriptPath = path.join(cwd, "scripts", "run_analyzer.py");
  const attempts: Array<{ command: string; args: string[] }> = [
    { command: "python", args: [scriptPath, ifcPath] },
    { command: "python3", args: [scriptPath, ifcPath] },
    { command: "py", args: ["-3", scriptPath, ifcPath] },
  ];

  let lastError = "Python runtime not found";
  for (const attempt of attempts) {
    try {
      const output = await runProcess(attempt.command, attempt.args, cwd);
      return JSON.parse(output);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`IFC analyzer execution failed: ${lastError}`);
}

function runProcess(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}
