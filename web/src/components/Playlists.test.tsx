// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { Playlists } from "./Playlists.js";
import type { PlaylistSummary } from "../types.js";

afterEach(() => cleanup());

const pl = (name: string, trackCount = 1): PlaylistSummary => ({
  name,
  trackCount,
  savedAt: 1000,
});

describe("Playlists", () => {
  it("shows an empty state with no saved playlists", () => {
    render(
      <Playlists playlists={[]} onSave={vi.fn()} onLoad={vi.fn()} onDelete={vi.fn()} />,
    );
    // getByText throws when the text is absent, so the query is itself the assertion.
    screen.getByText(/no saved playlists/i);
  });

  it("saves the current queue under the typed (trimmed) name and clears the input", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <Playlists playlists={[]} onSave={onSave} onLoad={vi.fn()} onDelete={vi.fn()} />,
    );
    const input = screen.getByLabelText(/playlist name/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  road trip  " } });
    fireEvent.click(screen.getByRole("button", { name: /save current/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("road trip"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("disables Save current when the name is blank", () => {
    const onSave = vi.fn();
    render(
      <Playlists playlists={[]} onSave={onSave} onLoad={vi.fn()} onDelete={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /save current/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("lists saved playlists with their track counts and Load/Delete actions", () => {
    const onLoad = vi.fn();
    const onDelete = vi.fn();
    render(
      <Playlists
        playlists={[pl("chill", 3), pl("solo", 1)]}
        onSave={vi.fn()}
        onLoad={onLoad}
        onDelete={onDelete}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // within(...).getByText throws when absent, so each query is itself the assertion.
    within(rows[0]!).getByText("chill");
    within(rows[0]!).getByText(/3 tracks/i);
    within(rows[1]!).getByText(/1 track\b/i);

    fireEvent.click(within(rows[0]!).getByRole("button", { name: /load chill/i }));
    expect(onLoad).toHaveBeenCalledWith("chill");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /delete solo/i }));
    expect(onDelete).toHaveBeenCalledWith("solo");
  });

  it("disables Load/Delete when disabled (no access)", () => {
    const onLoad = vi.fn();
    const onDelete = vi.fn();
    render(
      <Playlists
        playlists={[pl("chill", 3)]}
        onSave={vi.fn()}
        onLoad={onLoad}
        onDelete={onDelete}
        disabled
      />,
    );
    const loadBtn = screen.getByRole("button", { name: /load chill/i }) as HTMLButtonElement;
    expect(loadBtn.disabled).toBe(true);
    fireEvent.click(loadBtn);
    expect(onLoad).not.toHaveBeenCalled();
    // The Delete button is also gated by `disabled` — verify it matches the test title.
    const deleteBtn = screen.getByRole("button", { name: /delete chill/i }) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
    fireEvent.click(deleteBtn);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("guards against duplicate in-flight Delete calls (per-row busy lock)", async () => {
    // A slow Delete: the row must lock while it is in flight so a second rapid click
    // can't fire a duplicate DELETE (which would 404 and desync the list).
    let resolveDelete!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((r) => { resolveDelete = r; }));
    render(
      <Playlists playlists={[pl("chill", 3)]} onSave={vi.fn()} onLoad={vi.fn()} onDelete={onDelete} />,
    );
    const deleteBtn = screen.getByRole("button", { name: /delete chill/i }) as HTMLButtonElement;
    fireEvent.click(deleteBtn);
    // The row is now locked: the button disables and a second click is a no-op.
    await waitFor(() => expect(deleteBtn.disabled).toBe(true));
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledTimes(1);
    // Resolving releases the lock and re-enables the control.
    resolveDelete();
    await waitFor(() => expect(deleteBtn.disabled).toBe(false));
  });

  it("guards against duplicate in-flight Load calls (per-row busy lock)", async () => {
    let resolveLoad!: () => void;
    const onLoad = vi.fn(() => new Promise<void>((r) => { resolveLoad = r; }));
    render(
      <Playlists playlists={[pl("chill", 3)]} onSave={vi.fn()} onLoad={onLoad} onDelete={vi.fn()} />,
    );
    const loadBtn = screen.getByRole("button", { name: /load chill/i }) as HTMLButtonElement;
    fireEvent.click(loadBtn);
    await waitFor(() => expect(loadBtn.disabled).toBe(true));
    fireEvent.click(loadBtn);
    expect(onLoad).toHaveBeenCalledTimes(1);
    resolveLoad();
    await waitFor(() => expect(loadBtn.disabled).toBe(false));
  });

  it("keeps the typed name and re-enables Save when onSave rejects", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("network"));
    render(
      <Playlists playlists={[]} onSave={onSave} onLoad={vi.fn()} onDelete={vi.fn()} />,
    );
    const input = screen.getByLabelText(/playlist name/i) as HTMLInputElement;
    const btn = screen.getByRole("button", { name: /save current/i }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "trip" } });
    fireEvent.click(btn);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("trip"));
    // Busy clears (Save re-enables) and the typed name is NOT wiped on failure.
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(input.value).toBe("trip");
  });
});
