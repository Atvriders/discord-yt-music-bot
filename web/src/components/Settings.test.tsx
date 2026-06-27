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

  it("BUG 3: renders a synthetic option for a non-preset value so the select isn't blank", () => {
    render(<Settings idleTimeoutSec={120} disabled={false} onChange={() => {}} />);
    const s = select();
    // The current value is reflected (not blank) and labeled as the current value.
    expect(s.value).toBe("120");
    const synthetic = Array.from(s.options).find((o) => o.value === "120");
    expect(synthetic).toBeTruthy();
    expect(synthetic!.textContent ?? "").toMatch(/120s \(current\)/i);
  });

  it("BUG 3: does not add a synthetic option when the value matches a preset", () => {
    render(<Settings idleTimeoutSec={600} disabled={false} onChange={() => {}} />);
    const values = Array.from(select().options).map((o) => o.value);
    expect(values).toEqual(["60", "300", "600", "900", "1800", "3600"]);
  });
});

describe("Settings (audio options)", () => {
  it("reflects the current repeat / crossfade / normalize values", () => {
    render(
      <Settings
        idleTimeoutSec={300}
        crossfadeSec={4}
        normalizeLoudness={true}
        repeat="all"
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect((screen.getByLabelText(/repeat mode/i) as HTMLSelectElement).value).toBe("all");
    expect((screen.getByLabelText(/crossfade seconds/i) as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText(/normalize loudness/i) as HTMLInputElement).checked).toBe(true);
  });

  it("defaults audio controls to off when props are omitted", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect((screen.getByLabelText(/repeat mode/i) as HTMLSelectElement).value).toBe("off");
    expect((screen.getByLabelText(/crossfade seconds/i) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(/normalize loudness/i) as HTMLInputElement).checked).toBe(false);
  });

  it("posts a repeat patch when the repeat mode changes", () => {
    const onAudioChange = vi.fn();
    render(
      <Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    fireEvent.change(screen.getByLabelText(/repeat mode/i), { target: { value: "one" } });
    expect(onAudioChange).toHaveBeenCalledWith({ repeat: "one" });
  });

  it("posts a crossfade patch when the crossfade value changes", () => {
    const onAudioChange = vi.fn();
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />);
    fireEvent.change(screen.getByLabelText(/crossfade seconds/i), { target: { value: "6" } });
    expect(onAudioChange).toHaveBeenCalledWith({ crossfadeSec: 6 });
  });

  it("posts a normalize patch when the checkbox toggles", () => {
    const onAudioChange = vi.fn();
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />);
    fireEvent.click(screen.getByLabelText(/normalize loudness/i));
    expect(onAudioChange).toHaveBeenCalledWith({ normalizeLoudness: true });
  });

  it("documents the pseudo-crossfade limitation in the UI (honesty)", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect(screen.getByText(/can't truly overlap|brief dip to silence/i)).toBeTruthy();
  });

  it("disables every control when the user cannot control the guild", () => {
    render(
      <Settings
        idleTimeoutSec={300}
        disabled={true}
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect((screen.getByLabelText(/repeat mode/i) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/crossfade seconds/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/normalize loudness/i) as HTMLInputElement).disabled).toBe(true);
  });
});
