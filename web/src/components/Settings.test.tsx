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
  function crossfadeToggle(): HTMLInputElement {
    return screen.getByLabelText(/^crossfade$/i) as HTMLInputElement;
  }
  function crossfadeSlider(): HTMLInputElement {
    return screen.getByLabelText(/crossfade seconds/i) as HTMLInputElement;
  }

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
    // crossfadeSec > 0 => toggle ON and the slider reflects the value.
    expect(crossfadeToggle().checked).toBe(true);
    expect(crossfadeSlider().value).toBe("4");
    expect((screen.getByLabelText(/normalize loudness/i) as HTMLInputElement).checked).toBe(true);
  });

  it("defaults audio controls to off when props are omitted", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect((screen.getByLabelText(/repeat mode/i) as HTMLSelectElement).value).toBe("off");
    // crossfade OFF => toggle unchecked and the time slider is hidden.
    expect(crossfadeToggle().checked).toBe(false);
    expect(screen.queryByLabelText(/crossfade seconds/i)).toBeNull();
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

  it("toggling crossfade ON posts the default duration (4s); OFF posts 0", () => {
    const onAudioChange = vi.fn();
    // Starts OFF (crossfadeSec omitted => 0): the slider is hidden.
    const { rerender } = render(
      <Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    fireEvent.click(crossfadeToggle());
    expect(onAudioChange).toHaveBeenCalledWith({ crossfadeSec: 4 });

    // Now ON at 4s: toggling off persists 0.
    rerender(
      <Settings idleTimeoutSec={300} crossfadeSec={4} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    fireEvent.click(crossfadeToggle());
    expect(onAudioChange).toHaveBeenCalledWith({ crossfadeSec: 0 });
  });

  it("restores an externally-set crossfade duration on off→on (tracks WS prop, not the stale default)", () => {
    const onAudioChange = vi.fn();
    // Mounts OFF (crossfadeSec omitted => 0), so lastCrossfadeSec seeds to the default (4).
    const { rerender } = render(
      <Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    // A WS snapshot arrives where another client turned crossfade ON at 8s.
    rerender(
      <Settings idleTimeoutSec={300} crossfadeSec={8} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    expect(crossfadeToggle().checked).toBe(true);
    // The user toggles it OFF...
    fireEvent.click(crossfadeToggle());
    expect(onAudioChange).toHaveBeenLastCalledWith({ crossfadeSec: 0 });
    rerender(
      <Settings idleTimeoutSec={300} crossfadeSec={0} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    // ...then back ON: it must restore 8 (the other client's value), not the stale 4.
    fireEvent.click(crossfadeToggle());
    expect(onAudioChange).toHaveBeenLastCalledWith({ crossfadeSec: 8 });
  });

  it("the crossfade time slider (shown only when on) posts the chosen seconds", () => {
    const onAudioChange = vi.fn();
    render(
      <Settings idleTimeoutSec={300} crossfadeSec={4} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    const slider = crossfadeSlider();
    expect(slider.getAttribute("type")).toBe("range");
    expect(slider.getAttribute("min")).toBe("1");
    expect(slider.getAttribute("max")).toBe("12");
    fireEvent.change(slider, { target: { value: "6" } });
    expect(onAudioChange).toHaveBeenCalledWith({ crossfadeSec: 6 });
  });

  it("posts a normalize patch when the checkbox toggles", () => {
    const onAudioChange = vi.fn();
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />);
    fireEvent.click(screen.getByLabelText(/normalize loudness/i));
    expect(onAudioChange).toHaveBeenCalledWith({ normalizeLoudness: true });
  });

  it("reflects the current autoplay value and posts a patch when toggled", () => {
    const onAudioChange = vi.fn();
    const { rerender } = render(
      <Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    const autoplay = () => screen.getByLabelText(/^autoplay$/i) as HTMLInputElement;
    // Defaults to off when the prop is omitted.
    expect(autoplay().checked).toBe(false);
    fireEvent.click(autoplay());
    expect(onAudioChange).toHaveBeenCalledWith({ autoplay: true });

    rerender(
      <Settings
        idleTimeoutSec={300}
        autoplay={true}
        onChange={() => {}}
        onAudioChange={onAudioChange}
      />,
    );
    expect(autoplay().checked).toBe(true);
  });

  it("shows the Radio/Artist source selector only when autoplay is ON", () => {
    const { rerender } = render(
      <Settings idleTimeoutSec={300} autoplay={false} onChange={() => {}} onAudioChange={() => {}} />,
    );
    // Hidden while autoplay is off.
    expect(screen.queryByLabelText(/autoplay source/i)).toBeNull();

    rerender(
      <Settings idleTimeoutSec={300} autoplay={true} onChange={() => {}} onAudioChange={() => {}} />,
    );
    const source = screen.getByLabelText(/autoplay source/i) as HTMLSelectElement;
    // Defaults to "radio" when the prop is omitted.
    expect(source.value).toBe("radio");
    const values = Array.from(source.options).map((o) => o.value);
    expect(values).toEqual(["radio", "artist"]);
  });

  it("reflects the current autoplaySource and posts a patch when changed", () => {
    const onAudioChange = vi.fn();
    const { rerender } = render(
      <Settings
        idleTimeoutSec={300}
        autoplay={true}
        autoplaySource="artist"
        onChange={() => {}}
        onAudioChange={onAudioChange}
      />,
    );
    const source = () => screen.getByLabelText(/autoplay source/i) as HTMLSelectElement;
    expect(source().value).toBe("artist");

    fireEvent.change(source(), { target: { value: "radio" } });
    expect(onAudioChange).toHaveBeenCalledWith({ autoplaySource: "radio" });

    rerender(
      <Settings
        idleTimeoutSec={300}
        autoplay={true}
        autoplaySource="radio"
        onChange={() => {}}
        onAudioChange={onAudioChange}
      />,
    );
    fireEvent.change(source(), { target: { value: "artist" } });
    expect(onAudioChange).toHaveBeenCalledWith({ autoplaySource: "artist" });
  });

  it("documents the artist source is a best-effort channel/artist search (honesty)", () => {
    render(
      <Settings idleTimeoutSec={300} autoplay={true} onChange={() => {}} onAudioChange={() => {}} />,
    );
    expect(screen.getByText(/best-effort/i)).toBeTruthy();
    expect(screen.getByText(/channel\/artist|artist name/i)).toBeTruthy();
  });

  it("documents that autoplay is YouTube's radio, not a genre classifier (honesty)", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect(screen.getByText(/youtube.*radio|not a genre|related/i)).toBeTruthy();
  });

  it("documents the pseudo-crossfade limitation in the UI (honesty)", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect(screen.getByText(/can't truly overlap|brief dip to silence/i)).toBeTruthy();
  });

  function maxLen(): HTMLSelectElement {
    return screen.getByLabelText(/max track length/i) as HTMLSelectElement;
  }

  it("offers the documented max-track-length presets including a No-limit option (0)", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    const values = Array.from(maxLen().options).map((o) => o.value);
    // 1h, 2h, 3h, 4h, 6h, No limit (0)
    expect(values).toEqual(["3600", "7200", "10800", "14400", "21600", "0"]);
    const opts = maxLen().options;
    const noLimit = Array.from(opts).find((o) => o.value === "0")!;
    expect(noLimit.textContent ?? "").toMatch(/no limit/i);
  });

  it("reflects the current maxTrackDurationSec value", () => {
    render(
      <Settings
        idleTimeoutSec={300}
        maxTrackDurationSec={10800}
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect(maxLen().value).toBe("10800");
  });

  it("reflects 0 (No limit) when maxTrackDurationSec is 0", () => {
    render(
      <Settings
        idleTimeoutSec={300}
        maxTrackDurationSec={0}
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect(maxLen().value).toBe("0");
  });

  it("defaults the max-track-length selector to No limit (0) when the prop is omitted", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect(maxLen().value).toBe("0");
  });

  it("posts a maxTrackDurationSec patch when the user picks a preset", () => {
    const onAudioChange = vi.fn();
    render(
      <Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    fireEvent.change(maxLen(), { target: { value: "14400" } });
    expect(onAudioChange).toHaveBeenCalledWith({ maxTrackDurationSec: 14400 });
    fireEvent.change(maxLen(), { target: { value: "0" } });
    expect(onAudioChange).toHaveBeenCalledWith({ maxTrackDurationSec: 0 });
  });

  it("surfaces a non-preset maxTrackDurationSec as a synthetic option so it isn't blank", () => {
    render(
      <Settings
        idleTimeoutSec={300}
        maxTrackDurationSec={5400}
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect(maxLen().value).toBe("5400");
    const synthetic = Array.from(maxLen().options).find((o) => o.value === "5400");
    expect(synthetic).toBeTruthy();
  });

  function volumeSlider(): HTMLInputElement {
    return screen.getByLabelText(/^volume$/i) as HTMLInputElement;
  }
  function fxSelect(): HTMLSelectElement {
    return screen.getByLabelText(/fx preset/i) as HTMLSelectElement;
  }

  it("renders a 0-200 volume slider defaulting to 100% when the prop is omitted", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    const s = volumeSlider();
    expect(s.getAttribute("type")).toBe("range");
    expect(s.getAttribute("min")).toBe("0");
    expect(s.getAttribute("max")).toBe("200");
    expect(s.value).toBe("100");
  });

  it("reflects the current volume and posts a patch when it changes", () => {
    const onAudioChange = vi.fn();
    render(
      <Settings idleTimeoutSec={300} volume={150} onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    expect(volumeSlider().value).toBe("150");
    fireEvent.change(volumeSlider(), { target: { value: "60" } });
    expect(onAudioChange).toHaveBeenCalledWith({ volume: 60 });
  });

  it("offers every FX preset and defaults to none", () => {
    render(<Settings idleTimeoutSec={300} onChange={() => {}} onAudioChange={() => {}} />);
    expect(fxSelect().value).toBe("none");
    const values = Array.from(fxSelect().options).map((o) => o.value);
    expect(values).toEqual([
      "none",
      "bassboost",
      "nightcore",
      "vaporwave",
      "eightd",
      "treble",
      "karaoke",
    ]);
  });

  it("reflects the current fx and posts a patch when it changes", () => {
    const onAudioChange = vi.fn();
    render(
      <Settings idleTimeoutSec={300} fx="nightcore" onChange={() => {}} onAudioChange={onAudioChange} />,
    );
    expect(fxSelect().value).toBe("nightcore");
    fireEvent.change(fxSelect(), { target: { value: "bassboost" } });
    expect(onAudioChange).toHaveBeenCalledWith({ fx: "bassboost" });
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
    expect((screen.getByLabelText(/^crossfade$/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/normalize loudness/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^autoplay$/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/max track length/i) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^volume$/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/fx preset/i) as HTMLSelectElement).disabled).toBe(true);
  });

  it("disables the conditionally-rendered crossfade slider and autoplay source when disabled", () => {
    // These two controls only mount when crossfade is on / autoplay is on, so the base
    // "disables every control" test never exercised their disabled binding.
    render(
      <Settings
        idleTimeoutSec={300}
        disabled={true}
        crossfadeSec={4}
        autoplay={true}
        onChange={() => {}}
        onAudioChange={() => {}}
      />,
    );
    expect((screen.getByLabelText(/crossfade seconds/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/autoplay source/i) as HTMLSelectElement).disabled).toBe(true);
  });
});
