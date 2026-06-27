// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Settings } from "./Settings.js";

afterEach(() => cleanup());

function select(): HTMLSelectElement {
  return screen.getByLabelText(/leave channel after tracks end/i) as HTMLSelectElement;
}

describe("Settings (idle timeout)", () => {
  it("shows the current idleTimeoutSec from the snapshot", () => {
    render(<Settings idleTimeoutSec={600} disabled={false} onChange={() => {}} />);
    // 600s = 10 minutes
    expect(select().value).toBe("600");
  });

  it("defaults to 5 minutes (300s) when the snapshot value is undefined", () => {
    render(<Settings idleTimeoutSec={undefined} disabled={false} onChange={() => {}} />);
    expect(select().value).toBe("300");
  });

  it("offers the documented presets including a 'Never' option mapped to 3600", () => {
    render(<Settings idleTimeoutSec={300} disabled={false} onChange={() => {}} />);
    const values = Array.from(select().options).map((o) => o.value);
    expect(values).toEqual(["60", "300", "600", "900", "1800", "3600"]);
    // The max value is labeled as a never/stay option.
    const opts = select().options;
    const last = opts[opts.length - 1]!;
    expect(last.value).toBe("3600");
    expect(last.textContent ?? "").toMatch(/never|stay/i);
  });

  it("calls onChange with the new seconds value when the user picks a preset", () => {
    const onChange = vi.fn();
    render(<Settings idleTimeoutSec={300} disabled={false} onChange={onChange} />);
    fireEvent.change(select(), { target: { value: "900" } });
    expect(onChange).toHaveBeenCalledWith(900);
  });

  it("is disabled when the user cannot control the guild", () => {
    render(<Settings idleTimeoutSec={300} disabled={true} onChange={() => {}} />);
    expect(select().disabled).toBe(true);
  });
});
