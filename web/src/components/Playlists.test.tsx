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
    expect(screen.getByText(/no saved playlists/i)).toBeTruthy();
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
    expect(within(rows[0]!).getByText("chill")).toBeTruthy();
    expect(within(rows[0]!).getByText(/3 tracks/i)).toBeTruthy();
    expect(within(rows[1]!).getByText(/1 track\b/i)).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole("button", { name: /load chill/i }));
    expect(onLoad).toHaveBeenCalledWith("chill");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /delete solo/i }));
    expect(onDelete).toHaveBeenCalledWith("solo");
  });

  it("disables Load/Delete when disabled (no access)", () => {
    const onLoad = vi.fn();
    render(
      <Playlists
        playlists={[pl("chill", 3)]}
        onSave={vi.fn()}
        onLoad={onLoad}
        onDelete={vi.fn()}
        disabled
      />,
    );
    const loadBtn = screen.getByRole("button", { name: /load chill/i }) as HTMLButtonElement;
    expect(loadBtn.disabled).toBe(true);
    fireEvent.click(loadBtn);
    expect(onLoad).not.toHaveBeenCalled();
  });
});
