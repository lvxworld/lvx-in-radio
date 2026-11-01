import { execFile } from 'node:child_process';

const READ_TIMEOUT_MS = 2_000;

export function parseGpuPercent(statistics) {
  const match = /"Device Utilization %"\s*=\s*(\d+)/.exec(statistics);
  return match ? Number(match[1]) : null;
}

/** The GPU load right now, or null where the system does not report it. */
export function readGpuPercent() {
  return new Promise((resolve) => {
    execFile('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { timeout: READ_TIMEOUT_MS }, (error, output) => {
      resolve(error ? null : parseGpuPercent(output));
    });
  });
}
