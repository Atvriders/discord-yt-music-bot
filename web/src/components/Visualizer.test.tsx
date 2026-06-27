// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Visualizer } from "./Visualizer.js";

afterEach(() => cleanup());

describe("Visualizer (decorative synthetic equalizer)", () => {
  it("renders bars and marks itself decorative / aria-hidden", () => {
    const { getByTestId, container } = render(<Visualizer playing={true} />);
    const viz = getByTestId("visualizer");
    expect(viz.getAttribute("aria-hidden")).toBe("true");
    // It is presentational, not exposed to assistive tech as content.
    expect(viz.getAttribute("role")).toBe("presentation");
    expect(container.querySelectorAll(".viz-bar").length).toBeGreaterThan(0);
  });

  it("reflects the playing state via the viz-on class + data attribute", () => {
    const { getByTestId } = render(<Visualizer playing={true} />);
    const viz = getByTestId("visualizer");
    expect(viz.classList.contains("viz-on")).toBe(true);
    expect(viz.getAttribute("data-playing")).toBe("true");
  });

  it("flattens/freezes (no viz-on) when not playing", () => {
    const { getByTestId } = render(<Visualizer playing={false} />);
    const viz = getByTestId("visualizer");
    expect(viz.classList.contains("viz-on")).toBe(false);
    expect(viz.getAttribute("data-playing")).toBe("false");
  });
});
