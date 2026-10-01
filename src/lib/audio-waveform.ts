import { spawn } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

export type Waveform = { duration: number; peaks: number[] };
const pending = new Map<string, Promise<Waveform>>();
let active = 0;
const waiting: (() => void)[] = [];

function probe(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(ffprobeInstaller.path, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", url], { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { process.kill(); reject(new Error("Audio probe timed out")); }, 30_000);
    process.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    process.stderr.resume();
    process.on("error", (error) => { clearTimeout(timer); reject(error); });
    process.on("close", (code) => {
      clearTimeout(timer);
      const duration = Number(output.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) reject(new Error("Could not read audio duration"));
      else resolve(duration);
    });
  });
}

export function generateWaveform(key: string, url: string): Promise<Waveform> {
  const existing = pending.get(key);
  if (existing) return existing;
  const job = (async () => {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
    const duration = await probe(url);
    const peaks = Array<number>(1000).fill(0);
    const rate = 8000;
    const samplesPerPeak = duration * rate / peaks.length;
    await new Promise<void>((resolve, reject) => {
      const process = spawn(ffmpegInstaller.path, ["-v", "error", "-i", url, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"], { windowsHide: true });
      let remainder: Buffer = Buffer.alloc(0);
      let sample = 0;
      const timer = setTimeout(() => { process.kill(); reject(new Error("Waveform generation timed out")); }, 120_000);
      process.stdout.on("data", (chunk: Buffer) => {
        const data = Buffer.concat([remainder, chunk]);
        const length = data.length - data.length % 4;
        for (let offset = 0; offset < length; offset += 4, sample++) {
          const index = Math.min(peaks.length - 1, Math.floor(sample / samplesPerPeak));
          const value = Math.abs(data.readFloatLE(offset));
          if (Number.isFinite(value)) peaks[index] = Math.max(peaks[index], Math.min(1, value));
        }
        remainder = data.subarray(length);
      });
      process.stderr.resume();
      process.on("error", (error) => { clearTimeout(timer); reject(error); });
      process.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || sample === 0) reject(new Error("Could not generate this audio waveform"));
        else resolve();
      });
    });
    const max = Math.max(...peaks);
    return { duration, peaks: peaks.map((peak) => max ? peak / max : 0) };
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  })();
  // Keep recent waveforms and share generation across concurrent requests.
  if (pending.size >= 20) pending.delete(pending.keys().next().value!);
  pending.set(key, job);
  void job.catch(() => { if (pending.get(key) === job) pending.delete(key); });
  return job;
}
