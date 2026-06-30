// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Preparing } from "./Preparing.js";
import type { PreparingState } from "../types.js";

afterEach(() => cleanup());

const dl = (percent?: number): PreparingState => ({
  videoId: "aaaaaaaaaaa",
  title: "Epic 2.5h Mix",
  phase: "downloading",
  percent,
});

describe("Preparing", () => {
  it("renders nothing when preparing is null", () => {
    const { container } = render(<Preparing preparing={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a live downloading status with the title and percent", () => {
    render(<Preparing preparing={dl(45)} />);
    expect(screen.getByText(/Downloading/i)).toBeTruthy();
    expect(screen.getByText(/Epic 2.5h Mix/)).toBeTruthy();
    // The mono percent counter reads 45%.
    expect(screen.getByText(/45%/)).toBeTruthy();
  });

  it("renders a progress bar whose fill width tracks the percent", () => {
    render(<Preparing preparing={dl(45)} />);
    const fill = screen.getByTestId("preparing-fill") as HTMLElement;
    expect(fill.style.width).toBe("45%");
  });

  it("clamps the fill width to 0–100", () => {
    render(<Preparing preparing={dl(140)} />);
    expect((screen.getByTestId("preparing-fill") as HTMLElement).style.width).toBe("100%");
  });

  it("shows an indeterminate bar (and no % counter) while downloading with unknown percent", () => {
    render(<Preparing preparing={dl(undefined)} />);
    expect(screen.getByText(/Downloading/i)).toBeTruthy();
    // No percent figure yet.
    expect(screen.queryByText(/%/)).toBeNull();
    const fill = screen.getByTestId("preparing-fill") as HTMLElement;
    // Indeterminate fill is a fixed partial width (NOT a false 0%/45%).
    expect(fill.style.width).toBe("40%");
    // ...and it pulses so the user reads it as actively working.
    expect(fill.className).toContain("animate-pulse");
    // The progressbar reports no numeric value while indeterminate.
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  });

  it("exposes the progressbar ARIA value-now when a percent is known (clamped)", () => {
    const { rerender } = render(<Preparing preparing={dl(45)} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("45");
    // Over-100 percent clamps to 100 in the reported value too.
    rerender(<Preparing preparing={dl(140)} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("renders a Processing status (no percent bar) for the processing phase", () => {
    render(<Preparing preparing={{ videoId: "x".repeat(11), title: "Track", phase: "processing" }} />);
    expect(screen.getByText(/Processing/i)).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("renders a Resolving status for the resolving phase", () => {
    render(<Preparing preparing={{ videoId: "x".repeat(11), title: "Track", phase: "resolving" }} />);
    expect(screen.getByText(/Resolving/i)).toBeTruthy();
  });

  it("exposes a live status region and a working activity affordance", () => {
    render(<Preparing preparing={dl(45)} />);
    // aria-live so assistive tech announces the active fetch.
    expect(screen.getByRole("status")).toBeTruthy();
    // A pulse/spinner element marks it as ACTIVELY working (vs stopped).
    expect(screen.getByTestId("preparing-activity")).toBeTruthy();
  });
});
