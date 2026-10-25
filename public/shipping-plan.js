(() => {
  const root = document.querySelector("[data-ww-shipping-plan]");
  if (!root) return;
  let token = location.hash.slice(1);
  const params = new URLSearchParams(location.search), setup = /^cs_[A-Za-z0-9_]+$/.test(params.get("setup") || "") ? params.get("setup") : "";
  if (location.hash || location.search) history.replaceState(null, "", "/shipping-plan/");
  let busy = false;
  const node = (tag, text = "", props = {}) => {
    const element = document.createElement(tag); element.textContent = text;
    for (const [key, value] of Object.entries(props)) if (key.startsWith("on")) element.addEventListener(key.slice(2), value); else element.setAttribute(key, value);
    return element;
  };
  const button = (text, action, props = {}) => node("button", text, { type: "button", onclick: action, ...props });
  const status = (text, error = false) => node("p", text, { role: error ? "alert" : "status" });
  const heading = (text = "Shipping plan") => node("h1", text);
  const money = (amount, currency) => {
    const format = new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" });
    return format.format(amount / 10 ** format.resolvedOptions().maximumFractionDigits);
  };
  const date = value => value ? new Date(value).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
  const safeLink = value => { try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; } };
  async function api(action, body = null, search = "") {
    const response = await fetch("/api/shipping-plan/" + action + search, { method: body ? "POST" : "GET", credentials: "same-origin", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "Unable to open your shipping plan."), { status: response.status });
    return data;
  }
  // The cart reads this to say a member's order will ship with their plan.
  function remember(data) {
    try {
      if (data.signedIn && data.member?.status === "active" && data.plan) localStorage.setItem("ww-shipping-plan", JSON.stringify({ name: data.plan.name }));
      else localStorage.removeItem("ww-shipping-plan");
    } catch { /* storage may be unavailable */ }
  }
  async function withBusy(control, work) {
    if (busy) return; busy = true; control.disabled = true;
    try { await work(); } finally { busy = false; control.disabled = false; }
  }

  function emailForm(data, message = "", error = false) {
    const joinable = data?.joinable || [];
    const form = node("form"), label = node("label", "Email address"), email = node("input", "", { type: "email", name: "email", autocomplete: "email", required: "", maxlength: "254" });
    label.append(email);
    form.append(label);
    let choice = null;
    if (joinable.length) {
      const fieldset = node("fieldset"); fieldset.append(node("legend", "Plan"));
      const options = [{ id: "", name: "I'm already on a plan", text: "We'll email you a link to open it." },
        ...joinable.map(plan => ({ id: plan.id, name: plan.name, text: plan.terms.map(term => term.text).join(" Or: ") }))];
      for (const [index, option] of options.entries()) {
        const row = node("label", "", { class: "ww-ship-option" }), radio = node("input", "", { type: "radio", name: "plan", value: option.id });
        if (index === 0) radio.checked = true;
        const text = node("span"); text.append(node("strong", option.name), node("small", option.text));
        row.append(radio, text); fieldset.append(row);
      }
      form.append(fieldset);
      choice = () => form.querySelector("input[name=plan]:checked")?.value || "";
    }
    const submit = node("button", "Email me a link", { type: "submit" });
    form.append(submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      withBusy(submit, async () => {
        const feedback = status("Sending..."); form.append(feedback);
        try { feedback.textContent = (await api("request", { email: email.value, ...(choice?.() ? { planId: choice() } : {}) })).message; }
        catch (failure) { feedback.setAttribute("role", "alert"); feedback.textContent = failure.message; }
      });
    });
    const intro = joinable.length
      ? "Combine your orders into fewer shipments. Enter your email and we'll send a secure link."
      : "Shipping plans here are by invitation. If you are on one, enter your email and we'll send a secure link.";
    root.replaceChildren(heading(), ...(message ? [status(message, error)] : []), node("p", intro), form);
  }

  function joinView(data) {
    const { plan, member } = data, form = node("form");
    const fieldset = node("fieldset"); fieldset.append(node("legend", "How often should your orders ship?"));
    for (const term of plan.terms) {
      const row = node("label", "", { class: "ww-ship-option" }), radio = node("input", "", { type: "radio", name: "cadence", value: term.cadence, required: "" });
      if (term.cadence === member.cadence || plan.terms.length === 1) radio.checked = true;
      const text = node("span"); text.append(node("strong", term.label), node("small", term.text));
      row.append(radio, text); fieldset.append(row);
    }
    const agree = node("input", "", { type: "checkbox", name: "agree", required: "" }), agreeLabel = node("label", "", { class: "ww-ship-agree" });
    agreeLabel.append(agree, node("span", "I agree to these shipping terms."));
    const needsCard = plan.collect === "card" && !member.card;
    const submit = node("button", needsCard ? "Agree and add a card" : "Join plan", { type: "submit" });
    form.append(fieldset, agreeLabel, ...(needsCard ? [node("p", "You'll add a card on Stripe's secure page. Nothing is charged until a shipment goes out.")] : []), submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      withBusy(submit, async () => {
        try {
          const result = await api("accept", { agree: agree.checked, cadence: form.querySelector("input[name=cadence]:checked")?.value || "" });
          const next = result.checkoutUrl && safeLink(result.checkoutUrl);
          if (next) location.assign(next); else await load();
        } catch (failure) { form.append(status(failure.message, true)); }
      });
    });
    root.replaceChildren(heading(plan.name), node("p", `${data.siteName || "This shop"} invited ${member.email} to combine orders into fewer shipments.`), form, signOut());
  }

  function memberView(data) {
    const { plan, member } = data, term = plan.terms.find(entry => entry.cadence === member.cadence) || plan.terms[0];
    const facts = node("dl", "", { class: "ww-ship-facts" });
    const fact = (label, value) => { if (value) facts.append(node("dt", label), node("dd", value)); };
    fact("Ships", term?.label);
    fact("Next shipment", member.nextShipAt ? "Around " + date(member.nextShipAt) : "");
    fact("Card", member.card ? `${member.card.brand} ending ${member.card.last4}` : "");
    const parts = [heading(plan.name), node("p", term?.text || ""), facts];
    if (plan.collect === "card") {
      const update = button(member.card ? "Update card" : "Add a card", () => withBusy(update, async () => {
        try { const next = safeLink((await api("card", {})).checkoutUrl); if (next) location.assign(next); }
        catch (failure) { update.after(status(failure.message, true)); }
      }));
      parts.push(update);
    }
    parts.push(node("p", "Orders you place on this site while signed in ship with your plan instead of paying shipping at checkout.", { class: "ww-ship-note" }));
    const waiting = data.waiting || [];
    parts.push(node("h2", "Waiting to ship"));
    if (waiting.length) {
      const list = node("ul", "", { class: "ww-ship-list" });
      for (const order of waiting) for (const line of order.lines) {
        const item = node("li", `${line.remaining} × ${[line.title, line.variantLabel].filter(Boolean).join(" - ")}`);
        if (line.stage === "in_progress") item.append(node("small", "In the shop · goes in your next box"));
        else if (line.stage === "on_hold") item.append(node("small", line.releaseAt ? `Ordered from the distributor · release ${date(line.releaseAt)}` : "Ordered from the distributor"));
        else if (line.waiting) item.append(node("small", line.releaseAt ? `Not out yet · release ${date(line.releaseAt)}` : "Not out yet"));
        list.append(item);
      }
      parts.push(list);
    } else parts.push(node("p", "Nothing is waiting right now."));
    if (data.shipments?.length) {
      parts.push(node("h2", "Recent shipments"));
      const list = node("ul", "", { class: "ww-ship-list" });
      const feeText = { none: "Free shipping", charged: "charged to your card", paid: "paid", invoiced: "invoice emailed", pending: "processing", failed: "payment failed - the shop will be in touch", recorded: "billed by the shop", waived: "waived" };
      for (const shipment of data.shipments) {
        const fee = shipment.feeStatus === "none" ? feeText.none : `${money(shipment.feeAmount, shipment.currency)} shipping, ${feeText[shipment.feeStatus] || shipment.feeStatus}`;
        const item = node("li", `${date(shipment.shippedAt)}: ${shipment.itemCount} item${shipment.itemCount === 1 ? "" : "s"} · ${fee}`);
        if (shipment.tracking) item.append(node("small", "Tracking: " + shipment.tracking));
        const invoice = shipment.invoiceUrl && safeLink(shipment.invoiceUrl);
        if (invoice) item.append(node("a", "Pay invoice", { href: invoice, rel: "noopener noreferrer", target: "_blank" }));
        list.append(item);
      }
      parts.push(list);
    }
    parts.push(node("p", `To change or leave your plan, contact ${data.siteName || "the shop"}.`), signOut());
    root.replaceChildren(...parts);
  }

  function signOut() {
    const control = button("Sign out", () => withBusy(control, async () => {
      try { await api("logout", {}); remember({}); await load(); } catch (failure) { root.append(status(failure.message, true)); }
    }), { class: "ww-ship-signout" });
    return control;
  }

  async function load(search = "") {
    root.replaceChildren(heading(), status("Loading..."));
    try {
      const data = await api("status", null, search);
      remember(data);
      if (!data.signedIn) return emailForm(data);
      if (!data.plan) return root.replaceChildren(heading(), status(`This shipping plan is no longer offered. Contact ${data.siteName || "the shop"}.`), signOut());
      if (data.member.status === "invited") return joinView(data);
      memberView(data);
    } catch (error) { root.replaceChildren(heading(), status(error.message, true), button("Retry", () => load())); }
  }

  if (token) {
    const continueButton = button("Open my shipping plan", () => withBusy(continueButton, async () => {
      try { await api("redeem", { token }); token = ""; await load(); }
      catch (error) { token = ""; emailForm(null, error.message, true); }
    }));
    root.replaceChildren(heading(), continueButton);
  } else load(setup ? "?setup=" + encodeURIComponent(setup) : "");
})();
