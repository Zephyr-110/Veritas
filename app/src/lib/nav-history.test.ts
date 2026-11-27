import { describe, it, expect, beforeEach } from "vitest";
import { recordNavigation, resetNavHistoryForTests, resolveBackTarget } from "./nav-history";

describe("nav-history true back resolution", () => {
  beforeEach(() => {
    resetNavHistoryForTests();
    Object.defineProperty(document, "referrer", {
      value: "",
      configurable: true,
    });
  });

  it("returns to /me when navigating from /me into a market detail page", () => {
    recordNavigation("/me");
    recordNavigation("/markets/ABC123");
    expect(resolveBackTarget("/markets/ABC123")).toEqual({
      href: "/me",
      labelKey: "market.backToMe",
      canRouterBack: true,
    });
  });

  it("returns to / when navigating from home into a market detail page", () => {
    recordNavigation("/");
    recordNavigation("/markets/ABC123");
    expect(resolveBackTarget("/markets/ABC123")).toEqual({
      href: "/",
      labelKey: "market.backToHome",
      canRouterBack: true,
    });
  });

  it("falls back to /markets when opened directly without in-app history or referrer", () => {
    recordNavigation("/markets/ABC123");
    expect(resolveBackTarget("/markets/ABC123")).toEqual({
      href: "/markets",
      labelKey: "market.back",
      canRouterBack: false,
    });
  });

  it("uses same-origin document.referrer when cold-loaded from /me", () => {
    Object.defineProperty(document, "referrer", {
      value: `${window.location.origin}/me`,
      configurable: true,
    });
    recordNavigation("/markets/ABC123");
    expect(resolveBackTarget("/markets/ABC123")).toEqual({
      href: "/me",
      labelKey: "market.backToMe",
      canRouterBack: false,
    });
  });

  it("ignores external document.referrer and falls back to /markets", () => {
    Object.defineProperty(document, "referrer", {
      value: "https://external.example.com/some-post",
      configurable: true,
    });
    recordNavigation("/markets/ABC123");
    expect(resolveBackTarget("/markets/ABC123")).toEqual({
      href: "/markets",
      labelKey: "market.back",
      canRouterBack: false,
    });
  });
});
