import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("never runs more than `max` tasks concurrently", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("returns the task result and releases a slot after a throw", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(sem.run(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it("throws on a non-positive max instead of deadlocking", () => {
    expect(() => new Semaphore(0)).toThrow(/>= 1/);
    expect(() => new Semaphore(-1)).toThrow(/>= 1/);
    expect(() => new Semaphore(1.5)).toThrow(/integer/);
  });
});
