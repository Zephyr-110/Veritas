import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BALANCE_VISIBILITY_KEY,
  maskAmount,
  resetBalanceVisibilityForTests,
  useBalanceVisibility,
} from "./use-balance-visibility";

function Probe({ id }: { id: string }) {
  const { hidden, toggle } = useBalanceVisibility();
  return (
    <div>
      <span data-testid={`val-${id}`}>{maskAmount("42.50", hidden, "USDT")}</span>
      <button type="button" data-testid={`btn-${id}`} onClick={toggle}>
        {hidden ? "show" : "hide"}
      </button>
    </div>
  );
}

describe("useBalanceVisibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBalanceVisibilityForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles across mounted consumers and persists choice in localStorage", async () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>
    );

    expect(screen.getByTestId("val-a")).toHaveTextContent("42.50 USDT");
    expect(screen.getByTestId("val-b")).toHaveTextContent("42.50 USDT");

    await userEvent.click(screen.getByTestId("btn-a"));

    expect(screen.getByTestId("val-a")).toHaveTextContent("•••• USDT");
    expect(screen.getByTestId("val-b")).toHaveTextContent("•••• USDT");
    expect(window.localStorage.getItem(BALANCE_VISIBILITY_KEY)).toBe("1");

    // Simulate reload: reset in-memory state and re-mount
    cleanup();
    resetBalanceVisibilityForTests();
    render(<Probe id="c" />);
    expect(screen.getByTestId("val-c")).toHaveTextContent("•••• USDT");
  });
});
