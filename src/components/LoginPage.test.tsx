import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LoginPage } from "./LoginPage";
import { render, flush } from "../testing/render";

vi.mock("../api/client", () => ({
  login: vi.fn(),
}));

import { login } from "../api/client";

const loginMock = vi.mocked(login);

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitForm() {
  const form = document.querySelector("form") as HTMLFormElement;
  return act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
}

describe("LoginPage", () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders username and password inputs", () => {
    render(<LoginPage onSuccess={() => {}} />);
    expect(document.querySelector("#login-username")).toBeTruthy();
    expect(document.querySelector("#login-password")).toBeTruthy();
  });

  it("submits credentials and calls onSuccess when login succeeds", async () => {
    loginMock.mockResolvedValue({ ok: true, user: "admin" });
    const onSuccess = vi.fn();
    render(<LoginPage onSuccess={onSuccess} />);

    typeInto(document.querySelector("#login-username") as HTMLInputElement, "admin");
    typeInto(document.querySelector("#login-password") as HTMLInputElement, "secret");
    await submitForm();

    expect(loginMock).toHaveBeenCalledWith("admin", "secret");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows the server error message when login fails", async () => {
    loginMock.mockRejectedValue(new Error("Invalid credentials"));
    const onSuccess = vi.fn();
    render(<LoginPage onSuccess={onSuccess} />);

    typeInto(document.querySelector("#login-username") as HTMLInputElement, "admin");
    typeInto(document.querySelector("#login-password") as HTMLInputElement, "wrong");
    await submitForm();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Invalid credentials");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("keeps the controlled inputs in sync on change", () => {
    render(<LoginPage onSuccess={() => {}} />);
    typeInto(document.querySelector("#login-username") as HTMLInputElement, "admin");
    typeInto(document.querySelector("#login-password") as HTMLInputElement, "secret");
    expect((document.querySelector("#login-username") as HTMLInputElement).value).toBe("admin");
    expect((document.querySelector("#login-password") as HTMLInputElement).value).toBe("secret");
  });
});
