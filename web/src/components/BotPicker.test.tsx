// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BotPicker } from "./BotPicker.js";
import type { Bot } from "../types.js";

afterEach(() => cleanup());

const bot = (id: string, name: string): Bot => ({ id, name, guilds: [{ id: `${id}-g`, name: `${name} room` }] });

describe("BotPicker", () => {
  it("renders nothing when there are no bots", () => {
    const { container } = render(<BotPicker bots={[]} activeBotId={null} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("single bot: shows the name as a quiet label with NO selectable key (no regression)", () => {
    render(<BotPicker bots={[bot("B1", "Solo")]} activeBotId="B1" onSelect={() => {}} />);
    // The name is shown...
    expect(screen.getByText("Solo")).toBeTruthy();
    // ...but there is no interactive bot button to toggle (single-bot === pre-fleet UI).
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("multiple bots: renders one key per bot, marks the active one pressed, and fires onSelect", () => {
    const onSelect = vi.fn();
    render(
      <BotPicker
        bots={[bot("B1", "Alpha"), bot("B2", "Bravo")]}
        activeBotId="B1"
        onSelect={onSelect}
      />,
    );
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    const bravo = screen.getByRole("button", { name: /Bravo/ });
    // aria-pressed reflects which bot is active (accessible + keyboard-visible state).
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    expect(bravo.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bravo);
    expect(onSelect).toHaveBeenCalledWith("B2");
  });

  it("surfaces a playing hint (accessible label + live jewel) for a bot that's on air", () => {
    render(
      <BotPicker
        bots={[bot("B1", "Alpha"), bot("B2", "Bravo")]}
        activeBotId="B1"
        playingBotIds={new Set(["B2"])}
        onSelect={() => {}}
      />,
    );
    // The playing bot's accessible name announces it's playing (even when not selected).
    expect(screen.getByRole("button", { name: /Bravo \(playing\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha \(playing\)/ })).toBeNull();
  });

  it("single bot: shows a compact live label when that one bot is playing", () => {
    render(
      <BotPicker bots={[bot("B1", "Solo")]} activeBotId="B1" playingBotIds={new Set(["B1"])} onSelect={() => {}} />,
    );
    expect(screen.getByLabelText("on air")).toBeTruthy();
  });
});
