(() => {
  const api = "/apps/loyalty";
  document.querySelectorAll("[data-loyalty-block]").forEach((block) => {
    if (
      block.dataset.loyaltyInitialized ||
      !block.querySelector("[data-loyalty-status]")
    )
      return;
    block.dataset.loyaltyInitialized = "true";
    const find = (name) => block.querySelector(`[data-loyalty-${name}]`);
    const status = (message) => {
      find("status").textContent = message;
    };
    const post = async (values) => {
      const form = new FormData();
      Object.entries(values).forEach(([key, value]) =>
        form.set(key, String(value)),
      );
      const response = await fetch(api, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Loyalty request failed");
      return result;
    };
    let signupToken = "";
    let termsVersion = "";
    const load = async () => {
      const balanceResponse = await fetch(api, { credentials: "same-origin" });
      const balance = await balanceResponse.json();
      if (!balance.linked) {
        const contextResponse = await fetch(api + "?view=signup", {
          credentials: "same-origin",
        });
        const context = await contextResponse.json();
        if (!contextResponse.ok)
          throw new Error(context.error || "Loyalty signup is unavailable");
        termsVersion = context.termsVersion;
        find("terms").href = context.termsUrl || "#";
        find("privacy").href = context.privacyUrl || "#";
        find("signup-send").querySelector("button").disabled =
          !context.termsUrl || !context.privacyUrl;
        find("link").hidden = false;
        status("Link your account to see your points.");
        return;
      }
      find("link").hidden = true;
      const available = balance.balance?.currentPoints ?? 0;
      status(balance.balance?.showStorefrontBalance
        ? `${available} points available`
        : "Your loyalty account is connected. Use points at checkout.");
    };
    find("signup-send").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const result = await post({
          intent: "signup-send",
          ...Object.fromEntries(new FormData(event.target)),
        });
        find("signup-verify").dataset.challengeId = result.challengeId;
        find("signup-verify").hidden = false;
        status("Enter the verification code sent to your phone.");
      } catch (error) {
        status(error.message);
      } finally {
        button.disabled = false;
      }
    });
    find("signup-resend").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const result = await post({
          intent: "signup-resend",
          challengeId: find("signup-verify").dataset.challengeId,
        });
        find("signup-verify").dataset.challengeId = result.challengeId;
        status("A new phone verification code was sent.");
      } catch (error) {
        status(error.message);
      } finally {
        event.target.disabled = false;
      }
    });
    find("signup-verify").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const result = await post({
          intent: "signup-verify",
          challengeId: event.target.dataset.challengeId,
          otp: new FormData(event.target).get("otp"),
        });
        signupToken = result.signupVerificationToken;
        find("signup-verify").hidden = true;
        find("signup-complete").hidden = false;
        status("Add your name and review the loyalty terms.");
      } catch (error) {
        status(error.message);
      } finally {
        button.disabled = false;
      }
    });
    find("signup-complete").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        await post({
          intent: "signup-complete",
          signupVerificationToken: signupToken,
          termsVersion,
          ...Object.fromEntries(new FormData(event.target)),
        });
        signupToken = "";
        find("signup-complete").hidden = true;
        event.target.reset();
        await load();
      } catch (error) {
        status(error.message);
      } finally {
        button.disabled = false;
      }
    });
    find("send").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const result = await post({
          intent: "send-otp",
          ...Object.fromEntries(new FormData(event.target)),
        });
        find("verify").dataset.challengeId = result.challengeId;
        find("verify").hidden = false;
        status("Enter the code sent to your phone.");
      } catch (error) {
        status(error.message);
      }
    });
    find("verify").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await post({
          intent: "verify-otp",
          challengeId: event.target.dataset.challengeId,
          otp: new FormData(event.target).get("otp"),
        });
        await load();
      } catch (error) {
        status(error.message);
      }
    });
    load().catch((error) => status(error.message));
  });
})();
