// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Picker } from "./Picker.js";
import type { TrackMeta } from "../types.js";

afterEach(() => cleanup());

const track = (id: string, thumbnailUrl: string | null = null): TrackMeta => ({
  videoId: id,
  title: `Title ${id}`,
  channel: "Chan",
  durationSec: 120,
  isLive: false,
  thumbnailUrl,
});

function row(title: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(title, "i") }) as HTMLButtonElement;
}

describe("Picker (multi-select)", () => {
  it("renders the 'Pick the exact track' header and a row per candidate", () => {
    render(<Picker candidates={[track("aaaaaaaaaaa"), track("bbbbbbbbbbb")]} onQueueSelected={vi.fn()} />);
    // getByText throws if absent, so it is itself the assertion.
    screen.getByText(/pick the exact track/i);
    screen.getByText("Title aaaaaaaaaaa");
    screen.getByText("Title bbbbbbbbbbb");
  });

  it("rows are toggle-selectable: aria-pressed flips and a checkmark appears", () => {
    render(<Picker candidates={[track("aaaaaaaaaaa")]} onQueueSelected={vi.fn()} />);
    const r = row("Title aaaaaaaaaaa");
    expect(r.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(r);
    expect(r.getAttribute("aria-pressed")).toBe("true");
    screen.getByTestId("picker-check");
    // toggle off again
    fireEvent.click(r);
    expect(r.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("picker-check")).toBeNull();
  });

  it("hides the queue button when nothing is selected, shows it with a live count when >=1", () => {
    render(<Picker candidates={[track("aaaaaaaaaaa"), track("bbbbbbbbbbb")]} onQueueSelected={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /queue \d+ selected/i })).toBeNull();
    fireEvent.click(row("Title aaaaaaaaaaa"));
    // Accessible name announces the count; visible text shows "(1)".
    screen.getByRole("button", { name: /queue 1 selected/i });
    screen.getByText(/queue selected \(1\)/i);
    fireEvent.click(row("Title bbbbbbbbbbb"));
    screen.getByRole("button", { name: /queue 2 selected/i });
    screen.getByText(/queue selected \(2\)/i);
  });

  it("queues ALL selected candidates IN candidate ORDER (not click order)", async () => {
    const onQueueSelected = vi.fn(async () => true);
    render(
      <Picker
        candidates={[track("aaaaaaaaaaa"), track("bbbbbbbbbbb"), track("ccccccccccc")]}
        onQueueSelected={onQueueSelected}
        onQueued={() => {}}
      />,
    );
    // Select out of order: c, then a.
    fireEvent.click(row("Title ccccccccccc"));
    fireEvent.click(row("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 2 selected/i }));
    // Delivered in candidate display order: a before c.
    expect(onQueueSelected).toHaveBeenCalledTimes(1);
    expect(onQueueSelected).toHaveBeenCalledWith(["aaaaaaaaaaa", "ccccccccccc"]);
    // Let the async teardown settle to avoid act() warnings.
    await waitFor(() => expect(screen.queryByRole("button", { name: /queue \d+ selected/i })).toBeNull());
  });

  it("clears the selection and notifies onQueued after queueing", async () => {
    const onQueued = vi.fn();
    render(
      <Picker candidates={[track("aaaaaaaaaaa")]} onQueueSelected={vi.fn()} onQueued={onQueued} />,
    );
    fireEvent.click(row("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    // Teardown is gated on the (resolved) queue promise, so it lands on the next tick.
    await waitFor(() => expect(onQueued).toHaveBeenCalledTimes(1));
    // Button is gone (selection cleared) and the row is no longer pressed.
    expect(screen.queryByRole("button", { name: /queue \d+ selected/i })).toBeNull();
    expect(row("Title aaaaaaaaaaa").getAttribute("aria-pressed")).toBe("false");
  });

  it("the queue button announces the count to assistive tech (aria-label includes N)", () => {
    render(<Picker candidates={[track("aaaaaaaaaaa")]} onQueueSelected={vi.fn()} />);
    fireEvent.click(row("Title aaaaaaaaaaa"));
    const btn = screen.getByRole("button", { name: /queue 1 selected/i });
    expect(btn.getAttribute("aria-label")).toMatch(/queue 1 selected track\b/i);
  });

  it("renders a thumbnail for a candidate that has one", () => {
    render(<Picker candidates={[track("aaaaaaaaaaa", "http://img/a.jpg")]} onQueueSelected={vi.fn()} />);
    // querySelector legitimately returns null on miss, so keep an explicit assertion.
    expect(document.querySelector('img[src="http://img/a.jpg"]')).not.toBeNull();
  });

  it("keeps the picker open and the selection intact when the queue resolves false (no track queued)", async () => {
    const onQueueSelected = vi.fn(async () => false);
    const onQueued = vi.fn();
    render(
      <Picker candidates={[track("aaaaaaaaaaa")]} onQueueSelected={onQueueSelected} onQueued={onQueued} />,
    );
    fireEvent.click(row("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    await screen.findByRole("button", { name: /queue 1 selected/i });
    // Teardown is gated on success: onQueued NOT called, selection preserved for retry.
    expect(onQueued).not.toHaveBeenCalled();
    expect(row("Title aaaaaaaaaaa").getAttribute("aria-pressed")).toBe("true");
  });

  it("disables the queue button and row toggles WHILE a queue is in flight (re-entrancy guard)", async () => {
    let resolve!: (v: boolean) => void;
    const p = new Promise<boolean>((r) => { resolve = r; });
    const onQueueSelected = vi.fn(() => p);
    render(
      <Picker
        candidates={[track("aaaaaaaaaaa"), track("bbbbbbbbbbb")]}
        onQueueSelected={onQueueSelected}
        onQueued={() => {}}
      />,
    );
    fireEvent.click(row("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    // Mid-flight: the queue button shows the spinner label and the row toggles disable,
    // so no second submit / no selection change can slip through.
    await screen.findByText(/queuing/i);
    expect((row("Title aaaaaaaaaaa")).disabled).toBe(true);
    expect((row("Title bbbbbbbbbbb")).disabled).toBe(true);
    // Resolve → controls re-enable and the selection clears (button gone).
    await act(async () => { resolve(true); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /queue \d+ selected/i })).toBeNull());
    expect((row("Title aaaaaaaaaaa")).disabled).toBe(false);
  });

  it("disables the queue button and row toggles when busy", () => {
    render(
      <Picker candidates={[track("aaaaaaaaaaa")]} onQueueSelected={vi.fn()} busy />,
    );
    // Row toggles are disabled, so clicking can't select anything.
    const r = row("Title aaaaaaaaaaa");
    expect(r.disabled).toBe(true);
    fireEvent.click(r);
    expect(r.getAttribute("aria-pressed")).toBe("false");
  });
});
